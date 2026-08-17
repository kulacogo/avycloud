/**
 * Vorwarnung, wenn eine neue Fassung veröffentlicht wurde.
 *
 * Die Selbstheilung in `chunkReload.ts` greift erst, NACHDEM ein Programmteil
 * gefehlt hat. Dieser Wächter setzt davor an: Er merkt, dass eine neue Fassung
 * online ist, und bietet das Neuladen an — zu einem Zeitpunkt, den der Mensch
 * selbst wählt.
 *
 * Erkennung: Beim Start merkt sich die Anwendung den Namen ihrer eigenen
 * Einstiegsdatei (die Prüfsumme darin ändert sich mit jeder Veröffentlichung).
 * In Abständen wird die Startseite frisch geholt und der dort verlinkte Name
 * verglichen.
 *
 * NIEMALS von hier aus automatisch neu laden: Ein offenes Datenblatt mit
 * ungespeicherten Änderungen ginge ohne Rückfrage verloren. Nur anbieten.
 */

export const PRUEF_INTERVALL_MS = 5 * 60 * 1000;

const EINSTIEGSDATEI_RE = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/;

/** Zieht den Namen der Einstiegsdatei aus einer Adresse oder aus HTML. */
export function leseEinstiegsdatei(text: string | null | undefined): string | null {
  if (!text) return null;
  const treffer = EINSTIEGSDATEI_RE.exec(String(text));
  return treffer ? treffer[1] : null;
}

/**
 * Gibt es eine neue Fassung?
 *
 * Unbekannte Werte bedeuten IMMER "nein": Lieber keine Meldung als eine
 * falsche. Ein Bandwurm-Hinweis, der grundlos erscheint, wird nach dem zweiten
 * Mal ignoriert — und dann auch dann, wenn er stimmt.
 */
export function istNeueFassung(eigene: string | null, geladene: string | null): boolean {
  if (!eigene || !geladene) return false;
  return eigene !== geladene;
}

/**
 * Die eigene Einstiegsdatei — aus dem Dokument, nicht aus `import.meta.url`.
 *
 * `import.meta.url` zeigt auf den Programmteil, in dem dieser Code gelandet
 * ist; welcher das nach dem Buendeln ist, entscheidet das Bauwerkzeug. Das
 * <script type="module">-Element im Dokument ist dagegen immer die echte
 * Einstiegsdatei.
 */
export function eigeneEinstiegsdatei(dokument: Document | null | undefined = typeof document !== "undefined" ? document : null): string | null {
  if (!dokument) return null;
  const skripte = Array.from(dokument.querySelectorAll('script[type="module"][src]'));
  for (const skript of skripte) {
    const name = leseEinstiegsdatei(skript.getAttribute("src"));
    if (name) return name;
  }
  return null;
}

export type WatchOptions = {
  eigeneDatei: string | null;
  holeStartseite?: () => Promise<string>;
  intervallMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  sichtbar?: () => boolean;
};

/**
 * Startet die Überwachung. Ruft `beiNeuerFassung` höchstens einmal auf.
 * Gibt die Abmelde-Funktion zurück.
 */
export function starteVersionsUeberwachung(
  beiNeuerFassung: () => void,
  {
    eigeneDatei,
    holeStartseite = () => fetch('/', { cache: 'no-store' }).then((r) => r.text()),
    intervallMs = PRUEF_INTERVALL_MS,
    setIntervalFn = typeof setInterval !== 'undefined' ? (setInterval as any) : null,
    clearIntervalFn = typeof clearInterval !== 'undefined' ? (clearInterval as any) : null,
    sichtbar = () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'),
  }: WatchOptions,
): () => void {
  // Ohne bekannten Ausgangswert gibt es nichts zu vergleichen (z. B. im
  // Entwicklungsserver, wo es keine Prüfsummen gibt).
  if (!eigeneDatei || !setIntervalFn) return () => {};

  let gemeldet = false;
  const pruefe = async () => {
    if (gemeldet || !sichtbar()) return;
    try {
      const html = await holeStartseite();
      const geladene = leseEinstiegsdatei(html);
      if (istNeueFassung(eigeneDatei, geladene)) {
        gemeldet = true;
        beiNeuerFassung();
      }
    } catch {
      // Netz weg, Kante zickt — schweigen. Der Wächter ist Beiwerk.
    }
  };

  const handle = setIntervalFn(() => { void pruefe(); }, intervallMs);
  return () => {
    if (clearIntervalFn) clearIntervalFn(handle);
  };
}
