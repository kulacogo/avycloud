/**
 * Selbstheilung, wenn nach einer Veröffentlichung ein Programmteil fehlt.
 *
 * Die Anwendung lädt ihre Seiten einzeln nach (React.lazy). Die Dateinamen
 * enthalten eine Prüfsumme, die sich bei jeder Veröffentlichung ändert. Wer die
 * Seite offen hat, während eine neue Fassung erscheint, hält im Speicher noch
 * die ALTEN Dateinamen — die es auf dem Server nicht mehr gibt.
 *
 * Firebase Hosting leitet jede unbekannte Adresse auf `index.html` um. Der
 * Browser bekommt also nicht "nicht gefunden", sondern HTML mit Status 200 —
 * und weil firebase.json für alle .js-Adressen den Inhaltstyp auf JavaScript
 * festschreibt, versucht der Browser dieses HTML als Programm zu lesen und
 * scheitert am ersten Zeichen: `Unexpected token '<'`.
 *
 * Genau diese Meldung sah der Betreiber am 17.08.2026 auf `#/orders`, sporadisch
 * — nämlich an einem Tag mit sechs Veröffentlichungen in 25 Minuten.
 *
 * Der Fehler ist selbstheilbar: Neuladen holt die neue `index.html` mit den
 * neuen Dateinamen.
 *
 * ─── Zwei Fallen, beide belegt und beide hier vermieden ───
 *
 * 1) FALSCH-POSITIV. V8 meldet `JSON.parse("<!doctype html>")` wortwörtlich als
 *    `Unexpected token '<', "<!doctype html>" is not valid JSON`. Eine
 *    Backend-Störung (Cloud Run liefert eine HTML-Fehlerseite) trägt also
 *    denselben Wortlaut wie unser Fall. Ein schlichter Textvergleich würde die
 *    Seite bei jeder Backend-Störung neu laden und dabei "Neue Version
 *    verfügbar" behaupten. Deshalb zwei Schärfegrade — und der JSON-Zusatz
 *    schließt aus.
 *
 * 2) SCHEINBARER SCHLEIFENSCHUTZ. Ein Zähler, der beim Start zurückgesetzt
 *    wird, ist wertlos: Das Nachladen einer Datei ist immer asynchron, das
 *    Zurücksetzen liefe also stets VOR dem Fehler. Ergebnis:
 *    Start → 0 → Fehler → 1 → neu laden → 0 → Fehler → 1 → … endlos.
 *    Deshalb wird erst zurückgesetzt, wenn die Anwendung nachweislich eine
 *    Weile fehlerfrei gelaufen ist.
 */

/** Wie oft darf sich die Anwendung selbst neu laden, bevor sie aufgibt. */
export const MAX_RELOADS = 2;

/** So lange muss die Anwendung laufen, um als gesund zu gelten. */
export const HEILUNG_MS = 10_000;

/** So lange nach einem Versuch wird der Zähler nicht angerührt. */
export const ABKUEHLUNG_MS = 60_000;

const STORAGE_KEY = "avycloud_chunk_reload_versuche";

/**
 * Unmissverständliche Meldungen: hier kann es nichts anderes sein als ein
 * fehlender oder falsch ausgelieferter Programmteil.
 *
 * Die Browser sprechen jeder für sich:
 *  - Chrome bei echtem 404:  "Failed to fetch dynamically imported module"
 *  - Firefox:                "error loading dynamically imported module"
 *  - Safari:                 "Importing a module script failed"
 *  - Alle bei falschem Typ:  "Expected a JavaScript module script…"
 */
const EINDEUTIGE_MUSTER: RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /expected a javascript(?: module)? script/i,
  /failed to load module script/i,
  /loading chunk \d+ failed/i,
  /'?text\/html'? is not a valid javascript mime type/i,
];

/** Mehrdeutig: derselbe Wortlaut entsteht auch bei JSON.parse auf HTML. */
const MEHRDEUTIGES_MUSTER = /unexpected token '?</i;

/** Der Zusatz, an dem ein JSON-Fehler zu erkennen ist. */
const JSON_ZUSATZ = /is not valid json|json\.parse|json parse error/i;

function meldungVon(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const m = (error as { message?: unknown }).message;
  return typeof m === "string" ? m : "";
}

/**
 * Streng — für die globalen Haken (unbehandelte Zusagen, Ladefehler).
 * Dort landen auch JSON-Fehler aus Klick-Handlern; ein Fehlgriff würde die
 * Seite wegen einer Backend-Störung neu laden.
 */
export function istEindeutigerNachladeFehler(error: unknown): boolean {
  const message = meldungVon(error);
  if (!message) return false;
  return EINDEUTIGE_MUSTER.some((p) => p.test(message));
}

/**
 * Weit — für die Fehlergrenze beim Zeichnen. Dort sind alle JSON-Auswertungen
 * abgesichert, der mehrdeutige Wortlaut kann also nur vom Nachladen kommen.
 * Der JSON-Zusatz bleibt trotzdem ausgeschlossen.
 */
export function istNachladeFehler(error: unknown): boolean {
  const message = meldungVon(error);
  if (!message) return false;
  if (istEindeutigerNachladeFehler(error)) return true;
  if (JSON_ZUSATZ.test(message)) return false;
  return MEHRDEUTIGES_MUSTER.test(message);
}

// ─────────────────────────────────────────────────────────────
// Zustand
// ─────────────────────────────────────────────────────────────

type Speicher = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Stand = { n: number; ts: number };

/**
 * Ein Vorfall darf nur EINMAL zählen — auch wenn zwei Fehlergrenzen ihn fangen
 * oder StrictMode doppelt aufruft. Bewusst im Modul und NICHT im Speicher: Es
 * soll das Neuladen nicht überleben, sonst wäre der zweite Versuch blockiert.
 */
