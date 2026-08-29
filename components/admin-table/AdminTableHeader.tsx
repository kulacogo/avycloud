import React from "react";
import { ColumnDefinition } from "./types";
import type { SortLevel } from "../../utils/productSort";

interface SortableHeaderProps {
  sortKey?: string;
  children: React.ReactNode;
  widthClass?: string;
  sortLevels: SortLevel[];
  onSort: (key: string, additive: boolean) => void;
}

/**
 * Spaltenkopf: Klick sortiert (asc/desc im Wechsel), Shift-Klick haengt die
 * Spalte als weiteres Kriterium an. Bei Multi-Sort zeigt eine kleine Ziffer
 * die Prioritaet (Airtable-/Handsontable-Konvention).
 */
const SortableHeader: React.FC<SortableHeaderProps> = ({
  sortKey,
  children,
  widthClass,
  sortLevels,
  onSort,
}) => {
  if (!sortKey) {
    return (
      <th
        className={`p-3 text-xs font-semibold uppercase tracking-wide text-txt-secondary whitespace-nowrap ${widthClass || ""}`}
      >
        {children}
      </th>
    );
  }
  const levelIndex = sortLevels.findIndex((l) => l.key === sortKey);
  const level = levelIndex >= 0 ? sortLevels[levelIndex] : null;
  const ariaSortValue: "ascending" | "descending" | "none" = level
    ? level.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th
      className={`p-3 cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-txt-secondary whitespace-nowrap ${widthClass || ""}`}
      onClick={(e) => onSort(sortKey, e.shiftKey)}
      onMouseDown={(e) => {
        // Shift-Klick ist Multi-Sort — der Browser darf daraus keine
        // Textselektion ueber die halbe Tabelle machen.
        if (e.shiftKey) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(sortKey, e.shiftKey);
        }
      }}
      tabIndex={0}
      aria-sort={ariaSortValue}
      title="Klick: sortieren · Shift-Klick: als weiteres Kriterium"
    >
      {children}
      {level && (level.direction === "asc" ? " ▲" : " ▼")}
      {level && sortLevels.length > 1 && (
        <span className="ml-0.5 inline-flex items-center justify-center min-w-[14px] h-3.5 rounded-full bg-accent/15 px-1 text-[9px] font-bold text-accent align-middle">
          {levelIndex + 1}
        </span>
      )}
    </th>
  );
};

interface AdminTableHeaderProps {
  visibleColumnDefinitions: ColumnDefinition[];
  sortLevels: SortLevel[];
  onSort: (key: string, additive: boolean) => void;
  selectedIds: Set<string>;
  pageProducts: { id: string }[];
  onSelectAll: (e: React.ChangeEvent<HTMLInputElement>) => void;
  totalFilteredCount?: number;
  onSelectAllFiltered?: () => void;
}

const AdminTableHeader: React.FC<AdminTableHeaderProps> = ({
  visibleColumnDefinitions,
  sortLevels,
  onSort,
  selectedIds,
  pageProducts,
  onSelectAll,
  totalFilteredCount,
  onSelectAllFiltered,
}) => {
  const allPageSelected =
    selectedIds.size > 0 &&
    pageProducts.length > 0 &&
    pageProducts.every((p) => selectedIds.has(p.id));
  const showSelectAllFiltered =
    allPageSelected &&
    totalFilteredCount != null &&
    totalFilteredCount > pageProducts.length &&
    selectedIds.size < totalFilteredCount;

  return (
    <thead className="bg-app-surface">
      <tr>
        <th className="p-3 w-12 text-xs font-semibold uppercase tracking-wide text-txt-secondary">
          <div className="flex flex-col items-start gap-1">
            <input
              type="checkbox"
              name="select-all-products"
              aria-label="Alle auswählen"
              onChange={onSelectAll}
              checked={allPageSelected}
              className="bg-app-border border-app-border"
            />
            {showSelectAllFiltered && onSelectAllFiltered && (
              <button
                type="button"
                onClick={onSelectAllFiltered}
                className="text-[10px] text-accent hover:underline whitespace-nowrap leading-tight"
              >
                Alle {totalFilteredCount}
              </button>
            )}
          </div>
        </th>
        {visibleColumnDefinitions.map((column) => {
          return (
            <SortableHeader
              key={column.id}
              sortKey={column.sortKey}
              widthClass={column.widthClass}
              sortLevels={sortLevels}
              onSort={onSort}
            >
              {column.label}
            </SortableHeader>
          );
        })}
      </tr>
    </thead>
  );
};

export default AdminTableHeader;
