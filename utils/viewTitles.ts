/**
 * Seitentitel und Breadcrumb-Eltern der Topbar als i18n-Schlüssel.
 *
 * Bis 2026-08-16 fehlten neun Einträge. Weil die Topbar bei einem
 * unbekannten Schlüssel auf "Dashboard" zurückfällt, stand über der
 * Shop-Gesundheit, dem Aktivitätsprotokoll usw. wortwörtlich "Dashboard" —
 * die App behauptete, der Mensch sei woanders. Die Bezeichnungen sind
 * absichtlich wortgleich mit der Seitenleiste (utils/sidebarNavigation.ts),
 * damit Klick und Überschrift zusammenpassen — deshalb teilen sie sich, wo
 * der Text gleich ist, auch denselben Schlüssel.
 */
export const VIEW_TITLE_KEYS: Record<string, string> = {
  dashboard: "sidebar.item.dashboard",
  home: "sidebar.item.dashboard",
  search: "nav.search",
  input: "sidebar.item.input",
  inventory: "sidebar.item.inventory",
  products: "sidebar.section.products",
  admin: "nav.admin",
  categories: "nav.categories",
  "ebay-listings": "sidebar.item.marketplace-ebay",
  warehouse: "view.warehouse",
  "warehouse-settings": "view.warehouseSettings",
  orders: "sidebar.item.orders",
  "orders-returns": "sidebar.item.orders-returns",
  "orders-shipping": "sidebar.item.orders-shipping",
  "orders-invoices": "sidebar.item.orders-invoices",
  "orders-settings": "view.ordersSettings",
  operations: "nav.operations",
  "operations-identify": "nav.operations",
  "operations-stow": "nav.operations",
  "operations-pick": "nav.operations",
  "operations-pack": "nav.operations",
  sheet: "sidebar.section.products",
  "marketplace-ebay": "view.ebayListings",
  "marketplace-kaufland": "view.kauflandListings",
  "marketplace-errors": "sidebar.item.marketplace-errors",
  finance: "sidebar.item.finance",
  integrations: "sidebar.item.integrations",
  settings: "sidebar.item.settings",
  "settings-profile": "sidebar.item.settings-profile",
  "settings-team": "sidebar.item.settings-team",
  "settings-api": "sidebar.item.settings-api",
  "settings-billing": "sidebar.item.settings-billing",
  "shop-health": "sidebar.item.shop-health",
  duplicates: "sidebar.item.duplicates",
  pricing: "sidebar.item.pricing",
  rules: "sidebar.item.rules",
  "audit-log": "sidebar.item.audit-log",
  "integrations-ebay": "sidebar.item.marketplace-ebay",
  "integrations-kaufland": "sidebar.item.marketplace-kaufland",
  "integrations-sendcloud": "view.sendcloud",
  "integrations-sevdesk": "view.sevdesk",
};

/** Breadcrumb structure for nested views */
export const VIEW_BREADCRUMBS: Record<string, { parentKey: string; parentView: string }> = {
  "orders-returns": { parentKey: "sidebar.section.orders", parentView: "orders" },
  "orders-shipping": { parentKey: "sidebar.section.orders", parentView: "orders" },
  "orders-invoices": { parentKey: "sidebar.section.orders", parentView: "orders" },
  "orders-settings": { parentKey: "sidebar.section.orders", parentView: "orders" },
  "warehouse-settings": { parentKey: "sidebar.section.warehouse", parentView: "warehouse" },
  "marketplace-ebay": { parentKey: "sidebar.section.marketplaces", parentView: "integrations" },
  "marketplace-kaufland": { parentKey: "sidebar.section.marketplaces", parentView: "integrations" },
  "settings-profile": { parentKey: "sidebar.section.settings", parentView: "settings" },
  "settings-team": { parentKey: "sidebar.section.settings", parentView: "settings" },
  "settings-api": { parentKey: "sidebar.section.settings", parentView: "settings" },
  "settings-billing": { parentKey: "sidebar.section.settings", parentView: "settings" },
  categories: { parentKey: "sidebar.section.products", parentView: "products" },
  input: { parentKey: "sidebar.section.products", parentView: "products" },
};

/** Unbekannte Ansichten fallen wie bisher auf "Dashboard" zurück. */
export function viewTitleKey(view: string): string {
  return VIEW_TITLE_KEYS[view] || "sidebar.item.dashboard";
}
