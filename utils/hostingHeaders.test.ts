import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Auslieferungs-Regeln von Firebase Hosting.
 *
 * Gemessen an der Produktion am 17.08.2026:
 *  - `GET /` trug `cache-control: max-age=3600`. Die vorhandene
 *    „nicht zwischenspeichern"-Regel galt nur fuer den Literalpfad
 *    `/index.html`, der Browser ruft aber `/` ab. Nach einer Veroeffentlichung
 *    konnte also bis zu **60 Minuten** die ALTE Startseite ausgeliefert werden —
 *    die auf geloeschte Programmteile zeigt. Dann startet die Anwendung gar
 *    nicht erst, und keine Selbstheilung greift, weil sie nie laeuft.
 *  - Die Programmdateien trugen ebenfalls nur `max-age=3600`, obwohl ihre Namen
 *    eine Pruefsumme tragen und sich nie aendern. Ergebnis: rund 1,2 MB werden
 *    stuendlich neu geladen.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));

function headerFuer(source: string): Record<string, string> {
  const regel = (CONFIG.hosting?.headers ?? []).find((h: any) => h.source === source);
  if (!regel) return {};
  return Object.fromEntries((regel.headers ?? []).map((h: any) => [h.key, h.value]));
}

test("die Startseite wird nicht zwischengespeichert", () => {
  // Der Browser ruft "/" ab, nicht "/index.html".
  const cc = headerFuer("/")["Cache-Control"] ?? "";
  assert.match(cc, /no-cache/, "GET / darf nicht zwischengespeichert werden");
  assert.match(cc, /no-store/);
});

test("die alte Regel fuer /index.html bleibt bestehen", () => {
  const cc = headerFuer("/index.html")["Cache-Control"] ?? "";
  assert.match(cc, /no-cache/);
});

test("pruefsummen-benannte Dateien bleiben dauerhaft im Browser", () => {
  const cc = headerFuer("/assets/**")["Cache-Control"] ?? "";
  assert.match(cc, /immutable/, "gehashte Dateien aendern sich nie — immutable");
  assert.match(cc, /max-age=31536000/);
});

test("die Startseite ist NICHT immutable", () => {
  // Sonst saehe niemand je eine neue Fassung.
  const cc = headerFuer("/")["Cache-Control"] ?? "";
  assert.doesNotMatch(cc, /immutable/);
});

test("der SPA-Rewrite bleibt unangetastet", () => {
  // Ohne ihn fuehrt jede Adresse ins Leere statt in die Anwendung.
  const rewrites = CONFIG.hosting?.rewrites ?? [];
  assert.ok(rewrites.some((r: any) => r.source === "**" && r.destination === "/index.html"));
});
