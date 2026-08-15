import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

/**
 * Jede erreichbare Ansicht braucht einen Seitennamen in der Topbar.
 *
 * `Topbar.tsx` fällt bei einem unbekannten Schlüssel auf "Dashboard" zurück
 * (`VIEW_TITLES[currentView] || "Dashboard"`). Fehlt der Eintrag, klickt der
 * Mensch also z. B. "Shop-Gesundheit" in der Seitenleiste an und liest oben
 * trotzdem "Dashboard" — die App behauptet, er sei woanders.
 *
 * Gefunden am 2026-08-16: neun von 41 Ansichten hatten keinen Namen, darunter
 * fünf echte Menüpunkte (Shop-Gesundheit, Duplikate, Preise, Regeln,
 * Aktivitätsprotokoll).
 *
 * Der Rückfall auf "Dashboard" ist bewusst kein Fehlerfall — er verhindert eine
 * leere Kopfzeile. Genau deshalb blieb die Lücke so lange unsichtbar, und genau
 * deshalb braucht es diesen Test.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

function block(src: string, startPattern: RegExp): string {
  const m = startPattern.exec(src);
  assert.ok(m, `Block nicht gefunden: ${startPattern}`);
  const from = src.indexOf("{", m!.index);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i);
    }
  }
  throw new Error("Blockende nicht gefunden");
}

function allowedViews(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "App.tsx"), "utf8");
  const m = /const ALLOWED_VIEWS[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(m, "ALLOWED_VIEWS nicht gefunden");
  return new Set(Array.from(m![1].matchAll(/'([a-z0-9-]+)'/g)).map((x) => x[1]));
}

function viewTitles(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "components/Topbar.tsx"), "utf8");
  const body = block(src, /const VIEW_TITLES[^=]*=/);
  return new Set(Array.from(body.matchAll(/^\s*"?([a-z0-9-]+)"?:/gm)).map((x) => x[1]));
}

/** Ansichten, die aus der Seitenleiste heraus anklickbar sind. */
function sidebarViews(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "components/Sidebar.tsx"), "utf8");
  return new Set(Array.from(src.matchAll(/view:\s*"([a-z0-9-]+)"\s*as View/g)).map((x) => x[1]));
}

describe("Seitennamen in der Topbar", () => {
  test("jeder Menüpunkt der Seitenleiste hat einen eigenen Seitennamen", () => {
    const titles = viewTitles();
    const fehlend = [...sidebarViews()].filter((v) => !titles.has(v)).sort();
    assert.deepStrictEqual(
      fehlend,
      [],
      `Diese Menüpunkte zeigen oben faelschlich "Dashboard":\n  ${fehlend.join("\n  ")}`
    );
  });

  test("jede erreichbare Ansicht hat einen eigenen Seitennamen", () => {
    const titles = viewTitles();
    const fehlend = [...allowedViews()].filter((v) => !titles.has(v)).sort();
    assert.deepStrictEqual(
      fehlend,
      [],
      `Ansichten ohne Seitennamen:\n  ${fehlend.join("\n  ")}`
    );
  });

  test("der Scanner findet überhaupt etwas (Selbstprüfung)", () => {
    assert.ok(allowedViews().size > 20, "ALLOWED_VIEWS verdächtig klein — Regex kaputt?");
    assert.ok(sidebarViews().size > 5, "Seitenleisten-Scanner verdächtig leer — Regex kaputt?");
  });
});
