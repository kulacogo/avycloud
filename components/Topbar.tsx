import React, { useState } from "react";
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

interface TopbarProps {
  currentView: View;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate?: (view: string) => void;
}

const VIEW_TITLES: Record<string, string> = {
  dashboard: "nav.dashboard",
  home: "nav.dashboard",
  search: "nav.search",
  input: "nav.input",
  inventory: "nav.inventory",
  products: "nav.products",
  admin: "nav.admin",
  categories: "nav.categories",
  "ebay-listings": "nav.ebay",
  warehouse: "nav.warehouse",
  orders: "nav.orders",
  operations: "nav.operations",
  "operations-identify": "nav.operations",
  "operations-stow": "nav.operations",
  "operations-pick": "nav.operations",
  "operations-pack": "nav.operations",
  sheet: "nav.products",
};

export const Topbar: React.FC<TopbarProps> = ({ currentView, theme, onToggleTheme, onNavigate }) => {
  const { t } = useI18n();
  const { user } = useAuth();
  const titleKey = VIEW_TITLES[currentView] || "nav.dashboard";
  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";

  const [searchValue, setSearchValue] = useState("");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchValue.trim();
    if (!q) return;
    // Write to sessionStorage so AdminTable picks it up
    window.sessionStorage.setItem("avystock:admin-table:search", q);
    window.location.hash = "#/products";
    onNavigate?.("products");
    setSearchValue("");
  };

  return (
    <header className="h-topbar min-h-topbar bg-app-surface border-b border-app-border flex items-center px-6 gap-4 sticky top-0 z-40">
      {/* Page title */}
      <h1 className="text-lg font-bold text-txt-primary whitespace-nowrap">{t(titleKey)}</h1>

      {/* Search field */}
      <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md mx-auto hidden md:block">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted pointer-events-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder={t("topbar.searchPlaceholder")}
            className="w-full rounded-lg bg-app-elevated border border-app-border pl-9 pr-3 py-1.5 text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition"
            aria-label={t("topbar.searchPlaceholder")}
          />
        </div>
      </form>

      <div className="flex-1 md:hidden" />

      {/* Language selector removed — app is German-only. i18n infra kept for future use. */}

      {/* Settings gear */}
      <button
        type="button"
        onClick={() => {
          window.location.hash = "#/admin";
          onNavigate?.("admin");
        }}
        className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
        aria-label={t("nav.admin")}
        title={t("nav.admin")}
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
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={onToggleTheme}
        className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
        aria-label={theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
        title={theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
      >
        {theme === "dark" ? (
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
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
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
            <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
          </svg>
        )}
      </button>

      {/* User avatar (desktop) */}
      <div
        className="hidden sm:flex items-center justify-center w-8 h-8 rounded-full bg-accent text-white text-xs font-semibold"
        title={user?.email || ""}
      >
        {userInitial}
      </div>
    </header>
  );
};

export default Topbar;
