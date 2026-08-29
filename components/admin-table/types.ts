import React from "react";
import { Product, SyncStatus, Readiness } from "../../types";

export type ColumnId =
  | "thumbnail"
  | "images"
  | "nameBrand"
  | "category"
  | "sku"
  | "barcode"
  | "mpn"
  | "weight"
  | "price"
  | "inventory"
  | "pendingIntake"
  | "storage"
  | "ebay"
  | "kaufland"
  | "lastSold"
  | "syncStatus"
  | "saveStatus"
  | "lastSaved"
  | "lastSynced"
  | "readiness"
  | "revision"
  | "sold"
  | "notizen"
  | "createdAt"
  | "erfasstVon";

export type ColumnPreset = "standard" | "warehouse" | "pricing" | "minimal";

// EINE Quelle fuer die Spalten-Presets — vorher als handgepflegte Kopie in
// AdminTable.tsx UND AdminTableFilters.tsx ("Muss uebereinstimmen").
// 'erfasstVon' ist admin-only: fuer Nicht-Admins existiert die Spalten-
// Definition nicht, die Id wird beim Rendern schlicht ignoriert.
export const COLUMN_PRESETS: Record<ColumnPreset, ColumnId[]> = {
  standard: [
    "thumbnail",
    "images",
    "nameBrand",
    "sku",
    "barcode",
    "category",
    "price",
    "inventory",
    "sold",
    "notizen",
    "pendingIntake",
    "storage",
    "ebay",
    "kaufland",
    "readiness",
    "createdAt",
    "erfasstVon",
    "lastSaved",
  ],
  warehouse: [
    "nameBrand",
    "sku",
    "barcode",
    "inventory",
    "sold",
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
    "sold",
    "pendingIntake",
    "ebay",
    "kaufland",
    "readiness",
  ],
};

export interface ColumnDefinition {
  id: ColumnId;
  label: string;
  sortKey?: string;
  defaultVisible?: boolean;
  widthClass?: string;
  render: (args: {
    product: Product;
    onSelectProduct: (id: string) => void;
  }) => React.ReactNode;
}

/** @deprecated Ein-Spalten-Sortierung — ersetzt durch SortLevel[] (Multi-Sort). */
export type SortConfig = { key: string; direction: "asc" | "desc" } | null;

export type { SortLevel, SortDirection } from "../../utils/productSort";

export type { Product, SyncStatus, Readiness };

export type ProductBulkActionName =
  | "price"
  | "title"
  | "category"
  | "ktype"
  | "validate"
  | "export_marketplace"
  | "kaufland_create"
  | "kaufland_update"
  | "title_cleanup"
  | "highlights_html"
  | "description_html"
  | "listing_readiness";
