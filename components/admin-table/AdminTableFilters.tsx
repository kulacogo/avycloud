import React from "react";
import { Readiness, ColumnDefinition, ColumnId, ColumnPreset, ProductBulkActionName } from "./types";

const COLUMN_PRESETS: Record<ColumnPreset, ColumnId[]> = {
  standard: [
    "thumbnail",
    "nameBrand",
    "sku",
    "barcode",
    "category",
    "price",
    "inventory",
    "pendingIntake",
    "storage",
    "ebay",
    "kaufland",
    "readiness",
    "lastSaved",
  ],
  warehouse: [
    "nameBrand",
    "sku",
    "barcode",
    "inventory",
    "pendingIntake",
    "storage",
    "ebay",
    "kaufland",
    "readiness",
    "saveStatus",
  ],
  pricing: [
    "nameBrand",
    "price",
    "sku",
    "barcode",
    "pendingIntake",
    "ebay",
    "kaufland",
    "readiness",
    "lastSynced",
  ],
  minimal: [
    "nameBrand",
    "sku",
    "barcode",
    "inventory",
    "pendingIntake",
    "ebay",
    "kaufland",
    "readiness",
  ],
};

interface CategoryNode {
  top: string;
  count: number;
  children: Array<{ sub: string; count: number }>;
}

interface AdminTableFiltersProps {
  // Status filter
  filterStatus: Readiness | "all" | "empty";
  setFilterStatus: (v: Readiness | "all" | "empty") => void;
  statusFilters: Array<{ value: Readiness | "all" | "empty"; label: string }>;

  // Category filter
  filterCategorySelection: string[];
  setFilterCategorySelection: (v: string[]) => void;
  categoryTree: CategoryNode[];
  categorySelectionSet: Set<string>;
  categoryFilterOpen: boolean;
  setCategoryFilterOpen: (v: boolean) => void;
  isCategorySelected: (key: string) => boolean;
  toggleCategoryKey: (key: string) => void;
  toggleTopCategory: (top: string) => void;

  // Bin filter
  filterBin: "all" | "withBin" | "withoutBin";
  setFilterBin: (v: "all" | "withBin" | "withoutBin") => void;

  // Advanced filters
  filterEanValid: "all" | "valid" | "invalid" | "missing";
  setFilterEanValid: (v: "all" | "valid" | "invalid" | "missing") => void;
  filterGpsr: "all" | "complete" | "incomplete";
  setFilterGpsr: (v: "all" | "complete" | "incomplete") => void;
  filterEbay: "all" | "listed" | "notListed";
  setFilterEbay: (v: "all" | "listed" | "notListed") => void;
  filterKaufland: "all" | "listed" | "notListed";
  setFilterKaufland: (v: "all" | "listed" | "notListed") => void;
  filterWeight: "all" | "withWeight" | "noWeight";
  setFilterWeight: (v: "all" | "withWeight" | "noWeight") => void;
  filterReserved: "all" | "reserved" | "notReserved";
  setFilterReserved: (v: "all" | "reserved" | "notReserved") => void;
  filterSold: "all" | "sold" | "unsold";
  setFilterSold: (v: "all" | "sold" | "unsold") => void;

  // Editor (Bearbeiter) filter
  filterEditor: string[];
  setFilterEditor: (v: string[]) => void;
  editorOptions: Array<{ value: string; count: number }>;
  editorSelectionSet: Set<string>;
  toggleEditor: (value: string) => void;
  editorFilterOpen: boolean;
  setEditorFilterOpen: (v: boolean) => void;
  myInitials: string;
  isMyItemsActive: boolean;
  toggleMyItems: () => void;
  editorNoneSentinel: string;

  // Column presets & visibility
  columnPreset: ColumnPreset;
  setColumnPreset: (v: ColumnPreset) => void;
  visibleColumns: ColumnId[];
  setVisibleColumns: (v: ColumnId[]) => void;
  columnDefinitions: ColumnDefinition[];
  isColumnPanelOpen: boolean;
  setIsColumnPanelOpen: (v: boolean) => void;
  toggleColumnVisibility: (id: ColumnId) => void;
  moveColumn: (id: ColumnId, direction: "up" | "down") => void;
  resetColumns: () => void;
  normalizeMarketplaceColumnOrder: (columns: ColumnId[]) => ColumnId[];

