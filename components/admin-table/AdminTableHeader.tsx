import React from "react";
import { ColumnDefinition, SortConfig } from "./types";

interface SortableHeaderProps {
  sortKey?: string;
  children: React.ReactNode;
  widthClass?: string;
  sortConfig: SortConfig;
  onSort: (key: string) => void;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({
  sortKey,
  children,
  widthClass,
  sortConfig,
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
  const ariaSortValue: "ascending" | "descending" | "none" =
    sortConfig?.key === sortKey
      ? sortConfig.direction === "asc"
        ? "ascending"
        : "descending"
      : "none";
  return (
    <th
      className={`p-3 cursor-pointer text-xs font-semibold uppercase tracking-wide text-txt-secondary whitespace-nowrap ${widthClass || ""}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
      tabIndex={0}
      aria-sort={ariaSortValue}
    >
      {children}
      {sortConfig?.key === sortKey &&
        (sortConfig.direction === "asc" ? " \u25B2" : " \u25BC")}
    </th>
  );
};

interface AdminTableHeaderProps {
  visibleColumnDefinitions: ColumnDefinition[];
  sortConfig: SortConfig;
  onSort: (key: string) => void;
  selectedIds: Set<string>;
  pageProducts: { id: string }[];
  onSelectAll: (e: React.ChangeEvent<HTMLInputElement>) => void;
  totalFilteredCount?: number;
  onSelectAllFiltered?: () => void;
}

const AdminTableHeader: React.FC<AdminTableHeaderProps> = ({
  visibleColumnDefinitions,
  sortConfig,
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
              sortConfig={sortConfig}
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
