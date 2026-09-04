import React from "react";
import {
  ColumnDefinition,
  ColumnId,
  ColumnPreset,
  COLUMN_PRESETS,
  ProductBulkActionName,
} from "./types";
import {
  chipSegments,
  NUMBER_OP_LABELS,
  type ActiveFilter,
  type DateRangeValue,
  type FilterContext,
  type FilterOption,
  type FilterValue,
  type NumberCompareValue,
  type NumberOp,
  type ProductFilterDef,
} from "../../utils/productFilters";
import { DEFAULT_SORT, type SortLevel } from "../../utils/productSort";
import type { SavedView } from "../../utils/savedViews";
import {
  AddFilterMenu,
  DateRangeEditor,
  FilterKindIcon,
  FilterPopover,
  MultiFilterEditor,
  NumberCompareEditor,
  SelectFilterEditor,
} from "./FilterValueEditor";

/**
 * Filter-Leiste der Produkttabelle — registry-getrieben.
 *
 * Aufbau (UX-Research 2026-08-26, Baymard/NN-g/Enterprise-Muster):
 * - Dauerhaft sichtbare Leiste statt verstecktem Panel (versteckte Filter
 *   werden messbar uebersehen).
 * - Quick-Filter fuer die haeufigsten Dimensionen (Status, Kategorie,
 *   Bearbeiter) + "+ Filter" fuer ALLE uebrigen Dimensionen.
 * - Aktive Filter als Chips: Klick oeffnet den Wert-Editor, × entfernt.
 * - Gespeicherte Ansichten (Filter + Sortierung) wie in Linear/Airtable.
 *
 * Die Filter-Definitionen (Predicate, Chip-Text, Optionen) kommen aus
 * utils/productFilters.ts — hier lebt NUR die Darstellung.
 */

interface CategoryNode {
  top: string;
  count: number;
  children: Array<{ sub: string; count: number }>;
}

interface AdminTableFiltersProps {
  // Registry-getriebene Filter
  filterDefs: ProductFilterDef[];
  activeFilters: ActiveFilter[];
  optionsById: ReadonlyMap<string, FilterOption[]>;
  filterCtx: FilterContext;
  setFilterValue: (id: string, value: FilterValue) => void;
  removeFilter: (id: string) => void;
  clearAllFilters: () => void;
  myInitials: string;

  // Kategorie-Baum (hierarchisches Sonder-UI)
  categoryTree: CategoryNode[];

  // Gespeicherte Ansichten (inkl. Dirty-State der aktiven Ansicht)
  savedViews: SavedView[];
  onApplyView: (view: SavedView) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
  appliedViewId: string | null;
  appliedViewDirty: boolean;
  onUpdateAppliedView: () => void;
  onDiscardViewChanges: () => void;

  // Sortierung: sichtbare Heimat neben den Spaltenkoepfen
  sortLevels: SortLevel[];
  setSortLevels: (levels: SortLevel[]) => void;

  // Spalten-Presets & Sichtbarkeit
  columnPreset: ColumnPreset;
  setColumnPreset: (v: ColumnPreset) => void;
  visibleColumns: ColumnId[];
  setVisibleColumns: (v: ColumnId[]) => void;
  columnDefinitions: ColumnDefinition[];
  isColumnPanelOpen: boolean;
  setIsColumnPanelOpen: (v: boolean) => void;
  toggleColumnVisibility: (id: ColumnId) => void;
  moveColumn: (id: ColumnId, direction: "up" | "down") => void;
  moveColumnTo: (id: ColumnId, targetIndex: number) => void;
  resetColumns: () => void;
  normalizeMarketplaceColumnOrder: (columns: ColumnId[]) => ColumnId[];

