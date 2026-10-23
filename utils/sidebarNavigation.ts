import type { View } from "../types";
import { canAccessView, type PermissionCheck } from "./viewPermissions.ts";

/** `label` bleibt der deutsche Klartext, `labelKey` ist der i18n-Schlüssel für die Anzeige. */
export type SidebarItem = { view: View; label: string; labelKey: string; icon: string };
export type SidebarSection = {
  id: string;
  label: string;
  /** Leer bei "main" — dieser Abschnitt hat keine Überschrift. */
  labelKey: string;
  icon: string;
  items: SidebarItem[];
  secondaryItems: SidebarItem[];
};

const SECTIONS: SidebarSection[] = [
  { id: "main", label: "", labelKey: "", icon: "dashboard", items: [
    { view: "dashboard", label: "Dashboard", labelKey: "sidebar.item.dashboard", icon: "dashboard" },
    { view: "finance", label: "Finanzen", labelKey: "sidebar.item.finance", icon: "creditCard" },
  ], secondaryItems: [] },
  { id: "orders", label: "Aufträge", labelKey: "sidebar.section.orders", icon: "orders", items: [
    { view: "orders", label: "Bestellungen", labelKey: "sidebar.item.orders", icon: "orders" },
    { view: "orders-returns", label: "Retouren", labelKey: "sidebar.item.orders-returns", icon: "returns" },
    { view: "orders-shipping", label: "Versand & Labels", labelKey: "sidebar.item.orders-shipping", icon: "truck" },
    { view: "orders-invoices", label: "Rechnungen", labelKey: "sidebar.item.orders-invoices", icon: "fileText" },
  ], secondaryItems: [{ view: "orders-settings", label: "Einstellungen", labelKey: "sidebar.item.orders-settings", icon: "sliders" }] },
  { id: "products", label: "Produkte", labelKey: "sidebar.section.products", icon: "package", items: [
    { view: "products", label: "Produktdaten", labelKey: "sidebar.item.products", icon: "package" },
    { view: "input", label: "Erfassen", labelKey: "sidebar.item.input", icon: "scanLine" },
    { view: "pricing", label: "Preise", labelKey: "sidebar.item.pricing", icon: "tag" },
  ], secondaryItems: [
    { view: "duplicates", label: "Duplikate", labelKey: "sidebar.item.duplicates", icon: "layers" },
    { view: "rules", label: "Regeln", labelKey: "sidebar.item.rules", icon: "settings" },
  ] },
  { id: "warehouse", label: "Lager", labelKey: "sidebar.section.warehouse", icon: "warehouse", items: [
    { view: "inventory", label: "Inventar", labelKey: "sidebar.item.inventory", icon: "warehouse" },
    { view: "warehouse", label: "Verwaltung", labelKey: "sidebar.item.warehouse", icon: "mapPin" },
  ], secondaryItems: [{ view: "warehouse-settings", label: "Einstellungen", labelKey: "sidebar.item.warehouse-settings", icon: "sliders" }] },
  { id: "marketplaces", label: "Marktplätze", labelKey: "sidebar.section.marketplaces", icon: "store", items: [
    { view: "marketplace-ebay", label: "eBay", labelKey: "sidebar.item.marketplace-ebay", icon: "shoppingBag" },
    { view: "marketplace-kaufland", label: "Kaufland", labelKey: "sidebar.item.marketplace-kaufland", icon: "store" },
    { view: "marketplace-errors", label: "Listing-Fehler", labelKey: "sidebar.item.marketplace-errors", icon: "fileText" },
    { view: "shop-health", label: "Shop-Gesundheit", labelKey: "sidebar.item.shop-health", icon: "store" },
  ], secondaryItems: [] },
  { id: "settings", label: "Einstellungen", labelKey: "sidebar.section.settings", icon: "settings", items: [
    { view: "settings-profile", label: "Persönliche Daten", labelKey: "sidebar.item.settings-profile", icon: "user" },
    { view: "settings", label: "Unternehmensdaten", labelKey: "sidebar.item.settings", icon: "building" },
    { view: "settings-team", label: "Mitarbeiter & Rollen", labelKey: "sidebar.item.settings-team", icon: "users" },
    { view: "integrations", label: "Integrationen", labelKey: "sidebar.item.integrations", icon: "plug" },
    { view: "settings-api", label: "API", labelKey: "sidebar.item.settings-api", icon: "code" },
    { view: "settings-billing", label: "Plan & Abrechnung", labelKey: "sidebar.item.settings-billing", icon: "creditCard" },
    { view: "audit-log", label: "Aktivitätsprotokoll", labelKey: "sidebar.item.audit-log", icon: "fileText" },
  ], secondaryItems: [] },
];

