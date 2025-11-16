
// Based on the provided JSON Schema

export type IdentificationMethod = "image" | "barcode" | "hybrid";
export type ImageSource = "upload" | "generated" | "web";
export type ImageVariant = "front" | "angle" | "detail" | "pack" | "other";
export type SyncStatus = "pending" | "synced" | "failed";

export interface PriceSource {
  name: string;
  url: string;
  price?: number;
  shipping?: number;
  checked_at?: string; // ISO-8601
}

export interface LowestPrice {
  amount: number;
  currency: string; // ISO code
  sources: PriceSource[];
  last_checked_iso?: string; // ISO-8601
}

export interface Pricing {
  lowest_price: LowestPrice;
  price_confidence: number; // 0.0 to 1.0
}

export interface ProductImage {
  source: ImageSource;
  variant?: ImageVariant | null;
  url_or_base64: string;
  notes?: string;
}

export interface Identifiers {
  ean?: string;
  gtin?: string;
  upc?: string;
  mpn?: string;
  sku?: string;
}

export interface Details {
  short_description: string;
  key_features: string[];
  attributes: Record<string, string | number | boolean>;
  identifiers: Identifiers;
  images: ProductImage[];
  pricing: Pricing;
}

export interface Identification {
  method: IdentificationMethod;
  barcodes?: string[];
  name: string;
  brand: string;
  category: string;
  confidence: number; // 0.0 to 1.0
}

export interface Ops {
  sync_status: SyncStatus;
  last_saved_iso?: string | null; // ISO-8601
  last_synced_iso?: string | null; // ISO-8601
  revision: number;
}

export interface Notes {
  unsure?: string[];
  warnings?: string[];
}

export interface Product {
  id: string; // Not in original schema, but needed for React keys and state management. Usually EAN or a generated hash.
  identification: Identification;
  details: Details;
  ops: Ops;
  notes?: Notes;
}

export interface ProductBundle {
  products: Product[];
  // The rendering part is optional and used for compatibility with backend responses
  rendering?: {
    format: string;
    datasheet_page: string;
    admin_table_page: string;
  };
}

export interface DatasheetChange {
  summary?: string;
  short_description?: string;
  key_features?: string[];
  attributes?: Record<string, string | number | boolean>;
  pricing?: Pricing;
  notes?: Notes;
}

export interface ImageSuggestionGroup {
  rationale?: string;
  images: ProductImage[];
}

export interface SerpInsight {
  engine: string;
  query: string;
  summary?: Array<{
    title?: string;
    price?: string | number;
    source?: string;
    url?: string;
    snippet?: string;
  }>;
  error?: string | null;
}