let reloadAngefordert = false;

/** Ist in diesem Seitenleben ein Nachladefehler aufgetreten? */
let fehlerGesehen = false;

/** Nur für Tests: Modulzustand zurücksetzen. */
export function _testZuruecksetzen(): void {
  reloadAngefordert = false;
  fehlerGesehen = false;
}

/** Merkt sich, dass es geknallt hat — verhindert ein späteres Zurücksetzen. */
export function merkeNachladeFehler(): void {
  fehlerGesehen = true;
}

function holeSpeicher(): Speicher | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    // Privater Modus oder gesperrter Speicher — dann lieber gar nicht neu
    // laden, sonst fehlt der Schleifenschutz. Fail-closed.
    return null;
  }
}

function leseStand(speicher: Speicher | null): Stand {
  if (!speicher) return { n: 0, ts: 0 };
  const roh = speicher.getItem(STORAGE_KEY);
  if (!roh) return { n: 0, ts: 0 };
  try {
    const parsed = JSON.parse(roh);
    // Altformat: eine nackte Zahl. JSON.parse liefert dann keine Struktur,
    // und ohne diesen Zweig gilt ein alter Stand faelschlich als null — der
    // Schleifenschutz waere fuer bestehende Tabs wirkungslos.
    if (typeof parsed === "number") {
      return { n: Number.isFinite(parsed) && parsed > 0 ? parsed : 0, ts: 0 };
    }
    const n = Number(parsed?.n);
    const ts = Number(parsed?.ts);
    return {
      n: Number.isFinite(n) && n > 0 ? n : 0,
      ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    };
  } catch {
    // Altformat: schlichte Zahl.
    const n = Number.parseInt(roh, 10);
    return { n: Number.isFinite(n) && n > 0 ? n : 0, ts: 0 };
  }
}

export function zaehleVersuche(speicher: Speicher | null = holeSpeicher()): number {
  if (!speicher) return Number.POSITIVE_INFINITY; // ohne Zähler kein Neuladen
  return leseStand(speicher).n;
}

/**
 * Entscheidet, ob wegen dieses Fehlers neu geladen werden soll — und merkt sich
 * den Versuch.
 *
 * @param streng  In den globalen Haken `true`: dort zählt nur Unmissverständliches.
 */
export function sollNeuLaden(
  error: unknown,
  {
    speicher = holeSpeicher(),
    jetzt = Date.now(),
    streng = false,
  }: { speicher?: Speicher | null; jetzt?: number; streng?: boolean } = {},
): boolean {
  const passt = streng ? istEindeutigerNachladeFehler(error) : istNachladeFehler(error);
  if (!passt) return false;

  fehlerGesehen = true;
  if (reloadAngefordert) return false;

  const stand = leseStand(speicher);
  if (!speicher) return false;
  if (!(stand.n < MAX_RELOADS)) return false;

  try {
    speicher.setItem(STORAGE_KEY, JSON.stringify({ n: stand.n + 1, ts: jetzt }));
  } catch {
    return false;
  }
  reloadAngefordert = true;
  return true;
}

/**
 * Nach dem ersten erfolgreichen Zeichnen aufrufen.
 *
 * Setzt den Zähler NICHT sofort zurück (siehe Falle 2 oben), sondern erst,
 * wenn die Anwendung mindestens HEILUNG_MS läuft und seit dem letzten Versuch
 * ABKUEHLUNG_MS vergangen sind — und in dieser Zeit kein Nachladefehler
 * auftrat. Ein Neulade-Zyklus dauert ein bis drei Sekunden; innerhalb eines
 * Zyklus kann der Zähler damit niemals verschwinden.
 *
 * @param sofort  Nur für den Knopf "Seite neu laden": ein Mensch, der klickt,
 *                kann keine Endlosschleife erzeugen.
 */
export function meldeErfolgreichenStart({
  speicher = holeSpeicher(),
  jetzt = Date.now(),
  setTimeoutFn = typeof setTimeout !== "undefined" ? setTimeout : null,
  sofort = false,
}: {
  speicher?: Speicher | null;
  jetzt?: number;
  setTimeoutFn?: ((fn: () => void, ms: number) => unknown) | null;
  sofort?: boolean;
} = {}): void {
  if (!speicher) return;

  if (sofort) {
    try {
      speicher.removeItem(STORAGE_KEY);
    } catch {
      /* egal */
    }
    return;
  }

  const stand = leseStand(speicher);
  if (stand.n <= 0) return; // nichts offen, kein Timer nötig
  if (!setTimeoutFn) return;

  const seitVersuch = stand.ts > 0 ? jetzt - stand.ts : ABKUEHLUNG_MS;
  const wartezeit = Math.max(HEILUNG_MS, ABKUEHLUNG_MS - seitVersuch);

  setTimeoutFn(() => {
    // Knallte es in der Zwischenzeit doch, bleibt der Zähler stehen — sonst
    // wäre der Schutz wieder wirkungslos.
    if (fehlerGesehen) return;
    try {
      speicher.removeItem(STORAGE_KEY);
    } catch {
      /* egal */
    }
  }, wartezeit);
}

/**
 * Was dem Menschen angezeigt wird, wenn auch das Neuladen nicht geholfen hat.
 * Die rohe Browsermeldung ("Unexpected token '<'") sagt einem Betreiber nichts.
 */
export function nachladeFehlerText(): string {
  return (
    "Es ist eine neue Fassung von avycloud erschienen, die dieser Tab noch nicht "
    + "vollständig geladen hat. Bitte lade die Seite neu. Hilft das nicht, halte "
    + "beim Neuladen die Umschalttaste gedrückt."
  );
}