export const getSidebarSections = (hasPermission: PermissionCheck): SidebarSection[] => SECTIONS
  .map(section => ({ ...section,
    items: section.items.filter(item => canAccessView(item.view, hasPermission)),
    secondaryItems: section.secondaryItems.filter(item => canAccessView(item.view, hasPermission)),
  }))
  .filter(section => section.items.length + section.secondaryItems.length > 0);

export const isSidebarItemActive = (current: View, target: View): boolean => current === target
  || (target === "dashboard" && current === "home")
  || (target === "products" && (current === "search" || current === "sheet"))
  || (target === "marketplace-ebay" && current === "ebay-listings")
  || (target === "integrations" && current.startsWith("integrations-"));

export type SidebarPreferences = { collapsed: boolean; sections: Record<string, boolean> };
const emptyPreferences = (): SidebarPreferences => ({ collapsed: false, sections: {} });
const validKeys = new Set(SECTIONS.filter(s => s.id !== "main").flatMap(s => [s.id, `${s.id}:more`]));

// No migration of the old shared keys: their owner cannot be established on shared devices.
export const sidebarStorageKey = (uid: string, tenantId?: string | null): string =>
  `avycloud:sidebar:v2:${JSON.stringify([tenantId ?? "", uid])}`;

export function readSidebarPreferences(storage: Pick<Storage, "getItem"> | undefined, key: string): SidebarPreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyPreferences();
    const sections: Record<string, boolean> = {};
    if (parsed.sections && typeof parsed.sections === "object" && !Array.isArray(parsed.sections)) {
      for (const [id, value] of Object.entries(parsed.sections)) {
        if (validKeys.has(id) && typeof value === "boolean") sections[id] = value;
      }
    }
    return { collapsed: parsed.collapsed === true, sections };
  } catch { return emptyPreferences(); }
}

export function saveSidebarPreferences(storage: Pick<Storage, "setItem"> | undefined, key: string, value: SidebarPreferences): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* Remain usable when storage is blocked/full. */ }
}

export function sectionIsOpen(section: SidebarSection, preferences: SidebarPreferences, currentView: View, sections: SidebarSection[]): boolean {
  if (section.id === "main") return true;
  if (typeof preferences.sections[section.id] === "boolean") return preferences.sections[section.id];
  const current = sections.find(s => [...s.items, ...s.secondaryItems].some(i => isSidebarItemActive(currentView, i.view)));
  const initial = current?.id !== "main" && current ? current : sections.find(s => s.id !== "main" && s.id !== "settings");
  return section.id === initial?.id;
}

/** Materialize defaults once: merely visiting another page must not undo the last layout. */
export function initializeSidebarPreferences(stored: SidebarPreferences, currentView: View): SidebarPreferences {
  const sections: Record<string, boolean> = { ...stored.sections };
  for (const section of SECTIONS.filter(s => s.id !== "main")) {
    sections[section.id] = sectionIsOpen(section, stored, currentView, SECTIONS);
    sections[`${section.id}:more`] ??= section.secondaryItems.some(item => isSidebarItemActive(currentView, item.view));
  }
  return { ...stored, sections };
}
