import test from "node:test";
import assert from "node:assert/strict";

import {
  leseEinstiegsdatei,
  istNeueFassung,
  starteVersionsUeberwachung,
} from "./versionWatch.ts";

test("liest den Namen der Einstiegsdatei aus dem Seiten-HTML", () => {
  const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-ede9b4bd.js"></script>';
  assert.equal(leseEinstiegsdatei(html), "index-ede9b4bd.js");
});

test("liest den Namen auch aus einer Adresse", () => {
  assert.equal(
    leseEinstiegsdatei("https://avycloud.web.app/assets/index-ab12cd34.js"),
    "index-ab12cd34.js",
  );
});

test("liefert nichts, wenn nichts drinsteht", () => {
  assert.equal(leseEinstiegsdatei("<html></html>"), null);
  assert.equal(leseEinstiegsdatei(""), null);
  assert.equal(leseEinstiegsdatei(null), null);
});

test("gleiche Fassung meldet nichts", () => {
  assert.equal(istNeueFassung("index-aaa.js", "index-aaa.js"), false);
});

test("andere Fassung meldet", () => {
  assert.equal(istNeueFassung("index-aaa.js", "index-bbb.js"), true);
});

test("Unbekanntes meldet NIE — lieber keine Meldung als eine falsche", () => {
  assert.equal(istNeueFassung(null, "index-bbb.js"), false);
  assert.equal(istNeueFassung("index-aaa.js", null), false);
  assert.equal(istNeueFassung(null, null), false);
});

test("meldet genau einmal, auch wenn weiter geprueft wird", async () => {
  let getaktet: (() => void) | null = null;
  let meldungen = 0;
  starteVersionsUeberwachung(() => { meldungen++; }, {
    eigeneDatei: "index-alt.js",
    holeStartseite: async () => '<script src="/assets/index-neu.js"></script>',
    setIntervalFn: (fn) => { getaktet = fn; return 1; },
    clearIntervalFn: () => {},
  });

  getaktet!();
  await new Promise((r) => setTimeout(r, 0));
  getaktet!();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(meldungen, 1);
});

test("prueft nicht, wenn der Tab im Hintergrund liegt", async () => {
  let getaktet: (() => void) | null = null;
  let abrufe = 0;
  starteVersionsUeberwachung(() => {}, {
    eigeneDatei: "index-alt.js",
    holeStartseite: async () => { abrufe++; return ""; },
    setIntervalFn: (fn) => { getaktet = fn; return 1; },
    clearIntervalFn: () => {},
    sichtbar: () => false,
  });
  getaktet!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(abrufe, 0);
});

test("ein Netzfehler bleibt folgenlos", async () => {
  let getaktet: (() => void) | null = null;
  let meldungen = 0;
  starteVersionsUeberwachung(() => { meldungen++; }, {
    eigeneDatei: "index-alt.js",
    holeStartseite: async () => { throw new Error("offline"); },
    setIntervalFn: (fn) => { getaktet = fn; return 1; },
    clearIntervalFn: () => {},
  });
  getaktet!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(meldungen, 0);
});

test("ohne eigene Fassung startet gar keine Ueberwachung", () => {
  let geplant = false;
  const stop = starteVersionsUeberwachung(() => {}, {
    eigeneDatei: null,
    setIntervalFn: () => { geplant = true; return 1; },
    clearIntervalFn: () => {},
  });
  assert.equal(geplant, false);
  stop(); // darf nicht werfen
});

test("Abmelden raeumt den Takt ab", () => {
  let abgeraeumt = false;
  const stop = starteVersionsUeberwachung(() => {}, {
    eigeneDatei: "index-alt.js",
    holeStartseite: async () => "",
    setIntervalFn: () => 42,
    clearIntervalFn: (h) => { abgeraeumt = h === 42; },
  });
  stop();
  assert.equal(abgeraeumt, true);
});

test("liest die Einstiegsdatei aus dem Dokument, nicht aus dem eigenen Modul", async () => {
  const { eigeneEinstiegsdatei } = await import("./versionWatch.ts");
  const fakeDoc = {
    querySelectorAll: () => [
      { getAttribute: () => "/assets/vendor-firebase-99ec5151.js" },
      { getAttribute: () => "/assets/index-40437011.js" },
    ],
  } as unknown as Document;
  assert.equal(eigeneEinstiegsdatei(fakeDoc), "index-40437011.js");
});

test("ohne Dokument passiert nichts", async () => {
  const { eigeneEinstiegsdatei } = await import("./versionWatch.ts");
  assert.equal(eigeneEinstiegsdatei(null), null);
  assert.equal(
    eigeneEinstiegsdatei({ querySelectorAll: () => [] } as unknown as Document),
    null,
  );
});
