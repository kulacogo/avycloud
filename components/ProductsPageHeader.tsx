import React from "react";

interface ProductsPageHeaderProps {
  totalCount: number;
  filteredCount: number;
  onCreateProduct?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  mode?: "products" | "inventory";
}

export const ProductsPageHeader: React.FC<ProductsPageHeaderProps> = ({
  totalCount,
  filteredCount,
  onCreateProduct,
  onImport,
  onExport,
  mode = "products",
}) => {
  const title = mode === "inventory" ? "Inventar" : "Produkte";
  const showCount = totalCount > 0;
  const isFiltered = filteredCount !== totalCount;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-bold text-txt-primary">{title}</h1>
        {showCount && (
          <span className="text-sm text-txt-muted">
            {isFiltered
              ? `${filteredCount} von ${totalCount}`
              : `${totalCount}`}{" "}
            {mode === "inventory" ? "Artikel" : "Produkte"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onCreateProduct && (
          <button
            type="button"
            onClick={onCreateProduct}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:bg-accent/90 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Produkt anlegen
          </button>
        )}
        {onImport && (
          <button
            type="button"
            onClick={onImport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3.5 py-2 text-sm font-medium text-txt-primary hover:bg-app-elevated transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
            Import
          </button>
        )}
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3.5 py-2 text-sm font-medium text-txt-primary hover:bg-app-elevated transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
            Export
          </button>
        )}
      </div>
    </div>
  );
};

export default ProductsPageHeader;
