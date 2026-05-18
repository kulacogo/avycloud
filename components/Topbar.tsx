import React, { useState, useEffect, useRef, useMemo } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../context/AuthContext";
import { Breadcrumb, type BreadcrumbItem } from "./ui/Breadcrumb";
import { HelpButton } from "./help/HelpButton";

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
  | "warehouse-settings"
  | "orders"
  | "orders-returns"
  | "orders-shipping"
  | "orders-invoices"
  | "orders-settings"
  | "operations"
  | "operations-identify"
  | "operations-stow"
  | "operations-pick"
  | "operations-pack"
  | "marketplace-ebay"
  | "marketplace-kaufland"
  | "integrations"
  | "settings"
  | "settings-profile"
  | "settings-team"
  | "settings-api"
  | "settings-billing";

interface TopbarProps {
  currentView: View;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate?: (view: string) => void;
}

const VIEW_TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  home: "Dashboard",
  search: "Suche",
  input: "Erfassen",
  inventory: "Inventar",
  products: "Produkte",
  admin: "Admin",
  categories: "Kategorien",
  "ebay-listings": "eBay",
  warehouse: "Lagerverwaltung",
  "warehouse-settings": "Lager-Einstellungen",
  orders: "Bestellungen",
  "orders-returns": "Retouren",
  "orders-shipping": "Versand & Labels",
  "orders-invoices": "Rechnungen",
  "orders-settings": "Auftrags-Einstellungen",
  operations: "Operationen",
  "operations-identify": "Operationen",
  "operations-stow": "Operationen",
  "operations-pick": "Operationen",
  "operations-pack": "Operationen",
  sheet: "Produkte",
  "marketplace-ebay": "eBay Listings",
  "marketplace-kaufland": "Kaufland Listings",
  integrations: "Integrationen",
  settings: "Unternehmensdaten",
  "settings-profile": "Persönliche Daten",
  "settings-team": "Mitarbeiter & Rollen",
  "settings-api": "API",
  "settings-billing": "Plan & Abrechnung",
};

/* Breadcrumb structure for nested views */
const VIEW_BREADCRUMBS: Record<string, { parent: string; parentView: string }> = {
  "orders-returns": { parent: "Aufträge", parentView: "orders" },
  "orders-shipping": { parent: "Aufträge", parentView: "orders" },
  "orders-invoices": { parent: "Aufträge", parentView: "orders" },
  "orders-settings": { parent: "Aufträge", parentView: "orders" },
  "warehouse-settings": { parent: "Lager", parentView: "warehouse" },
  "marketplace-ebay": { parent: "Marktplätze", parentView: "integrations" },
  "marketplace-kaufland": { parent: "Marktplätze", parentView: "integrations" },
  "settings-profile": { parent: "Einstellungen", parentView: "settings" },
  "settings-team": { parent: "Einstellungen", parentView: "settings" },
  "settings-api": { parent: "Einstellungen", parentView: "settings" },
  "settings-billing": { parent: "Einstellungen", parentView: "settings" },
  categories: { parent: "Produkte", parentView: "products" },
  input: { parent: "Produkte", parentView: "products" },
};

export const Topbar: React.FC<TopbarProps> = ({ currentView, theme, onToggleTheme, onNavigate }) => {
  const { t } = useI18n();
  const { user } = useAuth();
  const title = VIEW_TITLES[currentView] || "Dashboard";
  const breadcrumb = VIEW_BREADCRUMBS[currentView];
  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";

  const [searchValue, setSearchValue] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchValue.trim();
    if (!q) return;
    window.sessionStorage.setItem("avystock:admin-table:search", q);
    window.location.hash = "#/products";
    onNavigate?.("products");
    setSearchValue("");
  };

  return (
    <header className="h-14 min-h-[56px] bg-app-bg border-b border-app-border flex items-center px-6 gap-4 sticky top-0 z-40">
      {/* Page title / Breadcrumb */}
      <div className="flex items-center min-w-0">
        {breadcrumb ? (
          <Breadcrumb
            items={[
              {
                label: breadcrumb.parent,
                onClick: () => {
                  window.location.hash = `#/${breadcrumb.parentView}`;
                  onNavigate?.(breadcrumb.parentView);
                },
              },
              { label: title },
            ]}
          />
        ) : (
          <h1 className="text-lg font-semibold text-txt-primary whitespace-nowrap">{title}</h1>
        )}
      </div>

      {/* Search field */}
      <form onSubmit={handleSearchSubmit} className="flex-1 max-w-[480px] mx-auto hidden md:block">
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
            ref={searchRef}
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Suche... (Ctrl+K)"
            className="w-full rounded-lg bg-app-elevated border border-app-border pl-9 pr-3 py-1.5 text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition"
            aria-label="Globale Suche"
          />
        </div>
      </form>

      <div className="flex-1 md:hidden" />

      {/* Right side actions */}
      <div className="flex items-center gap-1">
        {/* Theme toggle */}
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
          aria-label={theme === "dark" ? "Helles Design" : "Dunkles Design"}
          title={theme === "dark" ? "Helles Design" : "Dunkles Design"}
        >
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
            </svg>
          )}
        </button>

        {/* Help drawer trigger */}
        <HelpButton variant="topbar" />

        {/* Notification bell (placeholder) */}
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
          aria-label="Benachrichtigungen"
          title="Benachrichtigungen"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </button>

        {/* User avatar */}
        <div
          className="hidden sm:flex items-center justify-center w-8 h-8 rounded-full bg-accent text-white text-xs font-semibold cursor-default"
          title={user?.email || ""}
        >
          {userInitial}
        </div>
      </div>
    </header>
  );
};

export default Topbar;
