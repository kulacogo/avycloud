import type { View } from "../types";
import { canAccessView, type PermissionCheck } from "./viewPermissions.ts";

export type SidebarItem = { view: View; label: string; icon: string };
export type SidebarSection = {
  id: string;
  label: string;
  icon: string;
  items: SidebarItem[];
  secondaryItems: SidebarItem[];
};

const SECTIONS: SidebarSection[] = [
  { id: "main", label: "", icon: "dashboard", items: [
    { view: "dashboard", label: "Dashboard", icon: "dashboard" },
    { view: "finance", label: "Finanzen", icon: "creditCard" },
  ], secondaryItems: [] },
  { id: "orders", label: "Aufträge", icon: "orders", items: [
    { view: "orders", label: "Bestellungen", icon: "orders" },
    { view: "orders-returns", label: "Retouren", icon: "returns" },
    { view: "orders-shipping", label: "Versand & Labels", icon: "truck" },
    { view: "orders-invoices", label: "Rechnungen", icon: "fileText" },
  ], secondaryItems: [{ view: "orders-settings", label: "Einstellungen", icon: "sliders" }] },
  { id: "products", label: "Produkte", icon: "package", items: [
    { view: "products", label: "Produktdaten", icon: "package" },
    { view: "input", label: "Erfassen", icon: "scanLine" },
    { view: "pricing", label: "Preise", icon: "tag" },
  ], secondaryItems: [
    { view: "duplicates", label: "Duplikate", icon: "layers" },
    { view: "rules", label: "Regeln", icon: "settings" },
  ] },
  { id: "warehouse", label: "Lager", icon: "warehouse", items: [
    { view: "inventory", label: "Inventar", icon: "warehouse" },
    { view: "warehouse", label: "Verwaltung", icon: "mapPin" },
  ], secondaryItems: [{ view: "warehouse-settings", label: "Einstellungen", icon: "sliders" }] },
  { id: "marketplaces", label: "Marktplätze", icon: "store", items: [
    { view: "marketplace-ebay", label: "eBay", icon: "shoppingBag" },
    { view: "marketplace-kaufland", label: "Kaufland", icon: "store" },
    { view: "marketplace-errors", label: "Listing-Fehler", icon: "fileText" },
    { view: "shop-health", label: "Shop-Gesundheit", icon: "store" },
  ], secondaryItems: [] },
  { id: "settings", label: "Einstellungen", icon: "settings", items: [
    { view: "settings-profile", label: "Persönliche Daten", icon: "user" },
    { view: "settings", label: "Unternehmensdaten", icon: "building" },
    { view: "settings-team", label: "Mitarbeiter & Rollen", icon: "users" },
    { view: "integrations", label: "Integrationen", icon: "plug" },
    { view: "settings-api", label: "API", icon: "code" },
    { view: "settings-billing", label: "Plan & Abrechnung", icon: "creditCard" },
    { view: "audit-log", label: "Aktivitätsprotokoll", icon: "fileText" },
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
