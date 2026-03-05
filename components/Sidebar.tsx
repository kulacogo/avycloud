import React from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../context/AuthContext";

type View =
  | "dashboard"
  | "home"
  | "search"
  | "input"
  | "sheet"
  | "inventory"
  | "products"
  | "admin"
  | "categories"
  | "ebay-listings"
  | "warehouse"
  | "orders"
  | "operations"
  | "operations-identify"
  | "operations-stow"
  | "operations-pick"
  | "operations-pack";

interface SidebarProps {
  currentView: View;
  setView: (view: View) => void;
}

/* ─── SVG icon helper (18×18, stroke) ─── */
const Icon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 opacity-70"
    aria-hidden="true"
  >
    {children}
  </svg>
);

type NavItem = {
  view: View;
  labelKey: string;
  icon: React.ReactNode;
};

type NavSection = {
  labelKey: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: "Haupt",
    items: [
      {
        view: "dashboard",
        labelKey: "nav.dashboard",
        icon: (
          <Icon>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="4" rx="1.5" />
            <rect x="14" y="10" width="7" height="11" rx="1.5" />
            <rect x="3" y="13" width="7" height="8" rx="1.5" />
          </Icon>
        ),
      },
      {
        view: "input",
        labelKey: "nav.input",
        icon: (
          <Icon>
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M16 3h3a2 2 0 0 1 2 2v3" />
            <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            <path d="M12 8.5v7M8.5 12h7" strokeWidth="2" />
          </Icon>
        ),
      },
    ],
  },
  {
    labelKey: "Katalog",
    items: [
      {
        view: "products",
        labelKey: "nav.products",
        icon: (
          <Icon>
            <rect x="3" y="4" width="4" height="4" rx="1" />
            <path d="M10 6h11" />
            <rect x="3" y="11" width="4" height="4" rx="1" />
            <path d="M10 13h11" />
            <rect x="3" y="18" width="4" height="4" rx="1" />
            <path d="M10 20h11" />
          </Icon>
        ),
      },
      {
        view: "inventory",
        labelKey: "nav.inventory",
        icon: (
          <Icon>
            <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z" />
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            <path d="M12 12v4" />
            <path d="M2 12h20" />
          </Icon>
        ),
      },
      {
        view: "categories",
        labelKey: "nav.categories",
        icon: (
          <Icon>
            <rect x="3" y="3" width="8" height="8" rx="2" />
            <rect x="13" y="3" width="8" height="8" rx="2" />
            <rect x="3" y="13" width="8" height="8" rx="2" />
            <rect x="13" y="13" width="8" height="8" rx="2" />
          </Icon>
        ),
      },
    ],
  },
  {
    labelKey: "Lager",
    items: [
      {
        view: "warehouse",
        labelKey: "nav.warehouse",
        icon: (
          <Icon>
            <path d="M3 21V9L12 4l9 5v12H3Z" />
            <path d="M9 21v-7h6v7" />
          </Icon>
        ),
      },
      {
        view: "orders",
        labelKey: "nav.orders",
        icon: (
          <Icon>
            <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-5-5Z" />
            <path d="M16 3v5h5M8 13h8M8 17h5" />
          </Icon>
        ),
      },
      {
        view: "operations",
        labelKey: "nav.operations",
        icon: (
          <Icon>
            <circle cx="8" cy="7" r="3.5" />
            <path d="M1.5 21v-1.5A5.5 5.5 0 0 1 7 14h2a5.5 5.5 0 0 1 5.5 5.5V21" />
            <path d="M16 10a3.5 3.5 0 1 0 0-7" />
            <path d="M22 21v-1a5 5 0 0 0-4-4.9" />
          </Icon>
        ),
      },
    ],
  },
  {
    labelKey: "Marktplatz",
    items: [
      {
        view: "ebay-listings",
        labelKey: "nav.ebay",
        icon: (
          <Icon>
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="19" cy="17" r="2" />
          </Icon>
        ),
      },
    ],
  },
  {
    labelKey: "Einstellungen",
    items: [
      {
        view: "admin",
        labelKey: "nav.admin",
        icon: (
          <Icon>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </Icon>
        ),
      },
    ],
  },
];