  // Tools menu
  mode: "inventory" | "products" | "all";
  handleExportCsv: () => void;
  onBulkImprove?: () => void;
  enqueueBulkForAllInCurrentMode: (
    action: ProductBulkActionName,
    opts?: { apply?: boolean }
  ) => Promise<void>;
  setKtypeModalOpen: (v: boolean) => void;
  setKtypeFile: (v: File | null) => void;
  setKtypeReport: (v: any) => void;
  setKtypeMessage: (v: string | null) => void;
  setConfirmDialog: (
    v: {
      title: string;
      description?: React.ReactNode;
      details?: React.ReactNode;
      confirmLabel: string;
      tone?: "default" | "danger";
      confirmBusy?: boolean;
      onConfirm: () => void | Promise<void>;
    } | null
  ) => void;

  // i18n
  t: (key: string) => string;
}

const filterControlClass =
  "p-2 text-sm bg-app-surface border border-app-border rounded-xl text-txt-primary";
const filterButtonClass =
  "w-full p-2 text-sm bg-app-surface border border-app-border rounded-xl text-txt-primary text-left";
const menuItemClass =
  "w-full text-left px-3 py-2 text-sm text-txt-primary hover:bg-app-elevated/60 rounded-xl transition";

const AdminTableFilters: React.FC<AdminTableFiltersProps> = ({
  filterStatus,
  setFilterStatus,
  statusFilters,
  filterCategorySelection,
  setFilterCategorySelection,
  categoryTree,
  categorySelectionSet,
  categoryFilterOpen,
  setCategoryFilterOpen,
  isCategorySelected,
  toggleCategoryKey,
  toggleTopCategory,
  filterBin,
  setFilterBin,
  filterEanValid,
  setFilterEanValid,
  filterGpsr,
  setFilterGpsr,
  filterEbay,
  setFilterEbay,
  filterKaufland,
  setFilterKaufland,
  filterWeight,
  setFilterWeight,
  filterReserved,
  setFilterReserved,
  filterSold,
  setFilterSold,
  filterEditor,
  setFilterEditor,
  editorOptions,
  editorSelectionSet,
  toggleEditor,
  editorFilterOpen,
  setEditorFilterOpen,
  myInitials,
  isMyItemsActive,
  toggleMyItems,
  editorNoneSentinel,
  columnPreset,
  setColumnPreset,
  visibleColumns,
  setVisibleColumns,
  columnDefinitions,
  isColumnPanelOpen,
  setIsColumnPanelOpen,
  toggleColumnVisibility,
  moveColumn,
  resetColumns,
  normalizeMarketplaceColumnOrder,
  mode,
  handleExportCsv,
  onBulkImprove,
  enqueueBulkForAllInCurrentMode,
  setKtypeModalOpen,
  setKtypeFile,
  setKtypeReport,
  setKtypeMessage,
  setConfirmDialog,
  t,
}) => {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <select
          id="table-filter-status"
          value={filterStatus}
          onChange={(e) =>
            setFilterStatus(e.target.value as Readiness | "all")
          }
          className={filterControlClass}
        >
          {statusFilters.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="relative">
          <button
            type="button"
            onClick={() => setCategoryFilterOpen(!categoryFilterOpen)}
            aria-expanded={categoryFilterOpen}
            className={filterButtonClass}
          >
            {filterCategorySelection.length === 0
              ? "Kategorie: Alle"
              : `Kategorie: ${filterCategorySelection.length} ausgewählt`}
          </button>
          {categoryFilterOpen && (
            <div className="absolute z-30 mt-2 w-[360px] max-w-[90vw] rounded-xl border border-app-border bg-app-bg p-3 shadow-lg">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">
                  Kategorien
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFilterCategorySelection([])}
                    className="text-xs text-accent hover:underline"
                  >
                    Alle
                  </button>
                  <button
                    type="button"
                    onClick={() => setCategoryFilterOpen(false)}
                    className="text-xs text-txt-secondary hover:underline"
                  >
                    Schließen
                  </button>
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                {categoryTree.map((node) => {
                  const topKey = node.top;
                  const childKeys = node.children.map(
                    (c) => `${node.top} > ${c.sub}`
                  );
                  const allKeys = [topKey, ...childKeys];
                  const selectedCount = allKeys.filter((k) =>
                    categorySelectionSet.has(k)
                  ).length;
                  const isAllSelected =
                    selectedCount === allKeys.length && allKeys.length > 0;
                  const isIndeterminate =
                    selectedCount > 0 && selectedCount < allKeys.length;
                  return (
                    <div
                      key={node.top}
                      className="rounded-xl border border-app-border bg-app-surface"
                    >
                      <label className="flex items-center gap-2 px-2 py-2 text-sm text-txt-primary">
                        <input
                          type="checkbox"
                          checked={isAllSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = isIndeterminate;
                          }}
                          onChange={() => toggleTopCategory(node.top)}
                        />
                        <span className="flex-1">{node.top}</span>
                        <span className="text-xs text-txt-muted">
                          ({node.count})
                        </span>
                      </label>
                      {node.children.length > 0 && (
                        <div className="border-t border-app-border px-2 py-2 space-y-1">
                          {node.children.map((c) => {
                            const key = `${node.top} > ${c.sub}`;
                            return (
                              <label
                                key={key}
                                className="flex items-center gap-2 pl-5 pr-2 py-1 text-sm text-txt-secondary"
                              >
                                <input
                                  type="checkbox"
                                  checked={isCategorySelected(key)}
                                  onChange={() => toggleCategoryKey(key)}
                                />
                                <span className="flex-1">{c.sub}</span>
                                <span className="text-xs text-txt-muted">
                                  ({c.count})
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={toggleMyItems}
            disabled={!myInitials}
            aria-pressed={isMyItemsActive}
            title={t("table.editor.title")}
            className={
              isMyItemsActive
                ? "px-3 py-2 text-sm rounded-xl border border-accent bg-accent-dim text-accent whitespace-nowrap"
                : `${filterButtonClass} w-auto whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed`
            }
          >
            {t("table.editor.mine")}
          </button>
          <div className="relative flex-1 min-w-[180px]">
            <button
              type="button"
              onClick={() => setEditorFilterOpen(!editorFilterOpen)}
              aria-expanded={editorFilterOpen}
              className={filterButtonClass}
            >
              {filterEditor.length === 0
                ? `${t("table.editor.label")}: ${t("table.editor.all")}`
                : `${t("table.editor.label")}: ${filterEditor.length}`}
            </button>
            {editorFilterOpen && (
              <div className="absolute z-30 mt-2 w-[280px] max-w-[90vw] rounded-xl border border-app-border bg-app-bg p-3 shadow-lg">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">
                    {t("table.editor.label")}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFilterEditor([])}
                      className="text-xs text-accent hover:underline"
                    >
                      {t("table.editor.all")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorFilterOpen(false)}
                      className="text-xs text-txt-secondary hover:underline"
                    >
                      Schließen
                    </button>
                  </div>
                </div>
                {editorOptions.length === 0 ? (
                  <p className="text-xs text-txt-muted px-1 py-2">—</p>
                ) : (
                  <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                    {editorOptions.map((opt) => {
                      const isNone = opt.value === editorNoneSentinel;
                      const isMe = opt.value === myInitials;
                      const label = isNone
                        ? t("table.editor.none")
                        : isMe
                          ? `${opt.value} ${t("table.editor.you")}`
                          : opt.value;
                      return (
                        <label
                          key={opt.value}
                          className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-2 py-2 text-sm text-txt-primary"
                        >
                          <input
                            type="checkbox"
                            checked={editorSelectionSet.has(opt.value)}
                            onChange={() => toggleEditor(opt.value)}
                          />
                          <span className="flex-1">{label}</span>
                          <span className="text-xs text-txt-muted">({opt.count})</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <select
          id="table-filter-bin"
          value={filterBin}
          onChange={(e) =>
            setFilterBin(e.target.value as "all" | "withBin" | "withoutBin")
          }
          className={filterControlClass}
        >
          <option value="all">{t("table.binFilter.all")}</option>
          <option value="withBin">{t("table.binFilter.withBin")}</option>
          <option value="withoutBin">{t("table.binFilter.withoutBin")}</option>
        </select>
      </div>

      <div className="rounded-xl border border-app-border bg-app-surface p-3 space-y-3">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
          Erweiterte Filter
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <select
            id="table-filter-ean-valid"
            value={filterEanValid}
            onChange={(e) => setFilterEanValid(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">EAN/GTIN: Alle</option>
            <option value="valid">Gültige EAN/GTIN</option>
            <option value="invalid">Ungültige EAN/GTIN</option>
            <option value="missing">Keine EAN/GTIN</option>
          </select>
          <select
            id="table-filter-gpsr"
            value={filterGpsr}
            onChange={(e) => setFilterGpsr(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">GPSR: Alle</option>
            <option value="complete">GPSR: Vollständig</option>
            <option value="incomplete">GPSR: Unvollständig</option>
          </select>
          <select
            id="table-filter-ebay"
            value={filterEbay}
            onChange={(e) => setFilterEbay(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">eBay: Alle</option>
            <option value="listed">eBay: Gelistet</option>
            <option value="notListed">eBay: Nicht gelistet</option>
          </select>
          <select
            id="table-filter-kaufland"
            value={filterKaufland}
            onChange={(e) => setFilterKaufland(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Kaufland: Alle</option>
            <option value="listed">Kaufland: Gelistet</option>
            <option value="notListed">Kaufland: Nicht gelistet</option>
          </select>
          <select
            id="table-filter-weight"
            value={filterWeight}
            onChange={(e) => setFilterWeight(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Gewicht: Alle</option>
            <option value="withWeight">Gewicht: vorhanden</option>
            <option value="noWeight">Gewicht: fehlt</option>
          </select>
          <select
            id="table-filter-reserved"
            value={filterReserved}
            onChange={(e) => setFilterReserved(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Reserviert: Alle</option>
            <option value="reserved">Reserviert: &gt; 0</option>
            <option value="notReserved">Reserviert: 0</option>
          </select>
          <select
            value={filterSold}
            onChange={(e) => setFilterSold(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Verkauft: Alle</option>
            <option value="sold">Verkauft: Ja</option>
            <option value="unsold">Verkauft: Nein</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={columnPreset}
            onChange={(e) => {
              const preset = e.target.value as ColumnPreset;
              setVisibleColumns(
                normalizeMarketplaceColumnOrder(COLUMN_PRESETS[preset])
              );
              setColumnPreset(preset);
            }}
            className={filterControlClass}
          >
            <option value="standard">{t("table.presets.standard")}</option>
            <option value="warehouse">{t("table.presets.warehouse")}</option>
            <option value="pricing">{t("table.presets.pricing")}</option>
            <option value="minimal">{t("table.presets.minimal")}</option>
          </select>
          <button
            type="button"
            onClick={() => setIsColumnPanelOpen(!isColumnPanelOpen)}
            className={`inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold transition ${isColumnPanelOpen ? "border-accent/30 bg-accent-dim text-accent" : "border-app-border bg-app-surface text-txt-primary hover:border-app-border/80"}`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
            </svg>
            {t("table.columns.edit")}
          </button>
        </div>

        <details className="relative">
          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-semibold text-txt-primary hover:border-app-border/80 transition">
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Tools
          </summary>
          <div className="absolute right-0 mt-2 w-[340px] max-w-[90vw] rounded-xl border border-app-border bg-app-bg p-1.5 shadow-xl shadow-black/40 z-30">
            <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
              Export &amp; Import
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              className={menuItemClass}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => {
                setKtypeModalOpen(true);
                setKtypeFile(null);
                setKtypeReport(null);
                setKtypeMessage(null);
              }}
              className={menuItemClass}
            >
              K\u2011Typ importieren
            </button>

            {onBulkImprove ? (
              <>
                <div className="my-1.5 border-t border-app-border/60" />
                <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                  KI
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: "Alle Produkte verbessern?",
                      tone: "default",
                      description:
                        "Startet KI/Improve-Jobs für alle Produkte. Das kann viele Jobs erzeugen und je nach Menge dauern.",
                      confirmLabel: "Verbessern (alle) starten",
                      onConfirm: () => {
                        setConfirmDialog(null);
                        onBulkImprove();
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Verbessern (alle)
                </button>
              </>
            ) : null}

            {mode === "inventory" ? (
              <>
                <div className="my-1.5 border-t border-app-border/60" />
                <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                  Inventory Fix + Sync
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: "Titel-Fix für alle Inventory-Produkte?",
                      tone: "default",
                      description:
                        "Entfernt einen Bindestrich am Ende (inkl. Leerzeichen) und stößt anschließend einen Text-Sync an.",
                      confirmLabel: "Starten",
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode("title_cleanup");
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Titel Cleanup + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: "Highlights als HTML formatieren?",
                      tone: "default",
                      description:
                        'Speichert Highlights als <ul><li>\u2026</li></ul> (kein \u201E\u2022\u201C) und synchronisiert sie per Text-Only Sync.',
                      confirmLabel: "Starten",
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode("highlights_html");
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Highlights \u2192 HTML + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: "Beschreibung als HTML formatieren?",
                      tone: "default",
                      description:
                        'Formatiert Absätze zu <p>\u2026</p> und Label wie \u201EZustand:\u201C zu <strong>\u2026</strong>. Danach Text-Only Sync.',
                      confirmLabel: "Starten",
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode(
                          "description_html"
                        );
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Beschreibung \u2192 HTML + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: "Listing-Readiness Audit ausführen?",
                      tone: "default",
                      description:
                        "Korrigiert/vereinheitlicht Titel/Highlights/Beschreibung/Attribute und stößt anschließend Text-Only Sync an.",
                      confirmLabel: "Starten",
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode(
                          "listing_readiness"
                        );
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Listing-Readiness Audit + Fix + Sync
                </button>
              </>
            ) : null}
          </div>
        </details>
      </div>

      {isColumnPanelOpen && (
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">
              {t("table.columns.visible")}
            </p>
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={resetColumns}
            >
              {t("table.columns.reset")}
            </button>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {visibleColumns.map((colId, idx) => {
              const col = columnDefinitions.find((c) => c.id === colId);
              if (!col) return null;
              return (
                <div
                  key={col.id}
                  className="flex items-center gap-2 rounded-lg bg-app-elevated/40 px-2 py-1.5 text-sm text-txt-primary"
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggleColumnVisibility(col.id)}
                    disabled={visibleColumns.length === 1}
                    className="bg-app-border border-app-border shrink-0"
                  />
                  <span className="flex-1 truncate">{col.label}</span>
                  <button
                    type="button"
                    onClick={() => moveColumn(col.id, "up")}
                    disabled={idx === 0}
                    className="p-0.5 text-txt-muted hover:text-txt-primary disabled:opacity-20"
                    title="Nach oben"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveColumn(col.id, "down")}
                    disabled={idx === visibleColumns.length - 1}
                    className="p-0.5 text-txt-muted hover:text-txt-primary disabled:opacity-20"
                    title="Nach unten"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
          {columnDefinitions.some((c) => !visibleColumns.includes(c.id)) && (
            <div className="space-y-1 border-t border-app-border pt-3">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                Ausgeblendet
              </p>
              {columnDefinitions
                .filter((c) => !visibleColumns.includes(c.id))
                .map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-txt-muted hover:text-txt-secondary cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => toggleColumnVisibility(col.id)}
                      className="bg-app-border border-app-border shrink-0"
                    />
                    <span className="truncate">{col.label}</span>
                  </label>
                ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default AdminTableFilters;
