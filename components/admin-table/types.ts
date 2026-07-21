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

export type SortConfig = { key: string; direction: "asc" | "desc" } | null;

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
