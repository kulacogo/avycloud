import React, { useState, useCallback, useEffect } from "react";
import { useAuth } from "../context/AuthContext";

export type View =
  | "dashboard"
  | "home"
  | "search"
  | "admin"
  | "categories"
  | "operations"
  | "operations-identify"
  | "operations-stow"
  | "operations-pick"
  | "operations-pack"
  | "input"
  | "sheet"
  | "inventory"
  | "products"
  | "orders"
  | "orders-returns"
  | "orders-shipping"
  | "orders-invoices"
  | "orders-settings"
  | "warehouse"
  | "warehouse-settings"
  | "marketplace-ebay"
  | "marketplace-kaufland"
  | "integrations"
  | "settings"
  | "settings-profile"
  | "settings-team"
  | "settings-api"
  | "settings-billing"
  | "ebay-listings"
  | "duplicates"
  | "audit-log";

interface SidebarProps {
  currentView: View;
  setView: (view: View) => void;
}

/* ─── localStorage helpers for collapsed state ─── */
const SIDEBAR_COLLAPSED_KEY = "avycloud:sidebar:collapsed";
const SECTIONS_COLLAPSED_KEY = "avycloud:sidebar:sections";

const readCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
};

const readSectionsCollapsed = (): Record<string, boolean> => {
  try {
    const raw = window.localStorage.getItem(SECTIONS_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

/* ─── SVG icon helper (18×18, stroke) ─── */
const Icon: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className || "shrink-0"}
    aria-hidden="true"
  >
    {children}
  </svg>
);

/* ─── Icon definitions ─── */
const icons = {
  dashboard: (
    <Icon>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="4" rx="1.5" />
      <rect x="14" y="10" width="7" height="11" rx="1.5" />
      <rect x="3" y="13" width="7" height="8" rx="1.5" />
    </Icon>
  ),
  orders: (
    <Icon>
      <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M16 3v5h5M8 13h8M8 17h5" />
    </Icon>
  ),
  returns: (
    <Icon>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  ),
  truck: (
    <Icon>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 13.52 9H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Icon>
  ),
  fileText: (
    <Icon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Icon>
  ),
  sliders: (
    <Icon>
      <line x1="4" x2="4" y1="21" y2="14" />
      <line x1="4" x2="4" y1="10" y2="3" />
      <line x1="12" x2="12" y1="21" y2="12" />
      <line x1="12" x2="12" y1="8" y2="3" />
      <line x1="20" x2="20" y1="21" y2="16" />
      <line x1="20" x2="20" y1="12" y2="3" />
      <line x1="2" x2="6" y1="14" y2="14" />
      <line x1="10" x2="14" y1="8" y2="8" />
      <line x1="18" x2="22" y1="16" y2="16" />
    </Icon>
  ),
  package: (
    <Icon>
      <path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />
    </Icon>
  ),
  warehouse: (
    <Icon>
      <path d="M3 21V9L12 4l9 5v12H3Z" />
      <path d="M9 21v-7h6v7" />
    </Icon>
  ),
  scanLine: (
    <Icon>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      <path d="M12 8.5v7M8.5 12h7" strokeWidth="2" />
    </Icon>
  ),
  mapPin: (
    <Icon>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </Icon>
  ),
  shoppingBag: (
    <Icon>
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <path d="M3 6h18M16 10a4 4 0 0 1-8 0" />
    </Icon>
  ),
  store: (
    <Icon>
      <path d="M2 7l1.41-2.83A2 2 0 0 1 5.2 3h13.6a2 2 0 0 1 1.79 1.11L22 7" />
      <path d="M2 7h20v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Z" />
      <path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8" />
      <path d="M10 21v-5a2 2 0 0 1 4 0v5" />
    </Icon>
  ),
  plug: (
    <Icon>
      <path d="M12 22v-5" />
      <path d="M9 8V1h6v7" />
      <path d="M7 8h10a3 3 0 0 1 3 3v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-2a3 3 0 0 1 3-3Z" />
    </Icon>
  ),
  building: (
    <Icon>
      <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
      <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01" />
    </Icon>
  ),
  user: (
    <Icon>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  ),
  users: (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  code: (
    <Icon>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Icon>
  ),
  creditCard: (
    <Icon>
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </Icon>
  ),
  chevronDown: (
    <Icon className="shrink-0 w-3.5 h-3.5 transition-transform duration-150">
      <path d="M6 9l6 6 6-6" />
    </Icon>
  ),
  chevronLeft: (
    <Icon className="shrink-0 w-4 h-4">
      <path d="M15 18l-6-6 6-6" />
    </Icon>
  ),
  chevronRight: (
    <Icon className="shrink-0 w-4 h-4">
      <path d="M9 18l6-6-6-6" />
    </Icon>
  ),
  layers: (
    <Icon>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.84Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </Icon>
  ),
  logout: (
    <Icon>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </Icon>
  ),
};

/* ─── Nav item types ─── */
type NavItem = {
  view: View;
  label: string;
  icon: React.ReactNode;
  children?: { view: View; label: string }[];
};

type NavSection = {
  id: string;
  label: string;
  collapsible: boolean;
  items: NavItem[];
};

/* ─── View → hash path mapping ─── */
const viewToHash = (view: View): string => {
  const map: Partial<Record<View, string>> = {
    "orders-returns": "#/orders/returns",
    "orders-shipping": "#/orders/shipping",
    "orders-invoices": "#/orders/invoices",
    "orders-settings": "#/orders/settings",
    "warehouse-settings": "#/warehouse/settings",
    "marketplace-ebay": "#/marketplace/ebay",
    "marketplace-kaufland": "#/marketplace/kaufland",
    "settings-profile": "#/settings/profile",
    "settings-team": "#/settings/team",
    "settings-api": "#/settings/api",
    "settings-billing": "#/settings/billing",
    "ebay-listings": "#/marketplace/ebay",
  };
  return map[view] || `#/${view}`;
};

/* ─── Active state detection ─── */
const isViewActive = (current: View, target: View): boolean => {
  if (current === target) return true;
  if (target === "dashboard" && current === "home") return true;
  if (target === "products" && (current === "products" || current === "search" || current === "sheet")) return true;
  if (target === "orders" && current === "orders") return true;
  return false;
};

const isGroupActive = (current: View, item: NavItem): boolean => {
  if (isViewActive(current, item.view)) return true;
  if (item.children?.some((c) => current === c.view)) return true;
  return false;
};

export const Sidebar: React.FC<SidebarProps> = ({ currentView, setView }) => {
  const { user, logout, hasPermission, isAdmin } = useAuth();
  const [collapsed, setCollapsed] = useState(() => readCollapsed());
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>(() => readSectionsCollapsed());

  // Persist collapsed state
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SECTIONS_COLLAPSED_KEY, JSON.stringify(sectionsCollapsed));
    } catch { /* ignore */ }
  }, [sectionsCollapsed]);

  const toggleSection = useCallback((id: string) => {
    setSectionsCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleNav = useCallback(
    (e: React.MouseEvent, view: View) => {
      if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) return;
      e.preventDefault();
      window.location.hash = viewToHash(view);
      setView(view);
    },
    [setView]
  );

  /* ─── Permission checks ─── */
  const canSeeOrders = hasPermission("orders", "read") || hasPermission("orders", "pick") || hasPermission("orders", "pack");
  const canSeeProducts = hasPermission("products", "read");
  const canSeeWarehouse = hasPermission("warehouse", "read") || hasPermission("warehouse", "write");
  const canSeeIdentify = hasPermission("identify", "run");
  const canSeeAdmin = isAdmin || hasPermission("admin", "users.read") || hasPermission("admin", "roles.read");

  /* ─── Navigation structure ─── */
  const sections: NavSection[] = [
    // Dashboard (standalone, no section header)
    {
      id: "main",
      label: "",
      collapsible: false,
      items: [
        { view: "dashboard", label: "Dashboard", icon: icons.dashboard },
      ],
    },
    // AUFTRÄGE
    ...(canSeeOrders
      ? [
          {
            id: "orders",
            label: "AUFTRÄGE",
            collapsible: true,
            items: [
              { view: "orders" as View, label: "Bestellungen", icon: icons.orders },
              { view: "orders-returns" as View, label: "Retouren", icon: icons.returns },
              { view: "orders-shipping" as View, label: "Versand & Labels", icon: icons.truck },
              { view: "orders-invoices" as View, label: "Rechnungen", icon: icons.fileText },
              {
                view: "orders-settings" as View,
                label: "Einstellungen",
                icon: icons.sliders,
              },
            ],
          },
        ]
      : []),
    // PRODUKTE
    ...(canSeeProducts || canSeeIdentify
      ? [
          {
            id: "products",
            label: "PRODUKTE",
            collapsible: true,
            items: [
              ...(canSeeProducts
                ? [
                    { view: "products" as View, label: "Produktdaten", icon: icons.package },
                    { view: "inventory" as View, label: "Inventar", icon: icons.warehouse },
                  ]
                : []),
              ...(canSeeIdentify
                ? [{ view: "input" as View, label: "Erfassen", icon: icons.scanLine }]
                : []),
              ...(canSeeProducts
                ? [{ view: "duplicates" as View, label: "Duplikate", icon: icons.layers }]
                : []),
            ],
          },
        ]
      : []),
    // LAGER
    ...(canSeeWarehouse
      ? [
          {
            id: "warehouse",
            label: "LAGER",
            collapsible: true,
            items: [
              { view: "warehouse" as View, label: "Verwaltung", icon: icons.mapPin },
              { view: "warehouse-settings" as View, label: "Einstellungen", icon: icons.sliders },
            ],
          },
        ]
      : []),
    // MARKTPLÄTZE (dynamic — show only connected ones)
    // For now, show eBay always (it's connected). Kaufland can be added when connected.
    ...(canSeeProducts
      ? [
          {
            id: "marketplaces",
            label: "MARKTPLÄTZE",
            collapsible: true,
            items: [
              { view: "marketplace-ebay" as View, label: "eBay", icon: icons.shoppingBag },
              { view: "marketplace-kaufland" as View, label: "Kaufland", icon: icons.store },
            ],
          },
        ]
      : []),
    // Integrationen (standalone)
    {
      id: "integrations",
      label: "",
      collapsible: false,
      items: [
        { view: "integrations" as View, label: "Integrationen", icon: icons.plug },
      ],
    },
    // EINSTELLUNGEN
    ...(canSeeAdmin
      ? [
          {
            id: "settings",
            label: "EINSTELLUNGEN",
            collapsible: true,
            items: [
              { view: "settings" as View, label: "Unternehmensdaten", icon: icons.building },
              { view: "settings-profile" as View, label: "Persönliche Daten", icon: icons.user },
              { view: "settings-team" as View, label: "Mitarbeiter & Rollen", icon: icons.users },
              { view: "settings-api" as View, label: "API", icon: icons.code },
              { view: "settings-billing" as View, label: "Plan & Abrechnung", icon: icons.creditCard },
              { view: "audit-log" as View, label: "Aktivitätsprotokoll", icon: icons.fileText },
            ],
          },
        ]
      : []),
  ];

  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";
  const userName = user?.displayName || user?.email?.split("@")[0] || "User";

  return (
    <aside
      className={`hidden md:flex flex-col bg-app-sidebar border-r border-app-border h-screen sticky top-0 z-50 transition-[width] duration-200 ${
        collapsed ? "w-16 min-w-16" : "w-[240px] min-w-[240px]"
      }`}
    >
      {/* Header — Logo + Collapse toggle */}
      <div className="px-3 pt-4 pb-2 flex items-center justify-between">
        <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center w-full" : ""}`}>
          <img src="/avycloud_logo_icon.png" alt="AvyCloud" className="w-9 h-9 rounded-lg object-contain shrink-0" />
          {!collapsed && (
            <>
              <img src="/avycloud_logo_name_darkmode.png" alt="AvyCloud" className="h-8 object-contain logo-dark" />
              <img src="/avycloud_logo_name.png" alt="AvyCloud" className="h-8 object-contain logo-light" />
            </>
          )}
        </div>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="p-1 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
            aria-label="Sidebar einklappen"
          >
            {icons.chevronLeft}
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="p-1 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
            aria-label="Sidebar ausklappen"
          >
            {icons.chevronRight}
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {sections.map((section) => {
          if (section.items.length === 0) return null;
          const isSectionCollapsed = sectionsCollapsed[section.id] === true;
          const hasActiveItem = section.items.some((item) => isGroupActive(currentView, item));

          return (
            <div key={section.id} className={section.label ? "mt-4" : "mt-1"}>
              {/* Section header (collapsible) */}
              {section.label && !collapsed && (
                <button
                  type="button"
                  onClick={() => section.collapsible && toggleSection(section.id)}
                  className="w-full flex items-center justify-between px-3 pt-1 pb-1.5 group"
                >
                  <span className="text-[11px] font-semibold text-txt-muted uppercase tracking-[0.05em]">
                    {section.label}
                  </span>
                  {section.collapsible && (
                    <span
                      className={`text-txt-muted/50 group-hover:text-txt-muted transition-transform duration-150 ${
                        isSectionCollapsed ? "-rotate-90" : ""
                      }`}
                    >
                      {icons.chevronDown}
                    </span>
                  )}
                </button>
              )}

              {/* Section label in collapsed mode — just a divider line */}
              {section.label && collapsed && (
                <div className="mx-2 my-2 border-t border-app-border/60" />
              )}

              {/* Nav items */}
              {(!isSectionCollapsed || collapsed) &&
                section.items.map((item) => {
                  const active = isViewActive(currentView, item.view);
                  const hash = viewToHash(item.view);

                  return (
                    <a
                      key={item.view}
                      href={hash}
                      onClick={(e) => handleNav(e, item.view)}
                      className={`relative flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-all cursor-pointer ${
                        collapsed ? "justify-center px-0 py-2.5 mx-1" : "px-3 py-[9px]"
                      } ${
                        active
                          ? "bg-accent/[0.08] text-accent"
                          : "text-txt-secondary hover:bg-app-elevated hover:text-txt-primary"
                      }`}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? item.label : undefined}
                    >
                      {/* Active indicator — left accent border */}
                      {active && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent"
                          aria-hidden="true"
                        />
                      )}
                      <span className={active ? "text-accent" : "text-txt-muted"}>
                        {item.icon}
                      </span>
                      {!collapsed && <span>{item.label}</span>}
                    </a>
                  );
                })}
            </div>
          );
        })}
      </nav>

      {/* Footer — User */}
      <div className={`border-t border-app-border ${collapsed ? "px-2 py-3" : "px-3 py-3"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5"}`}>
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-semibold shrink-0">
            {userInitial}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-txt-primary truncate">{userName}</div>
                <div className="text-[10px] text-txt-muted truncate">{isAdmin ? "Admin" : "User"}</div>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="p-1.5 rounded-md text-txt-muted hover:text-danger hover:bg-app-elevated transition-colors"
                aria-label="Abmelden"
                title="Abmelden"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
