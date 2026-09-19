import type { View } from "../types";

/** Shared source for navigation AND direct-link guards. Unknown views fail closed. */
export type PermissionPair = readonly [module: string, action: string];

// "queue" steht zwar im View-Typ, war aber schon vor dem Umbau in keiner
// ALLOWED_VIEWS-Liste und hat keinen Renderer — ein toter Typ-Eintrag, keine
// erreichbare Ansicht. Bewusst ausgeschlossen statt freigeschaltet.
type ReachableView = Exclude<View, "queue">;

export const VIEW_PERMISSIONS: Record<ReachableView, readonly PermissionPair[]> = {
  dashboard: [["dashboard", "read"]],
  home: [["dashboard", "read"]],

  // Suche zeigt Produktdaten (Desktop sogar die volle Tabelle).
  search: [["products", "read"]],

  // Scan-/Arbeitsansichten: nur wer im Lager wirklich ARBEITET (Aktions-
  // Rechte). warehouse.read/orders.read reichen bewusst NICHT — sonst saehe
  // das Developer-Sichtkonto den Scan-Hub, dessen Kacheln alle gesperrt sind.
  operations: [["warehouse", "write"], ["orders", "pick"], ["orders", "pack"], ["identify", "run"]],
  "operations-identify": [["identify", "run"]],
  "operations-stow": [["warehouse", "write"]],
  "operations-pick": [["orders", "pick"]],
  "operations-pack": [["orders", "pack"]],

  input: [["identify", "run"]],

  products: [["products", "read"]],
  inventory: [["products", "read"]],
  duplicates: [["products", "read"]],
  pricing: [["products", "read"]],
  sheet: [["products", "read"]],
  categories: [["categories", "read"], ["categories", "write"]],
  rules: [["rules", "read"], ["rules", "write"]],

  orders: [["orders", "read"], ["orders", "pick"], ["orders", "pack"]],
  "orders-returns": [["returns", "read"], ["returns", "process"]],
  "orders-shipping": [["orders", "read"]],
  "orders-invoices": [["invoices", "read"]],
  "orders-settings": [["orders", "write"], ["orders", "settings.read"]],

  warehouse: [["warehouse", "read"], ["warehouse", "write"]],
  "warehouse-settings": [["warehouse", "configure"], ["warehouse", "settings.read"]],

  "ebay-listings": [["products", "read"], ["products", "write"]],
  "marketplace-ebay": [["products", "read"], ["products", "write"]],
  "marketplace-kaufland": [["products", "read"], ["products", "write"]],
  "marketplace-errors": [["products", "read"], ["products", "write"]],

  finance: [["admin", "reports.read"]],
  "shop-health": [["system", "read"]],

  integrations: [["integrations", "status"]],
  "integrations-ebay": [["integrations", "read"]],
  "integrations-kaufland": [["integrations", "read"]],
  "integrations-sendcloud": [["integrations", "read"]],
  "integrations-sevdesk": [["integrations", "read"]],

  settings: [["settings", "company.read"]],
  "settings-profile": [],
  "settings-team": [["admin", "users.read"], ["admin", "roles.read"], ["admin", "groups.read"]],
  // API-Einstellungen zeigen Schluessel-Verwaltung — bewusst NICHT fuer das
  // Developer-Sichtkonto (settings.read hat nur Admin per Wildcard).
  "settings-api": [["settings", "read"]],
  "settings-billing": [["settings", "company.read"]],

  // Legacy-System-Panel (#/admin): bewusst OHNE reports.read — sonst kaeme
  // der Partner (nur Dashboard+Finanzen) in das 10-Tab-System-Panel.
  admin: [
    ["admin", "users.read"],
    ["admin", "roles.read"],
    ["admin", "groups.read"],
    ["admin", "llm.read"],
  ],
  "audit-log": [["admin", "read"]],
};

/** Alle bekannten Views — abgeleitet aus der Map, damit es keine zweite Liste gibt. */
export const ALLOWED_VIEWS: View[] = Object.keys(VIEW_PERMISSIONS) as View[];

export type PermissionCheck = (module: string, action: string) => boolean;

/** Darf der Nutzer diese Ansicht sehen? (ODER ueber die hinterlegten Paare) */
export const canAccessView = (view: View, hasPermission: PermissionCheck): boolean => {
  const required = VIEW_PERMISSIONS[view as ReachableView] as readonly PermissionPair[] | undefined;
  // Fail-closed: eine Ansicht ohne Eintrag ist ein Programmierfehler, keine
  // Freikarte (der Test erzwingt Vollstaendigkeit, das hier faengt den Rest).
  if (required === undefined) return false;
  if (required.length === 0) return true;
  return required.some(([module, action]) => hasPermission(module, action));
};
