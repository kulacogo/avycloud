import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeSidebarPreferences, getSidebarSections, isSidebarItemActive, sectionIsOpen, sidebarStorageKey, readSidebarPreferences, saveSidebarPreferences } from "./sidebarNavigation.ts";

const all = getSidebarSections(() => true);
test("all existing menu links retain their names and occur exactly once", () => {
  const items = all.flatMap(s => [...s.items, ...s.secondaryItems]);
  assert.equal(items.length, 26);
  assert.equal(new Set(items.map(i => i.view)).size, items.length);
  assert.deepEqual(Object.fromEntries(items.map(i => [i.view, i.label])), {
    dashboard: "Dashboard", finance: "Finanzen",
    orders: "Bestellungen", "orders-returns": "Retouren", "orders-shipping": "Versand & Labels", "orders-invoices": "Rechnungen", "orders-settings": "Einstellungen",
    products: "Produktdaten", input: "Erfassen", pricing: "Preise", duplicates: "Duplikate", rules: "Regeln",
    inventory: "Inventar", warehouse: "Verwaltung", "warehouse-settings": "Einstellungen",
    "marketplace-ebay": "eBay", "marketplace-kaufland": "Kaufland", "marketplace-errors": "Listing-Fehler", "shop-health": "Shop-Gesundheit",
    "settings-profile": "Persönliche Daten", settings: "Unternehmensdaten", "settings-team": "Mitarbeiter & Rollen", integrations: "Integrationen", "settings-api": "API", "settings-billing": "Plan & Abrechnung", "audit-log": "Aktivitätsprotokoll",
  });
  assert.ok(all.find(s => s.id === "warehouse")?.items.some(i => i.view === "inventory"));
  assert.ok(all.find(s => s.id === "marketplaces")?.items.some(i => i.view === "shop-health"));
  assert.ok(all.find(s => s.id === "settings")?.items.some(i => i.view === "integrations"));
});
test("permission filtering applies independently to every link and removes empty groups", () => {
  const sections = getSidebarSections((module, action) => module === "invoices" && action === "read");
  assert.deepEqual(sections.flatMap(s => [...s.items, ...s.secondaryItems]).map(i => i.view), ["orders-invoices", "settings-profile"]);
  assert.ok(sections.every(s => s.items.length + s.secondaryItems.length > 0));
  const reader = getSidebarSections((module, action) => module === "products" && action === "read");
  assert.deepEqual(reader.find(s => s.id === "warehouse")?.items.map(i => i.view), ["inventory"]);
  assert.ok(!reader.flatMap(s => s.secondaryItems).some(i => i.view === "rules"));
});
test("first visit opens only the current work area; explicit choices override defaults", () => {
  const prefs = { collapsed: false, sections: {} };
  assert.deepEqual(all.filter(s => s.id !== "main" && sectionIsOpen(s, prefs, "inventory", all)).map(s => s.id), ["warehouse"]);
  assert.deepEqual(all.filter(s => s.id !== "main" && sectionIsOpen(s, prefs, "dashboard", all)).map(s => s.id), ["orders"]);
  assert.equal(sectionIsOpen(all.find(s => s.id === "warehouse")!, { ...prefs, sections: { warehouse: false } }, "inventory", all), false);
  assert.equal(sectionIsOpen(all.find(s => s.id === "warehouse")!, { ...prefs, sections: { warehouse: true } }, "dashboard", all), true);
});
test("aliases and integration subpages highlight the existing parent entry", () => {
  assert.equal(isSidebarItemActive("sheet", "products"), true);
  assert.equal(isSidebarItemActive("home", "dashboard"), true);
  assert.equal(isSidebarItemActive("ebay-listings", "marketplace-ebay"), true);
  assert.equal(isSidebarItemActive("integrations-sendcloud", "integrations"), true);
  assert.equal(isSidebarItemActive("orders-returns", "orders"), false);
});
test("preferences survive reload and remain isolated across users and tenants", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const key = sidebarStorageKey("alice", "tenant-a");
  const prefs = { collapsed: true, sections: { warehouse: true, orders: false, "products:more": true } };
  saveSidebarPreferences(storage, key, prefs);
  assert.deepEqual(readSidebarPreferences(storage, key), prefs);
  assert.deepEqual(readSidebarPreferences(storage, sidebarStorageKey("bob", "tenant-a")), { collapsed: false, sections: {} });
  assert.notEqual(key, sidebarStorageKey("alice", "tenant-b"));
  data.set("avycloud:sidebar:sections", '{"warehouse":false}');
  assert.deepEqual(readSidebarPreferences(storage, sidebarStorageKey("new")), { collapsed: false, sections: {} });
});
test("malformed or unavailable storage cannot break navigation", () => {
  for (const raw of ["null", "[]", "bad", '"string"']) {
    assert.deepEqual(readSidebarPreferences({ getItem: () => raw }, "key"), { collapsed: false, sections: {} });
  }
  assert.deepEqual(readSidebarPreferences({ getItem: () => '{"collapsed":"true","sections":{"warehouse":true,"orders":0,"unknown":true}}' }, "key"), { collapsed: false, sections: { warehouse: true } });
  const broken = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("quota"); } };
  assert.deepEqual(readSidebarPreferences(broken, "key"), { collapsed: false, sections: {} });
  assert.doesNotThrow(() => saveSidebarPreferences(broken, "key", { collapsed: false, sections: {} }));
});

test("initially open groups also survive a restart on another page", () => {
  const initial = initializeSidebarPreferences({ collapsed: false, sections: {} }, "inventory");
  const restarted = initializeSidebarPreferences(initial, "dashboard");
  assert.deepEqual(restarted, initial);
  assert.equal(restarted.sections.warehouse, true);
  assert.equal(restarted.sections.orders, false);
  const deepLink = initializeSidebarPreferences({ collapsed: false, sections: {} }, "rules");
  assert.equal(deepLink.sections.products, true);
  assert.equal(deepLink.sections["products:more"], true);
});
