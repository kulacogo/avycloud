import React from "react";
import { useI18n, type Locale } from "../i18n";
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
  | "operations"
  | "operations-identify"
  | "operations-stow"
  | "operations-pick"
  | "operations-pack";

interface TopbarProps {
  currentView: View;
  theme: "light" | "dark";
  onToggleTheme: () => void;
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
  operations: "nav.operations",
  "operations-identify": "nav.operations",
  "operations-stow": "nav.operations",
  "operations-pick": "nav.operations",
  "operations-pack": "nav.operations",
  sheet: "nav.products",
};

const LOCALE_LABELS: Record<Locale, string> = {
  de: "DE",
  en: "EN",
  tr: "TR",
};

const LOCALES: Locale[] = ["de", "en", "tr"];

export const Topbar: React.FC<TopbarProps> = ({ currentView, theme, onToggleTheme }) => {
  const { t, locale, setLocale } = useI18n();
  const { user } = useAuth();
  const titleKey = VIEW_TITLES[currentView] || "nav.dashboard";

  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";

  return (
    <header className="h-topbar min-h-topbar bg-app-surface border-b border-app-border flex items-center px-6 gap-4 sticky top-0 z-40">
      {/* Page title */}
      <h1 className="text-lg font-bold text-txt-primary">{t(titleKey)}</h1>

      <div className="flex-1" />

      {/* Language selector */}
      <div className="hidden sm:flex items-center gap-0.5 bg-app-elevated rounded-md p-0.5">
        {LOCALES.map((loc) => (
          <button
            key={loc}
            type="button"
            onClick={() => setLocale(loc)}
            className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
              locale === loc
                ? "bg-accent text-white"
                : "text-txt-muted hover:text-txt-primary"
            }`}
            aria-label={`${t("lang.label")}: ${LOCALE_LABELS[loc]}`}
          >
            {LOCALE_LABELS[loc]}
          </button>
        ))}
      </div>

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