  // Tools-Menue
  mode: "inventory" | "products" | "all";
  handleExportCsv: () => void;
  onOpenProduktExport: () => void;
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

// Ruhige Ghost-Buttons fuer die Quick-Filter: die Filterzeile ist leicht und
// textbasiert (Linear-Muster), nur AKTIVE Filter tragen Farbe. Die Rahmen-
// Pillen bleiben rechts der Konfiguration (Preset/Spalten/Tools) vorbehalten
// — das ist die Hierarchie, die der Zeile vorher fehlte.
const quickFilterClass = (active: boolean) =>
  `inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-sm transition ${
    active
      ? "bg-accent/10 font-medium text-accent"
      : "text-txt-secondary hover:bg-app-elevated/60 hover:text-txt-primary"
  }`;

const ChevronDown: React.FC = () => (
  <svg className="h-3 w-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
  </svg>
);
const menuItemClass =
  "w-full text-left px-3 py-2 text-sm text-txt-primary hover:bg-app-elevated/60 rounded-xl transition";
/** Kategorie-Baum mit Top-/Sub-Checkboxen und indeterminate-Zustand. */
const CategoryTreeEditor: React.FC<{
  categoryTree: CategoryNode[];
  selection: string[];
  onChange: (selection: string[]) => void;
}> = ({ categoryTree, selection, onChange }) => {
  const selectionSet = React.useMemo(
    () => new Set(selection.map((s) => String(s).trim()).filter(Boolean)),
    [selection]
  );
  const toggleKey = (key: string) => {
    const next = new Set(selectionSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(Array.from(next));
  };
  const toggleTop = (top: string) => {
    const next = new Set(selectionSet);
    const node = categoryTree.find((t) => t.top === top);
    const childKeys = node ? node.children.map((c) => `${top} > ${c.sub}`) : [];
    const allKeys = [top, ...childKeys];
    const allOn = allKeys.length ? allKeys.every((k) => next.has(k)) : next.has(top);
    if (allOn) allKeys.forEach((k) => next.delete(k));
    else allKeys.forEach((k) => next.add(k));
    onChange(Array.from(next));
  };
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
      {categoryTree.map((node) => {
        const topKey = node.top;
        const childKeys = node.children.map((c) => `${node.top} > ${c.sub}`);
        const allKeys = [topKey, ...childKeys];
        const selectedCount = allKeys.filter((k) => selectionSet.has(k)).length;
        const isAllSelected = selectedCount === allKeys.length && allKeys.length > 0;
        const isIndeterminate = selectedCount > 0 && selectedCount < allKeys.length;
        return (
          <div key={node.top} className="rounded-xl border border-app-border bg-app-surface">
            <label className="flex items-center gap-2 px-2 py-2 text-sm text-txt-primary">
              <input
                type="checkbox"
                checked={isAllSelected}
                ref={(el) => {
                  if (el) el.indeterminate = isIndeterminate;
                }}
                onChange={() => toggleTop(node.top)}
              />
              <span className="flex-1">{node.top}</span>
              <span className="text-xs text-txt-muted">({node.count})</span>
            </label>
            {node.children.length > 0 && (
              <div className="space-y-1 border-t border-app-border px-2 py-2">
                {node.children.map((c) => {
                  const key = `${node.top} > ${c.sub}`;
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 py-1 pl-5 pr-2 text-sm text-txt-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={selectionSet.has(key)}
                        onChange={() => toggleKey(key)}
                      />
                      <span className="flex-1">{c.sub}</span>
                      <span className="text-xs text-txt-muted">({c.count})</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const AdminTableFilters: React.FC<AdminTableFiltersProps> = ({
  filterDefs,
  activeFilters,
  optionsById,
  filterCtx,
  setFilterValue,
  removeFilter,
  clearAllFilters,
  myInitials,
  categoryTree,
  savedViews,
  onApplyView,
  onSaveView,
  onDeleteView,
  appliedViewId,
  appliedViewDirty,
  onUpdateAppliedView,
  onDiscardViewChanges,
  sortLevels,
  setSortLevels,
  columnPreset,
  setColumnPreset,
  visibleColumns,
  setVisibleColumns,
  columnDefinitions,
  isColumnPanelOpen,
  setIsColumnPanelOpen,
  toggleColumnVisibility,
  moveColumn,
  moveColumnTo,
  resetColumns,
  normalizeMarketplaceColumnOrder,
  mode,
  handleExportCsv,
  onOpenProduktExport,
  onBulkImprove,
  enqueueBulkForAllInCurrentMode,
  setKtypeModalOpen,
  setKtypeFile,
  setKtypeReport,
  setKtypeMessage,
  setConfirmDialog,
  t,
}) => {
  // Drag & Drop-State für die Spalten-Sortierung im Spalten-Panel.
  const [dragColId, setDragColId] = React.useState<ColumnId | null>(null);
  const [dropIdx, setDropIdx] = React.useState<number | null>(null);

  // Genau EIN offenes Popover: Wert-Editor (Filter-Id + Anker, damit Quick-
  // Button und Chip derselben Dimension nie zwei Popovers zugleich zeigen),
  // "+ Filter" oder Ansichten.
  const [openEditor, setOpenEditor] = React.useState<{ id: string; anchor: "quick" | "chip" | "op" } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  const [viewsMenuOpen, setViewsMenuOpen] = React.useState(false);
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const [sortAddOpen, setSortAddOpen] = React.useState(false);
  const [viewName, setViewName] = React.useState("");
  const toolsDetailsRef = React.useRef<HTMLDetailsElement | null>(null);

  const closeAllPopovers = React.useCallback(() => {
    setOpenEditor(null);
    setAddMenuOpen(false);
    setViewsMenuOpen(false);
    setSortMenuOpen(false);
    setSortAddOpen(false);
  }, []);

  // Klick außerhalb / Escape schließt jedes offene Popover (Standard-UX).
  // Ein Handler für alle: Popovers und ihre Trigger tragen data-filter-pop.
  React.useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // Tools-Menue ZUERST schliessen — auch ein Klick auf einen Filter-Button
      // ([data-filter-pop]) ist "ausserhalb" des Tools-Menues.
      if (toolsDetailsRef.current?.open && target && !toolsDetailsRef.current.contains(target)) {
        toolsDetailsRef.current.open = false;
      }
      if (target?.closest?.("[data-filter-pop]")) return;
      closeAllPopovers();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeAllPopovers();
      if (toolsDetailsRef.current) toolsDetailsRef.current.open = false;
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAllPopovers]);

  // Taste F oeffnet das Filter-Menue (Linear-Konvention) — nie, wenn gerade
  // getippt wird.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "f" && e.key !== "F") || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setOpenEditor(null);
      setViewsMenuOpen(false);
      setSortMenuOpen(false);
      setAddMenuOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const defsById = React.useMemo(() => {
    const map = new Map<string, ProductFilterDef>();
    filterDefs.forEach((d) => map.set(d.id, d));
    return map;
  }, [filterDefs]);

  const getValue = (id: string): FilterValue | undefined =>
    activeFilters.find((f) => f.id === id)?.value;

  // Chips: ALLE vorhandenen Eintraege — auch frisch hinzugefuegte, deren Wert
  // noch leer ist (Linear-Muster: leerer Chip, der Editor haengt daran).
  const chipEntries = React.useMemo(
    () =>
      activeFilters
        .map((entry) => ({ entry, def: defsById.get(entry.id) }))
        .filter((x): x is { entry: ActiveFilter; def: ProductFilterDef } => Boolean(x.def)),
    [activeFilters, defsById]
  );
  const activeEntries = React.useMemo(
    () => chipEntries.filter((x) => x.def.isActive(x.entry.value)),
    [chipEntries]
  );
  const activeIds = React.useMemo(() => new Set(activeEntries.map((x) => x.entry.id)), [activeEntries]);

  // Wird ein Editor geschlossen, ohne dass ein Wert gesetzt wurde, verschwindet
  // der leere Chip wieder — sonst sammeln sich wirkungslose Filter an.
  const prevEditorRef = React.useRef<typeof openEditor>(null);
  React.useEffect(() => {
    const prev = prevEditorRef.current;
    prevEditorRef.current = openEditor;
    if (!prev || openEditor?.id === prev.id) return;
    const entry = activeFilters.find((f) => f.id === prev.id);
    const def = entry ? defsById.get(entry.id) : undefined;
    if (entry && def && !def.isActive(entry.value)) {
      removeFilter(entry.id);
    }
  }, [openEditor, activeFilters, defsById, removeFilter]);

  const statusDef = defsById.get("status");
  const statusValue = (getValue("status") as string) || "all";

  const categorySelection = (getValue("category") as string[]) || [];
  const editorSelection = (getValue("editor") as string[]) || [];
  const isMyItemsActive = editorSelection.length === 1 && editorSelection[0] === myInitials;

  const openEditorAt = (id: string, anchor: "quick" | "chip" | "op") => {
    setAddMenuOpen(false);
    setViewsMenuOpen(false);
    setSortMenuOpen(false);
    setOpenEditor((prev) => (prev && prev.id === id && prev.anchor === anchor ? null : { id, anchor }));
  };

  // Aktive Ansicht + sortierbare Spalten (Label je sortKey) fuer das Sort-Menue.
  const appliedView = appliedViewId ? savedViews.find((v) => v.id === appliedViewId) ?? null : null;
  const sortableColumns = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string }> = [];
    for (const col of columnDefinitions) {
      if (!col.sortKey || seen.has(col.sortKey)) continue;
      seen.add(col.sortKey);
      out.push({ key: col.sortKey, label: String(col.label) });
    }
    return out;
  }, [columnDefinitions]);
  const sortLabelFor = (key: string) => sortableColumns.find((c) => c.key === key)?.label ?? key;

  /** Wert-Editor für eine Dimension — nach `kind` bzw. Sonderfall Kategorie. */
  const renderEditor = (def: ProductFilterDef) => {
    const value = getValue(def.id) ?? def.defaultValue;
    const remove = () => {
      removeFilter(def.id);
      setOpenEditor(null);
    };
    if (def.id === "category") {
      return (
        <FilterPopover title="Kategorien" onClose={() => setOpenEditor(null)} onRemove={remove} widthClass="w-[360px]">
          <CategoryTreeEditor
            categoryTree={categoryTree}
            selection={(value as string[]) || []}
            onChange={(next) => setFilterValue("category", next)}
          />
        </FilterPopover>
      );
    }
    if (def.kind === "multi") {
      return (
        <FilterPopover title={def.label} onClose={() => setOpenEditor(null)} onRemove={remove}>
          <MultiFilterEditor
            options={optionsById.get(def.id) || []}
            values={(value as string[]) || []}
            onChange={(next) => setFilterValue(def.id, next)}
          />
        </FilterPopover>
      );
    }
    if (def.kind === "numberCompare") {
      return (
        <FilterPopover title={def.label} onClose={() => setOpenEditor(null)} onRemove={remove}>
          <NumberCompareEditor
            def={def}
            value={value as NumberCompareValue}
            onChange={(next) => setFilterValue(def.id, next)}
          />
        </FilterPopover>
      );
    }
    if (def.kind === "dateRange") {
      return (
        <FilterPopover title={def.label} onClose={() => setOpenEditor(null)} onRemove={remove}>
          <DateRangeEditor value={value as DateRangeValue} onChange={(next) => setFilterValue(def.id, next)} />
        </FilterPopover>
      );
    }
    return (
      <FilterPopover title={def.label} onClose={() => setOpenEditor(null)} onRemove={remove}>
        <SelectFilterEditor
          def={def}
          value={(value as string) || ""}
          onChange={(next) => {
            setFilterValue(def.id, next);
            // Einzelwahl ist mit einem Klick fertig — Popover zu.
            setOpenEditor(null);
          }}
        />
      </FilterPopover>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* Gespeicherte Ansichten (Filter + Sortierung, lokal je Gerät) */}
        <div data-filter-pop className="relative">
          <button
            type="button"
            onClick={() => {
              setViewsMenuOpen((v) => !v);
              setAddMenuOpen(false);
              setOpenEditor(null);
            }}
            aria-expanded={viewsMenuOpen}
            className={`${quickFilterClass(false)} gap-1.5`}
            title="Gespeicherte Ansichten (Filter + Sortierung)"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.5 21l-5.5-4-5.5 4V5a2 2 0 012-2h7a2 2 0 012 2v16z" />
            </svg>
            {appliedView ? (
              <span className="max-w-[160px] truncate text-txt-primary">{appliedView.name}</span>
            ) : (
              "Ansichten"
            )}
            {appliedView && appliedViewDirty && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent"
                title="Ansicht wurde verändert — im Menü aktualisieren oder verwerfen"
                aria-label="Ungespeicherte Änderungen an der Ansicht"
              />
            )}
            {!appliedView && savedViews.length > 0 && (
              <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">
                {savedViews.length}
              </span>
            )}
            <ChevronDown />
          </button>
          {viewsMenuOpen && (
            <div
              data-filter-pop
              className="absolute left-0 z-30 mt-2 w-[300px] max-w-[92vw] rounded-xl border border-app-border bg-app-bg p-2 shadow-xl shadow-black/40"
            >
              {appliedView && appliedViewDirty && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onUpdateAppliedView();
                      setViewsMenuOpen(false);
                    }}
                    className={`${menuItemClass} font-medium text-accent`}
                  >
                    „{appliedView.name}“ aktualisieren
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDiscardViewChanges();
                      setViewsMenuOpen(false);
                    }}
                    className={menuItemClass}
                  >
                    Änderungen verwerfen
                  </button>
                  <div className="my-1.5 border-t border-app-border/60" />
                </>
              )}
              <p className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
                Gespeicherte Ansichten
              </p>
              {savedViews.length === 0 ? (
                <p className="px-2 py-2 text-xs text-txt-muted">
                  Noch keine. Filter + Sortierung einstellen, unten benennen und speichern.
                </p>
              ) : (
                <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
                  {savedViews.map((view) => (
                    <div key={view.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          onApplyView(view);
                          setViewsMenuOpen(false);
                        }}
                        className={`${menuItemClass} flex flex-1 items-center gap-2 truncate`}
                        title={`Ansicht „${view.name}“ anwenden`}
                      >
                        <span className="flex-1 truncate">{view.name}</span>
                        {appliedViewId === view.id && (
                          <svg className="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteView(view.id)}
                        aria-label={`Ansicht „${view.name}“ löschen`}
                        title="Ansicht löschen"
                        className="rounded-lg px-2 py-1 text-sm text-txt-muted transition hover:bg-danger-dim hover:text-danger"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2 border-t border-app-border pt-2">
                <input
                  type="text"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && viewName.trim()) {
                      e.preventDefault();
                      onSaveView(viewName);
                      setViewName("");
                    }
                  }}
                  placeholder="Aktuelle Ansicht benennen …"
                  aria-label="Name der Ansicht"
                  className="min-w-0 flex-1 rounded-xl border border-app-border bg-app-surface p-2 text-sm text-txt-primary outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="button"
                  disabled={!viewName.trim()}
                  onClick={() => {
                    onSaveView(viewName);
                    setViewName("");
                  }}
                  className="rounded-xl bg-accent-dim px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Speichern
                </button>
              </div>
            </div>
          )}
        </div>

        <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-app-border sm:block" />

        {/* Quick-Filter: Status */}
        {statusDef && (
          <div data-filter-pop className="relative">
            <button
              type="button"
              onClick={() => openEditorAt("status", "quick")}
              aria-expanded={openEditor?.id === "status" && openEditor.anchor === "quick"}
              className={quickFilterClass(statusValue !== "all")}
            >
              {statusValue === "all"
                ? "Status"
                : `Status · ${statusDef.selectOptions?.find((o) => o.value === statusValue)?.label ?? statusValue}`}
              <ChevronDown />
            </button>
            {openEditor?.id === "status" && openEditor.anchor === "quick" && renderEditor(statusDef)}
          </div>
        )}

        {/* Quick-Filter: Kategorie (Baum) */}
        <div data-filter-pop className="relative">
          <button
            type="button"
            onClick={() => openEditorAt("category", "quick")}
            aria-expanded={openEditor?.id === "category" && openEditor.anchor === "quick"}
            className={quickFilterClass(categorySelection.length > 0)}
          >
            {categorySelection.length === 0 ? "Kategorie" : `Kategorie · ${categorySelection.length}`}
            <ChevronDown />
          </button>
          {openEditor?.id === "category" && openEditor.anchor === "quick" && defsById.get("category") && renderEditor(defsById.get("category")!)}
        </div>

        {/* Quick-Filter: Bearbeiter + Meine (Kurz-Toggle auf die eigenen Initialen) */}
        <div data-filter-pop className="relative">
          <button
            type="button"
            onClick={() => openEditorAt("editor", "quick")}
            aria-expanded={openEditor?.id === "editor" && openEditor.anchor === "quick"}
            className={quickFilterClass(editorSelection.length > 0)}
          >
            {editorSelection.length === 0 ? "Bearbeiter" : `Bearbeiter · ${editorSelection.length}`}
            <ChevronDown />
          </button>
          {openEditor?.id === "editor" && openEditor.anchor === "quick" && defsById.get("editor") && renderEditor(defsById.get("editor")!)}
        </div>
        <button
          type="button"
          onClick={() => {
            if (isMyItemsActive) removeFilter("editor");
            else setFilterValue("editor", [myInitials]);
          }}
          disabled={!myInitials}
          aria-pressed={isMyItemsActive}
          title={t("table.editor.title")}
          className={`${quickFilterClass(isMyItemsActive)} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          Meine
        </button>

        {/* + Filter: alle Dimensionen, gruppiert + durchsuchbar */}
        <div data-filter-pop className="relative">
          <button
            type="button"
            onClick={() => {
              setAddMenuOpen((v) => !v);
              setOpenEditor(null);
              setViewsMenuOpen(false);
            }}
            aria-expanded={addMenuOpen}
            className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-dashed px-2.5 text-sm transition ${
              addMenuOpen ? "border-accent/60 bg-accent/10 text-accent" : "border-accent/40 text-accent hover:bg-accent/10"
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            Filter
            <kbd className="rounded border border-current/30 px-1 text-[10px] leading-4 opacity-60">F</kbd>
          </button>
          {addMenuOpen && (
            <AddFilterMenu
              defs={filterDefs}
              activeIds={activeIds}
              optionsById={optionsById}
              getValue={getValue}
              setFilterValue={setFilterValue}
              removeFilter={removeFilter}
              renderCustomEditor={(def) =>
                def.id === "category" ? (
                  <CategoryTreeEditor
                    categoryTree={categoryTree}
                    selection={(getValue("category") as string[]) || []}
                    onChange={(next) => setFilterValue("category", next)}
                  />
                ) : null
              }
              onClose={() => setAddMenuOpen(false)}
            />
          )}
        </div>

        {activeEntries.length > 0 && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="whitespace-nowrap text-xs text-accent hover:underline"
          >
            Zurücksetzen ({activeEntries.length})
          </button>
        )}

        {/* Anzeige & Tools — rechtsbündig: WIE die Daten gezeigt werden
            (Sortierung, Spalten, Tools) — getrennt von den Filtern links. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div data-filter-pop className="relative">
            <button
              type="button"
              onClick={() => {
                setSortMenuOpen((v) => !v);
                setSortAddOpen(false);
                setOpenEditor(null);
                setAddMenuOpen(false);
                setViewsMenuOpen(false);
              }}
              aria-expanded={sortMenuOpen}
              className={`inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-lg border px-2.5 text-xs font-semibold transition ${
                sortMenuOpen ? "border-accent/30 bg-accent-dim text-accent" : "border-app-border bg-app-surface text-txt-primary hover:border-app-border/80"
              }`}
              title="Sortierung anzeigen und ändern (Spaltenkopf: Klick sortiert, Shift-Klick ergänzt)"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 4v13m0 0l-3-3m3 3l3-3M17 20V7m0 0l-3 3m3-3l3 3" />
              </svg>
              Sortierung
              {sortLevels.length > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">{sortLevels.length}</span>
              )}
              <ChevronDown />
            </button>
            {sortMenuOpen && (
              <div
                data-filter-pop
                className="absolute right-0 z-30 mt-2 w-[300px] max-w-[92vw] rounded-xl border border-app-border bg-app-bg p-2 shadow-xl shadow-black/40"
              >
                <p className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
                  Sortierung
                </p>
                {sortLevels.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-txt-muted">
                    Keine Sortierung aktiv — Zeilen folgen der Ladereihenfolge.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {sortLevels.map((level, idx) => (
                      <div key={level.key} className="flex items-center gap-1 rounded-lg px-1 py-0.5 hover:bg-app-elevated/40">
                        <span className="w-4 text-center text-[10px] font-semibold text-txt-muted">{idx + 1}</span>
                        <span className="flex-1 truncate text-sm text-txt-primary">{sortLabelFor(level.key)}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setSortLevels(
                              sortLevels.map((l, i) =>
                                i === idx ? { ...l, direction: l.direction === "asc" ? "desc" : "asc" } : l
                              )
                            )
                          }
                          className="rounded-md px-1.5 py-0.5 text-xs text-txt-secondary transition hover:bg-app-elevated hover:text-txt-primary"
                          title={level.direction === "asc" ? "Aufsteigend — Klick dreht um" : "Absteigend — Klick dreht um"}
                        >
                          {level.direction === "asc" ? "▲ Aufst." : "▼ Abst."}
                        </button>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => {
                            const next = [...sortLevels];
                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                            setSortLevels(next);
                          }}
                          aria-label="Priorität erhöhen"
                          className="rounded-md px-1 py-0.5 text-xs text-txt-muted transition hover:bg-app-elevated hover:text-txt-primary disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === sortLevels.length - 1}
                          onClick={() => {
                            const next = [...sortLevels];
                            [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                            setSortLevels(next);
                          }}
                          aria-label="Priorität senken"
                          className="rounded-md px-1 py-0.5 text-xs text-txt-muted transition hover:bg-app-elevated hover:text-txt-primary disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => setSortLevels(sortLevels.filter((_, i) => i !== idx))}
                          aria-label={`Sortierung nach ${sortLabelFor(level.key)} entfernen`}
                          className="rounded-md px-1.5 py-0.5 text-sm leading-none text-txt-muted transition hover:bg-danger-dim hover:text-danger"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 border-t border-app-border/60 pt-1.5">
                  {sortAddOpen ? (
                    <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                      {sortableColumns
                        .filter((c) => !sortLevels.some((l) => l.key === c.key))
                        .map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            onClick={() => {
                              setSortLevels([...sortLevels, { key: c.key, direction: "asc" }]);
                              setSortAddOpen(false);
                            }}
                            className={menuItemClass}
                          >
                            {c.label}
                          </button>
                        ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSortAddOpen(true)}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-accent transition hover:bg-accent/10"
                      >
                        + Kriterium
                      </button>
                      <button
                        type="button"
                        onClick={() => setSortLevels(DEFAULT_SORT)}
                        className="rounded-lg px-2 py-1 text-xs text-txt-muted transition hover:bg-app-elevated hover:text-txt-secondary"
                        title="Zurück zur Standard-Sortierung (zuletzt gespeichert zuerst)"
                      >
                        Standard
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <select
            value={columnPreset}
            onChange={(e) => {
              const preset = e.target.value as ColumnPreset;
              setVisibleColumns(normalizeMarketplaceColumnOrder(COLUMN_PRESETS[preset]));
              setColumnPreset(preset);
            }}
            aria-label="Spalten-Preset"
            className="h-9 rounded-lg border border-app-border bg-app-surface px-2 text-sm text-txt-primary"
          >
            <option value="standard">{t("table.presets.standard")}</option>
            <option value="warehouse">{t("table.presets.warehouse")}</option>
            <option value="pricing">{t("table.presets.pricing")}</option>
            <option value="minimal">{t("table.presets.minimal")}</option>
          </select>
          <button
            type="button"
            onClick={() => setIsColumnPanelOpen(!isColumnPanelOpen)}
            className={`inline-flex h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold transition ${isColumnPanelOpen ? "border-accent/30 bg-accent-dim text-accent" : "border-app-border bg-app-surface text-txt-primary hover:border-app-border/80"}`}
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
            </svg>
            {t("table.columns.edit")}
          </button>

          <details ref={toolsDetailsRef} className="relative">
            <summary className="inline-flex h-9 cursor-pointer select-none list-none items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2.5 text-xs font-semibold text-txt-primary transition hover:border-app-border/80 [&::-webkit-details-marker]:hidden">
              <svg
                className="h-3.5 w-3.5"
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
            <div className="absolute right-0 z-30 mt-2 w-[340px] max-w-[90vw] rounded-xl border border-app-border bg-app-bg p-1.5 shadow-xl shadow-black/40">
              <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
                Export &amp; Import
              </div>
              <button type="button" onClick={onOpenProduktExport} className={menuItemClass}>
                Produktdaten exportieren (CSV) …
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className={menuItemClass}
                title="Startet den Marktplatz-Export-Job des Backends fuer die AUSGEWAEHLTEN Produkte"
              >
                Marktplatz-Export (nur Auswahl)
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
                K‑Typ importieren
              </button>

              {onBulkImprove ? (
                <>
                  <div className="my-1.5 border-t border-app-border/60" />
                  <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
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
                  <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
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
                          'Speichert Highlights als <ul><li>…</li></ul> (kein „•“) und synchronisiert sie per Text-Only Sync.',
                        confirmLabel: "Starten",
                        onConfirm: async () => {
                          setConfirmDialog(null);
                          await enqueueBulkForAllInCurrentMode("highlights_html");
                        },
                      });
                    }}
                    className={menuItemClass}
                  >
                    Highlights → HTML + Sync
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDialog({
                        title: "Beschreibung als HTML formatieren?",
                        tone: "default",
                        description:
                          'Formatiert Absätze zu <p>…</p> und Label wie „Zustand:“ zu <strong>…</strong>. Danach Text-Only Sync.',
                        confirmLabel: "Starten",
                        onConfirm: async () => {
                          setConfirmDialog(null);
                          await enqueueBulkForAllInCurrentMode("description_html");
                        },
                      });
                    }}
                    className={menuItemClass}
                  >
                    Beschreibung → HTML + Sync
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
                          await enqueueBulkForAllInCurrentMode("listing_readiness");
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
      </div>

      {/* Aktive Filter als SEGMENTIERTE Chips (Linear-Signatur):
          [Typ-Icon + Feld] [Operator] [Wert] [×] mit 1px-Fugen — jedes Segment
          ist eine eigene Klickflaeche; beim Zahlenfilter wechselt der Klick
          auf den Operator direkt den Vergleich. */}
      {chipEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chipEntries.map(({ entry, def }) => {
            const segments = chipSegments(def, entry.value, filterCtx);
            const isInactive = !def.isActive(entry.value);
            const segBase = "inline-flex items-center bg-app-surface px-2 py-1 transition";
            return (
              <div key={entry.id} data-filter-pop className="relative">
                <span className="inline-flex items-stretch gap-px overflow-hidden rounded-md border border-app-border bg-app-border/60 text-xs">
                  <button
                    type="button"
                    onClick={() => openEditorAt(entry.id, "chip")}
                    className={`${segBase} gap-1 text-txt-secondary hover:bg-app-elevated hover:text-txt-primary`}
                    title="Filter bearbeiten"
                  >
                    <FilterKindIcon kind={def.kind} className="h-3 w-3" />
                    <span className="whitespace-nowrap">{segments.field}</span>
                  </button>
                  {segments.op &&
                    (def.kind === "numberCompare" ? (
                      <button
                        type="button"
                        onClick={() => openEditorAt(entry.id, "op")}
                        className={`${segBase} text-txt-muted hover:bg-app-elevated hover:text-txt-primary`}
                        title="Vergleich wechseln"
                      >
                        {segments.op}
                      </button>
                    ) : (
                      <span className={`${segBase} text-txt-muted`}>{segments.op}</span>
                    ))}
                  <button
                    type="button"
                    onClick={() => openEditorAt(entry.id, "chip")}
                    className={`${segBase} whitespace-nowrap font-medium hover:bg-app-elevated ${
                      isInactive ? "italic text-txt-muted" : "text-txt-primary"
                    }`}
                    title="Wert ändern"
                  >
                    {segments.value}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeFilter(entry.id);
                      if (openEditor?.id === entry.id) setOpenEditor(null);
                    }}
                    aria-label={`Filter ${def.label} entfernen`}
                    title="Filter entfernen"
                    className={`${segBase} text-txt-muted hover:bg-danger-dim hover:text-danger`}
                  >
                    ×
                  </button>
                </span>
                {openEditor?.id === entry.id && openEditor.anchor === "chip" && renderEditor(def)}
                {openEditor?.id === entry.id && openEditor.anchor === "op" && def.kind === "numberCompare" && (
                  <div
                    data-filter-pop
                    className="absolute left-0 z-30 mt-2 w-[180px] rounded-xl border border-app-border bg-app-bg p-1.5 shadow-lg"
                  >
                    {NUMBER_OP_LABELS.map((op) => {
                      const current = (entry.value as NumberCompareValue).op === op.value;
                      return (
                        <button
                          key={op.value}
                          type="button"
                          onClick={() => {
                            setFilterValue(entry.id, { ...(entry.value as NumberCompareValue), op: op.value as NumberOp });
                            setOpenEditor(null);
                          }}
                          className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                            current ? "bg-accent/10 font-medium text-accent" : "text-txt-primary hover:bg-app-elevated/60"
                          }`}
                        >
                          {op.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={clearAllFilters}
            className="ml-1 text-xs text-txt-muted transition hover:text-txt-secondary"
          >
            Alle entfernen
          </button>
        </div>
      )}

      {isColumnPanelOpen && (
        <div className="space-y-3 rounded-2xl border border-app-border bg-app-surface p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-txt-primary">{t("table.columns.visible")}</p>
            <button type="button" className="text-xs text-accent hover:underline" onClick={resetColumns}>
              {t("table.columns.reset")}
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {visibleColumns.map((colId, idx) => {
              const col = columnDefinitions.find((c) => c.id === colId);
              if (!col) return null;
              const isDragging = dragColId === col.id;
              const isDropTarget = dropIdx === idx && dragColId !== null && dragColId !== col.id;
              return (
                <div
                  key={col.id}
                  draggable
                  onDragStart={(e) => {
                    setDragColId(col.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", col.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropIdx !== idx) setDropIdx(idx);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragColId && dragColId !== col.id) moveColumnTo(dragColId, idx);
                    setDragColId(null);
                    setDropIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragColId(null);
                    setDropIdx(null);
                  }}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-txt-primary transition-colors ${
                    isDragging ? "bg-app-elevated/40 opacity-40" : "bg-app-elevated/40"
                  } ${isDropTarget ? "bg-accent/10 ring-1 ring-accent" : ""}`}
                >
                  {/* Grip: Maus = Drag & Drop, Tastatur = Pfeiltasten */}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`${col.label} verschieben (Pfeiltasten oder ziehen)`}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        moveColumn(col.id, "up");
                      }
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        moveColumn(col.id, "down");
                      }
                    }}
                    className="shrink-0 cursor-grab text-txt-muted hover:text-txt-primary focus:text-accent focus:outline-none active:cursor-grabbing"
                    title="Ziehen zum Sortieren"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="6" r="1.5" />
                      <circle cx="15" cy="6" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="18" r="1.5" />
                      <circle cx="15" cy="18" r="1.5" />
                    </svg>
                  </span>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggleColumnVisibility(col.id)}
                    disabled={visibleColumns.length === 1}
                    className="shrink-0 border-app-border bg-app-border"
                  />
                  <span className="flex-1 truncate">{col.label}</span>
                </div>
              );
            })}
          </div>
          {columnDefinitions.some((c) => !visibleColumns.includes(c.id)) && (
            <div className="space-y-1 border-t border-app-border pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-txt-muted">Ausgeblendet</p>
              {columnDefinitions
                .filter((c) => !visibleColumns.includes(c.id))
                .map((col) => (
                  <label
                    key={col.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-txt-muted hover:text-txt-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => toggleColumnVisibility(col.id)}
                      className="shrink-0 border-app-border bg-app-border"
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
