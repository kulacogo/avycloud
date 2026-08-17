import test from "node:test";
import assert from "node:assert/strict";

import {
  istNachladeFehler,
  istEindeutigerNachladeFehler,
  sollNeuLaden,
  zaehleVersuche,
  meldeErfolgreichenStart,
  merkeNachladeFehler,
  _testZuruecksetzen,
  nachladeFehlerText,
  MAX_RELOADS,
  HEILUNG_MS,
  ABKUEHLUNG_MS,
} from "./chunkReload.ts";

/** Kleiner Ersatz fuer sessionStorage. */
function fakeSpeicher(start: Record<string, string> = {}) {
  const daten = new Map(Object.entries(start));
  return {
    getItem: (k: string) => daten.get(k) ?? null,
    setItem: (k: string, v: string) => { daten.set(k, v); },
    removeItem: (k: string) => { daten.delete(k); },
    _daten: daten,
  };
}

/** Vor jedem Test das Modul-Flag zuruecksetzen (sonst faerbt ein Test den naechsten). */
function frisch() {
  _testZuruecksetzen();
  return fakeSpeicher();
}

// ─────────────────────────────────────────────────────────────
// Erkennung
// ─────────────────────────────────────────────────────────────

test("erkennt die Meldung aus dem Vorfall", () => {
  // Genau der Text aus dem Screenshot vom 17.08.2026.
  assert.equal(istNachladeFehler(new Error("Unexpected token '<'")), true);
});

test("erkennt die Meldungen der anderen Browser — auch streng", () => {
  const meldungen = [
    "Failed to fetch dynamically imported module: https://avycloud.web.app/assets/OrdersView-abc123.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html.",
    "Loading chunk 42 failed.",
  ];
  for (const m of meldungen) {
    assert.equal(istEindeutigerNachladeFehler(new Error(m)), true, m);
    assert.equal(istNachladeFehler(new Error(m)), true, m);
  }
});

test("KERN: ein JSON-Fehler auf eine HTML-Antwort ist KEIN Nachladefehler", () => {
  // V8 meldet JSON.parse("<!doctype html>") wortwoertlich so. Ohne diesen
  // Ausschluss wuerde eine Backend-Stoerung (Cloud-Run-502 liefert eine
  // HTML-Fehlerseite) die Seite neu laden und "Neue Version verfuegbar"
  // behaupten. Nachgewiesen vom Pruefdurchlauf am 17.08.2026.
  let echteMeldung = "";
  try {
    JSON.parse("<!doctype html>");
  } catch (e: any) {
    echteMeldung = e.message;
  }
  assert.ok(echteMeldung.length > 0, "JSON.parse muss werfen");
  assert.equal(istNachladeFehler(new Error(echteMeldung)), false, echteMeldung);
  assert.equal(istEindeutigerNachladeFehler(new Error(echteMeldung)), false, echteMeldung);
});

test("die strenge Pruefung akzeptiert 'Unexpected token' gar nicht", () => {
  // In den globalen Haken zaehlt nur Unmissverstaendliches — dort landen auch
  // JSON-Fehler aus Klick-Handlern.
  assert.equal(istEindeutigerNachladeFehler(new Error("Unexpected token '<'")), false);
});

test("haelt gewoehnliche Fehler NICHT fuer Nachladefehler", () => {
  const andere = [
    "Cannot read properties of undefined (reading 'map')",
    "Server returned HTML instead of JSON. Status: 502.",
    "Netzwerkfehler",
    "Tracking-Nummer erforderlich.",
    "JSON Parse error: Unexpected identifier \"<\"", // Safari-Wortlaut fuer JSON
  ];
  for (const m of andere) {
    assert.equal(istNachladeFehler(new Error(m)), false, m);
  }
});

test("vertraegt fehlende und fremde Eingaben", () => {
  assert.equal(istNachladeFehler(null), false);
  assert.equal(istNachladeFehler(undefined), false);
  assert.equal(istNachladeFehler({}), false);
  assert.equal(istNachladeFehler("Unexpected token '<'"), true);
});

// ─────────────────────────────────────────────────────────────
// Neuladen + Schleifenschutz
// ─────────────────────────────────────────────────────────────

test("laedt beim ersten Mal neu und zaehlt mit", () => {
  const s = frisch();
  assert.equal(sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1000 }), true);
  assert.equal(zaehleVersuche(s), 1);
});

test("KERN: ein Vorfall zaehlt nur EINMAL, auch bei mehreren Fehlergrenzen", () => {
  // Seit es eine Grenze je Ansicht gibt, koennen zwei Grenzen denselben
  // Vorfall fangen; StrictMode ruft zusaetzlich doppelt auf. Ohne Sperre waere
  // das Budget nach einem einzigen Vorfall aufgebraucht.
  const s = frisch();
  assert.equal(sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1000 }), true);
  assert.equal(sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1001 }), false);
  assert.equal(zaehleVersuche(s), 1);
});

test("gibt nach MAX_RELOADS auf — keine Schleife", () => {
  const s = fakeSpeicher();
  for (let i = 0; i < MAX_RELOADS; i++) {
    _testZuruecksetzen(); // jedes Neuladen ist ein neues Seitenleben
    assert.equal(
      sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1000 + i }),
      true,
      `Versuch ${i + 1}`,
    );
  }
  _testZuruecksetzen();
  assert.equal(sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 9999 }), false);
  assert.equal(zaehleVersuche(s), MAX_RELOADS);
});

