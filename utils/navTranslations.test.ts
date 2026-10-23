/**
 * Seitenleiste und Topbar-Titel laufen über dynamische Schlüssel
 * (`t(item.labelKey)`, `t(viewTitleKey(view))`) — die findet der Scanner in
 * i18nKeys.test.ts nicht. Dieser Test prüft sie direkt: jeder Schlüssel steht
 * in allen drei Sprachen, und der deutsche Text ist exakt der von vorher.
 */
import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { getSidebarSections } from "./sidebarNavigation.ts";
import { VIEW_BREADCRUMBS, VIEW_TITLE_KEYS, viewTitleKey } from "./viewTitles.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Liest die drei Wörterbücher aus i18n.tsx als Schlüssel → Text. */
function dictionaries(): Record<"de" | "en" | "tr", Map<string, string>> {
  const src = fs.readFileSync(path.join(ROOT, "i18n.tsx"), "utf8");
  const result = {} as Record<"de" | "en" | "tr", Map<string, string>>;
  for (const lang of ["de", "en", "tr"] as const) {
    const start = new RegExp(`^\\s{2}${lang}:\\s*\\{\\n`, "m").exec(src);
    assert.ok(start, `Wörterbuch-Block '${lang}' nicht gefunden`);
    const from = start!.index + start![0].length;
    const to = src.indexOf("\n  },", from);
    result[lang] = new Map(
      Array.from(src.slice(from, to).matchAll(/^\s+'([^']+)':\s*'([^']*)',$/gm)).map((m) => [m[1], m[2]])
    );
  }
  return result;
}

const allowAll = () => true;
const dicts = dictionaries();

/** Stand vor der Übersetzung — der deutsche Text darf sich nicht ändern. */
const GERMAN_TITLES: Record<string, string> = {
  dashboard: "Dashboard", home: "Dashboard", search: "Suche", input: "Erfassen",
  inventory: "Inventar", products: "Produkte", admin: "Admin", categories: "Kategorien",
  "ebay-listings": "eBay", warehouse: "Lagerverwaltung", "warehouse-settings": "Lager-Einstellungen",
  orders: "Bestellungen", "orders-returns": "Retouren", "orders-shipping": "Versand & Labels",
  "orders-invoices": "Rechnungen", "orders-settings": "Auftrags-Einstellungen",
  operations: "Operationen", "operations-identify": "Operationen", "operations-stow": "Operationen",
  "operations-pick": "Operationen", "operations-pack": "Operationen", sheet: "Produkte",
  "marketplace-ebay": "eBay Listings", "marketplace-kaufland": "Kaufland Listings",
  "marketplace-errors": "Listing-Fehler", finance: "Finanzen", integrations: "Integrationen",
  settings: "Unternehmensdaten", "settings-profile": "Persönliche Daten",
  "settings-team": "Mitarbeiter & Rollen", "settings-api": "API", "settings-billing": "Plan & Abrechnung",
  "shop-health": "Shop-Gesundheit", duplicates: "Duplikate", pricing: "Preise", rules: "Regeln",
  "audit-log": "Aktivitätsprotokoll", "integrations-ebay": "eBay", "integrations-kaufland": "Kaufland",
  "integrations-sendcloud": "SendCloud", "integrations-sevdesk": "SevDesk",
};

const GERMAN_BREADCRUMB_PARENTS: Record<string, string> = {
  "orders-returns": "Aufträge", "orders-shipping": "Aufträge", "orders-invoices": "Aufträge",
  "orders-settings": "Aufträge", "warehouse-settings": "Lager", "marketplace-ebay": "Marktplätze",
  "marketplace-kaufland": "Marktplätze", "settings-profile": "Einstellungen", "settings-team": "Einstellungen",
  "settings-api": "Einstellungen", "settings-billing": "Einstellungen", categories: "Produkte", input: "Produkte",
};

function assertInAllLocales(key: string) {
  for (const lang of ["de", "en", "tr"] as const) {
    assert.ok(dicts[lang].get(key), `${key} fehlt oder ist leer in ${lang}`);
  }
}

describe("Seitenleiste", () => {
  const sections = getSidebarSections(allowAll);

  test("jeder Abschnitt und jeder Eintrag hat seinen Text in allen drei Sprachen", () => {
    for (const section of sections) {
      if (section.id !== "main") assertInAllLocales(section.labelKey);
      for (const item of [...section.items, ...section.secondaryItems]) assertInAllLocales(item.labelKey);
    }
  });

  test("der deutsche Text ist unverändert", () => {
    for (const section of sections) {
      if (section.id !== "main") assert.strictEqual(dicts.de.get(section.labelKey), section.label);
      for (const item of [...section.items, ...section.secondaryItems]) {
        assert.strictEqual(dicts.de.get(item.labelKey), item.label, item.view);
      }
    }
  });
});

describe("Topbar-Titel", () => {
  test("jede bisher bekannte Ansicht hat einen Schlüssel mit unverändertem deutschen Text", () => {
    assert.deepStrictEqual(Object.keys(VIEW_TITLE_KEYS).sort(), Object.keys(GERMAN_TITLES).sort());
    for (const [view, german] of Object.entries(GERMAN_TITLES)) {
      assertInAllLocales(viewTitleKey(view));
      assert.strictEqual(dicts.de.get(viewTitleKey(view)), german, view);
    }
  });

  test("Breadcrumb-Eltern unverändert und übersetzt", () => {
    assert.deepStrictEqual(Object.keys(VIEW_BREADCRUMBS).sort(), Object.keys(GERMAN_BREADCRUMB_PARENTS).sort());
    for (const [view, german] of Object.entries(GERMAN_BREADCRUMB_PARENTS)) {
      const key = VIEW_BREADCRUMBS[view].parentKey;
      assertInAllLocales(key);
      assert.strictEqual(dicts.de.get(key), german, view);
    }
  });

  test("unbekannte Ansicht fällt auf Dashboard zurück", () => {
    assert.strictEqual(dicts.de.get(viewTitleKey("gibt-es-nicht")), "Dashboard");
  });
});
