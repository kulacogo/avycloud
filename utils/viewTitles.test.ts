import { getSidebarSections } from "./sidebarNavigation.ts";
import { ALLOWED_VIEWS } from "./viewPermissions.ts";
import { VIEW_TITLE_KEYS } from "./viewTitles.ts";
import { describe, test } from "node:test";
import assert from "node:assert";

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

function allowedViews(): Set<string> { return new Set(ALLOWED_VIEWS); }

// The title map moved from components/Topbar.tsx (VIEW_TITLES) to utils/viewTitles.ts
// (VIEW_TITLE_KEYS, i18n keys) on 2026-10-23 — read it directly instead of parsing source.
function viewTitles(): Set<string> {
  return new Set(Object.keys(VIEW_TITLE_KEYS));
}

/** Ansichten, die aus der Seitenleiste heraus anklickbar sind. */
function sidebarViews(): Set<string> {
  return new Set(getSidebarSections(() => true).flatMap(section => [...section.items, ...section.secondaryItems]).map(item => item.view));
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