test("laedt bei anderen Fehlern nie neu", () => {
  const s = frisch();
  assert.equal(sollNeuLaden(new Error("Cannot read properties of undefined"), { speicher: s }), false);
  assert.equal(zaehleVersuche(s), 0);
});

test("streng: ein JSON-Fehler loest KEIN Neuladen aus", () => {
  const s = frisch();
  const treffer = sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, streng: true });
  assert.equal(treffer, false);
  assert.equal(zaehleVersuche(s), 0);
});

test("ohne Speicher wird NICHT neu geladen — sonst fehlt der Schleifenschutz", () => {
  _testZuruecksetzen();
  assert.equal(sollNeuLaden(new Error("Unexpected token '<'"), { speicher: null }), false);
});

// ─────────────────────────────────────────────────────────────
// Zuruecksetzen — hier lag der kritische Defekt
// ─────────────────────────────────────────────────────────────

test("KERN: der Zaehler wird NICHT sofort zurueckgesetzt", () => {
  // Frueher lief das Zuruecksetzen direkt nach dem ersten Zeichnen — also
  // bauartbedingt IMMER bevor ein Nachladefehler eintreffen konnte. Der
  // Zaehler stand damit ewig auf 0 und MAX_RELOADS wurde nie erreicht:
  // Start -> 0 -> Fehler -> 1 -> neu laden -> 0 -> Fehler -> 1 -> ...
  // Eine Endlosschleife. Genau das, was ausgeschlossen werden sollte.
  const s = fakeSpeicher();
  _testZuruecksetzen();
  sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1_000 });
  assert.equal(zaehleVersuche(s), 1);

  _testZuruecksetzen(); // neues Seitenleben nach dem Neuladen
  let geplant: { fn: () => void; ms: number } | null = null;
  meldeErfolgreichenStart({
    speicher: s,
    jetzt: 2_000, // nur 1 s spaeter — mitten im Neulade-Zyklus
    setTimeoutFn: (fn, ms) => { geplant = { fn, ms }; return 1 as any; },
  });

  assert.ok(geplant, "es muss ein Timer geplant werden");
  // Die Wartezeit deckt sowohl die Heilungsfrist als auch die Abkuehlung ab.
  assert.ok(geplant!.ms >= HEILUNG_MS, `Wartezeit ${geplant!.ms} < ${HEILUNG_MS}`);
  assert.ok(geplant!.ms >= ABKUEHLUNG_MS - 1_000, "Abkuehlung seit dem Versuch muss zaehlen");
  // Solange der Timer nicht gefeuert hat, bleibt der Zaehler stehen.
  assert.equal(zaehleVersuche(s), 1);
});

test("nach nachgewiesen gesundem Betrieb wird zurueckgesetzt", () => {
  const s = fakeSpeicher();
  _testZuruecksetzen();
  sollNeuLaden(new Error("Unexpected token '<'"), { speicher: s, jetzt: 1_000 });

  _testZuruecksetzen();
  let geplant: (() => void) | null = null;
  meldeErfolgreichenStart({
    speicher: s,
    jetzt: 1_000 + ABKUEHLUNG_MS,
    setTimeoutFn: (fn) => { geplant = fn; return 1 as any; },
  });
  geplant!(); // Frist abgelaufen, kein Fehler aufgetreten
  assert.equal(zaehleVersuche(s), 0);
});

test("trat in diesem Seitenleben ein Fehler auf, wird NICHT zurueckgesetzt", () => {
  const s = fakeSpeicher({ avycloud_chunk_reload_versuche: JSON.stringify({ n: 1, ts: 1_000 }) });
  _testZuruecksetzen();
  let geplant: (() => void) | null = null;
  meldeErfolgreichenStart({
    speicher: s,
    jetzt: 100_000,
    setTimeoutFn: (fn) => { geplant = fn; return 1 as any; },
  });
  merkeNachladeFehler(); // waehrend der Frist knallt es doch
  geplant!();
  assert.equal(zaehleVersuche(s), 1, "der Zaehler darf nicht geloescht werden");
});

test("ohne offene Versuche wird gar kein Timer geplant", () => {
  const s = fakeSpeicher();
  _testZuruecksetzen();
  let geplant = false;
  meldeErfolgreichenStart({ speicher: s, jetzt: 1_000, setTimeoutFn: () => { geplant = true; return 1 as any; } });
  assert.equal(geplant, false);
});

test("unsinnige Zaehlerstaende gelten als null", () => {
  assert.equal(zaehleVersuche(fakeSpeicher({ avycloud_chunk_reload_versuche: "quatsch" })), 0);
  assert.equal(zaehleVersuche(fakeSpeicher({ avycloud_chunk_reload_versuche: '{"n":-3}' })), 0);
  assert.equal(zaehleVersuche(fakeSpeicher({ avycloud_chunk_reload_versuche: "2" })), 2, "Altformat");
});

test("ein Klick des Menschen darf immer neu laden", () => {
  // Der Knopf setzt zurueck; ein Mensch kann keine Endlosschleife erzeugen.
  const s = fakeSpeicher({ avycloud_chunk_reload_versuche: JSON.stringify({ n: MAX_RELOADS, ts: 1 }) });
  meldeErfolgreichenStart({ speicher: s, jetzt: 1, sofort: true });
  assert.equal(zaehleVersuche(s), 0);
});

test("die Erklaerung nennt keine Fachbegriffe", () => {
  const text = nachladeFehlerText();
  for (const wort of ["chunk", "module", "token", "MIME", "JavaScript"]) {
    assert.equal(text.toLowerCase().includes(wort.toLowerCase()), false, wort);
  }
  assert.ok(text.includes("neu"));
});