export const Sidebar: React.FC<SidebarProps> = ({ currentView, setView }) => {
  const { t } = useI18n();
  const { user, logout, hasPermission, isAdmin } = useAuth();

  const isNavAllowed = React.useCallback(
    (view: View) => {
      if (view === "dashboard") return true;
      if (view === "inventory" || view === "products") return hasPermission("products", "read");
      if (view === "input") return hasPermission("identify", "run");
      if (view === "categories")
        return hasPermission("categories", "read") || hasPermission("categories", "write");
      if (view === "warehouse")
        return hasPermission("warehouse", "read") || hasPermission("warehouse", "write");
      if (view === "orders")
        return hasPermission("orders", "read") || hasPermission("orders", "pick") || hasPermission("orders", "pack");
      if (view === "operations" || view === "operations-identify" || view === "operations-stow" || view === "operations-pick" || view === "operations-pack") {
        return (
          hasPermission("warehouse", "read") ||
          hasPermission("warehouse", "write") ||
          hasPermission("orders", "read") ||
          hasPermission("orders", "pick") ||
          hasPermission("orders", "pack") ||
          hasPermission("identify", "run")
        );
      }
      if (view === "admin") {
        if (isAdmin) return true;
        return (
          hasPermission("admin", "users.read") ||
          hasPermission("admin", "roles.read") ||
          hasPermission("admin", "groups.read") ||
          hasPermission("admin", "llm.read") ||
          hasPermission("admin", "reports.read")
        );
      }
      if (view === "ebay-listings") {
        return hasPermission("products", "read") || hasPermission("products", "write");
      }
      return true;
    },
    [hasPermission, isAdmin]
  );

  const isActive = (view: View) => {
    if (view === "dashboard" && (currentView === "dashboard" || currentView === "home")) return true;
    if (view === "operations" && currentView.startsWith("operations")) return true;
    if (view === "inventory" && currentView === "inventory") return true;
    if (view === "products" && (currentView === "products" || currentView === "search" || currentView === "sheet")) return true;
    return currentView === view;
  };

  const handleNav = (e: React.MouseEvent, view: View) => {
    if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) return;
    e.preventDefault();
    const hash = view === "ebay-listings" ? "#/ebay" : `#/${view}`;
    window.location.hash = hash;
    setView(view);
  };

  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";
  const userName = user?.displayName || user?.email?.split("@")[0] || "User";

  return (
    <aside className="hidden md:flex flex-col w-sidebar min-w-sidebar bg-app-sidebar border-r border-app-border h-screen sticky top-0 z-50">
      {/* Logo */}
      <div className="px-4 pt-5 pb-3 flex items-center gap-2.5">
        <img src="/avy_logo.png" alt="AvyCloud" className="w-8 h-8 rounded-md object-contain" />
        <div>
          <div className="text-lg font-bold text-txt-primary leading-tight">AvyCloud</div>
          <div className="text-[10px] text-txt-muted leading-none">Product Intelligence</div>
        </div>
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto px-2 py-1"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a[href]"));
          if (!links.length) return;
          const idx = links.indexOf(document.activeElement as HTMLElement);
          let next = idx;
          if (e.key === "ArrowDown") next = idx < links.length - 1 ? idx + 1 : 0;
          else if (e.key === "ArrowUp") next = idx > 0 ? idx - 1 : links.length - 1;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = links.length - 1;
          links[next]?.focus();
        }}
      >
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) => isNavAllowed(item.view));
          if (visibleItems.length === 0) return null;
          return (
            <div key={section.labelKey}>
              <div className="text-[10px] font-semibold text-txt-muted uppercase tracking-wider px-3 pt-4 pb-1.5">
                {section.labelKey}
              </div>
              {visibleItems.map((item) => {
                const active = isActive(item.view);
                const hash = item.view === "ebay-listings" ? "#/ebay" : `#/${item.view}`;
                return (
                  <a
                    key={item.view}
                    href={hash}
                    onClick={(e) => handleNav(e, item.view)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-all cursor-pointer ${
                      active
                        ? "bg-accent-dim text-accent"
                        : "text-txt-secondary hover:bg-app-elevated hover:text-txt-primary"
                    }`}
                    aria-current={active ? "page" : undefined}
                    aria-label={t(item.labelKey)}
                  >
                    {item.icon}
                    <span>{t(item.labelKey)}</span>
                  </a>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer — User */}
      <div className="px-3 py-3 border-t border-app-border flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-semibold">
          {userInitial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-txt-primary truncate">{userName}</div>
          <div className="text-[10px] text-txt-muted truncate">{isAdmin ? "Admin" : "User"}</div>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="p-1.5 rounded-md text-txt-muted hover:text-danger hover:bg-app-elevated transition-colors"
          aria-label={t("common.logout")}
          title={t("common.logout")}
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
      </div>
    </aside>
  );
};

export default Sidebar;
