import React, { useState, useEffect, useRef, useMemo } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../context/AuthContext";
import { Breadcrumb, type BreadcrumbItem } from "./ui/Breadcrumb";
import { HelpButton } from "./help/HelpButton";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useSystemAlerts } from "../hooks/useSystemAlerts";
import { publishGlobalSearch } from "../utils/globalSearch";
import { VIEW_BREADCRUMBS, viewTitleKey } from "../utils/viewTitles";
import type { View } from "../types";

interface TopbarProps {
  currentView: View;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNavigate?: (view: string) => void;
}

export const Topbar: React.FC<TopbarProps> = ({ currentView, theme, onToggleTheme, onNavigate }) => {
  const { t } = useI18n();
  const { user, isAdmin, hasPermission } = useAuth();
  const title = t(viewTitleKey(currentView));
  const breadcrumb = VIEW_BREADCRUMBS[currentView];
  const userInitial = user?.email?.charAt(0)?.toUpperCase() || "?";

  // HARDEN-Wave-9 (2026-05-22): Bell-Badge — polls /api/admin/alerts/recent?days=1
  // every 60s if the current user has admin access. Non-admins see no badge,
  // no API spam.
  //
  // Bis 2026-08-15 stand hier `(user as { isAdmin?: boolean })?.isAdmin`. `user`
  // ist das Firebase-User-Objekt und hat kein Feld `isAdmin` — der Cast schaltete
  // nur die Typprüfung ab. Damit war die Bedingung IMMER falsch, die Glocke
  // fragte nie ab und meldete dauerhaft "Alles ruhig". Das echte Flag liegt im
  // selben Context direkt daneben. Der Kreis deckt sich bewusst mit dem
  // Backend-Gate `requirePermission('admin','read')`.
  const { count: alertCount, latest: alertLatest, error: alertError, refresh: refreshAlerts } =
    useSystemAlerts(isAdmin || hasPermission("admin", "read"));
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bellOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [bellOpen]);

  const formatRel = (iso?: string) => {
    if (!iso) return "—";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "—";
    const diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 60) return t("topbar.rel.seconds", { n: diff });
    if (diff < 3600) return t("topbar.rel.minutes", { n: Math.round(diff / 60) });
    if (diff < 86400) return t("topbar.rel.hours", { n: Math.round(diff / 3600) });
    return t("topbar.rel.days", { n: Math.round(diff / 86400) });
  };

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
    // Speichern UND zustellen: steht der Bediener schon auf "Produkte", ist die
    // Tabelle längst aufgebaut und liest den Sitzungsspeicher nicht mehr.
    publishGlobalSearch(q);
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
                label: t(breadcrumb.parentKey),
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
            placeholder={t("topbar.searchShortcut")}
            className="w-full rounded-lg bg-app-elevated border border-app-border pl-9 pr-3 py-1.5 text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition"
            aria-label={t("topbar.searchAria")}
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
          aria-label={theme === "dark" ? t("topbar.themeLight") : t("topbar.themeDark")}
          title={theme === "dark" ? t("topbar.themeLight") : t("topbar.themeDark")}
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

        {/* Language selector */}
        <LanguageSwitcher className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors" />

        {/* Help drawer trigger */}
        <HelpButton variant="topbar" />

        {/* HARDEN-Wave-9 (2026-05-22): Bell mit Live-Badge fuer System-Alerts (admin-only) */}
        <div ref={bellRef} className="relative">
          <button
            type="button"
            onClick={() => setBellOpen((v) => !v)}
            className={`relative flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
              alertCount && alertCount > 0
                ? "text-danger hover:bg-danger-dim"
                : "text-txt-muted hover:text-txt-primary hover:bg-app-elevated"
            }`}
            aria-label={alertCount && alertCount > 0 ? t("topbar.newAlerts", { count: alertCount }) : t("topbar.notifications")}
            title={alertCount && alertCount > 0 ? t("topbar.newAlerts", { count: alertCount }) : t("topbar.notifications")}
            aria-haspopup="true"
            aria-expanded={bellOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            {alertCount !== null && alertCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white"
                aria-hidden="true"
              >
                {alertCount > 9 ? "9+" : alertCount}
              </span>
            )}
          </button>
          {bellOpen && (
            <div
              role="menu"
              className="absolute right-0 top-9 z-50 w-80 rounded-xl border border-app-border bg-app-surface shadow-xl"
            >
              <div className="flex items-center justify-between border-b border-app-border px-3 py-2">
                <h4 className="text-sm font-semibold text-txt-primary">{t("topbar.alerts.title")}</h4>
                <button
                  type="button"
                  onClick={() => {
                    setBellOpen(false);
                    window.location.hash = "#/admin";
                    onNavigate?.("admin");
                  }}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  {t("topbar.alerts.showAll")}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {/* "Noch nichts geladen" ist KEINE Entwarnung — vorher stand hier
                    `!alertCount`, was auch bei count === null zutraf und das
                    Unbekannte als "Alles ruhig" ausgab. */}
                {alertError && (
                  <div className="px-3 py-5 text-center text-sm">
                    <p className="text-warning">{t("topbar.alerts.loadError")}</p>
                    <button
                      type="button"
                      onClick={() => void refreshAlerts()}
                      className="mt-2 text-xs font-medium text-accent hover:underline"
                    >
                      {t("topbar.alerts.retry")}
                    </button>
                  </div>
                )}
                {!alertError && alertCount === null && (
                  <div className="px-3 py-6 text-center text-sm text-txt-muted">{t("topbar.alerts.loading")}</div>
                )}
                {!alertError && alertCount === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-txt-muted">
                    {t("topbar.alerts.none")}
                  </div>
                )}
                {!alertError && alertCount !== null && alertCount > 0 && alertLatest.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-txt-muted">{t("topbar.alerts.loading")}</div>
                )}
                {alertLatest.map((a) => (
                  <div
                    key={a.id}
                    className="border-b border-app-border px-3 py-2 last:border-b-0 hover:bg-app-elevated"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          a.terminalStatus === "abandoned"
                            ? "bg-danger-dim text-danger"
                            : "bg-warning-dim text-warning"
                        }`}
                      >
                        {a.terminalStatus?.toUpperCase()}
                      </span>
                      <span className="text-[11px] text-txt-muted">{t("topbar.alerts.ago", { time: formatRel(a.createdAt) })}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-txt-primary" title={a.reason}>
                      {a.reason || t("topbar.alerts.noDetail")}
                    </p>
                    {a.failureDocId && (
                      <p className="mt-0.5 font-mono text-[10px] text-txt-muted">{a.failureDocId}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

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
