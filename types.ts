
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
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
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
  sku?: string;
}

export interface Ops {
  sync_status: SyncStatus;
  last_saved_iso?: string | null; // ISO-8601
  last_synced_iso?: string | null; // ISO-8601
  base_product_id?: string | null;
  pending_intake_quantity?: number;
  revision: number;
}

export interface Notes {
  unsure?: string[];
  warnings?: string[];
}

export interface ProductStorageLocation {
  binCode: string;
  zone: 'X' | 'XS' | 'S' | 'M' | 'L' | 'XL';
  etage: 'GA' | 'UG' | 'EG';
  gang: number;
  regal: number;
  ebene: string;
  quantity: number;
  assigned_at: string;
}

export interface ProductStorageBinEntry {
  code: string;
  quantity: number;
  zone?: WarehouseZoneCode;
  etage?: WarehouseEtageCode;
  gang?: number;
  regal?: number;
  ebene?: string;
  firstStoredAt?: string | null;
  lastUpdatedAt?: string | null;
}

export interface InventoryInfo {
  quantity: number;
  unit?: string;
}

export interface Product {
  id: string; // Not in original schema, but needed for React keys and state management. Usually EAN or a generated hash.
  identification: Identification;
  details: Details;
  ops: Ops;
  notes?: Notes;
  inventory?: InventoryInfo;
  storage?: ProductStorageLocation | null;
  storageBins?: ProductStorageBinEntry[];
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
  title?: string;
  identity?: Partial<Identification>;
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

export type WarehouseZoneCode = 'X' | 'XS' | 'S' | 'M' | 'L' | 'XL';
export type WarehouseEtageCode = 'GA' | 'UG' | 'EG';

export interface WarehouseLayout {
  id: string;
  zone: WarehouseZoneCode;
  etage: WarehouseEtageCode;
  gangs: number[];
  regale: number[];
  ebenen: string[];
  binCount: number;
  createdAt: string;
  totalProducts?: number;
}

export interface BinProductEntry {
  productId: string;
  name: string;
  sku?: string;
  quantity: number;
  firstStoredAt?: string | null;
  lastUpdatedAt?: string | null;
  image?: string | null;
}

export interface WarehouseBin {
  code: string;
  zone: WarehouseZoneCode;
  etage: WarehouseEtageCode;
  gang: number;
  regal: number;
  ebene: string;
  productCount: number;
  products: BinProductEntry[];
  createdAt: string;
  firstStoredAt?: string | null;
  lastStoredAt?: string | null;
}

export type OrderStatus = 'new' | 'picking' | 'picked';

export interface OrderItemPickHint {
  productId?: string | null;
  productName?: string | null;
  sku?: string | null;
  binCode?: string | null;
  quantityAvailable?: number | null;
  image?: string | null;
}

export interface OrderItem {
  id: string;
  productId?: string | null;
  name: string;
  sku?: string | null;
  quantity: number;
  ean?: string | null;
  priceBrutto?: number;
  currency?: string;
  pickHint?: OrderItemPickHint | null;
  pickCompleted?: boolean;
}

export interface OrderCustomer {
  name?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface Order {
  id: string;
  baselinkerId: string;
  number?: string | null;
  source: 'baselinker';
  status: OrderStatus;
  statusLabel: string;
  statusId?: string | null;
  createdAt: string;
  updatedAt: string;
  pickedAt?: string | null;
  currency?: string;
  totalAmount?: number;
  customer: OrderCustomer;
  items: OrderItem[];
  notes?: string | null;
}

export type IdentifyPhase =
  | 'idle'
  | 'upload'
  | 'queued'
  | 'processing'
  | 'enriching'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface IdentifyStatus {
  phase: IdentifyPhase;
  message: string;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
}

export type IdentificationJobStatus = 'pending' | 'processing' | 'failed' | 'done';

export interface IdentificationJobFileSummary {
  path: string | null;
  originalName: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface IdentificationJobProductSummary {
  id: string | null;
  name: string | null;
  sku: string | null;
}

export interface IdentificationJobPayloadSummary {
  locale?: string | null;
  model?: string | null;
  barcodes?: string;
  fileCount?: number;
  files?: IdentificationJobFileSummary[];
}

export interface IdentificationJobResultSummary {
  productCount: number;
  products: IdentificationJobProductSummary[];
}

export type ProductEnrichmentInputMode = 'product-image' | 'label';

export interface MarketplaceAttribute {
  key: string;
  value: string;
}

export interface ProductEnrichmentRecord {
  input_mode: ProductEnrichmentInputMode;
  brand: string;
  model: string;
  sku: string;
  variant: string;
  gtin: string;
  ean: string;
  upc: string;
  color: string;
  size: string;
  material: string;
  condition: string;
  internalCategory: string;
  ebayCategoryId: string;
  ebayCategoryPath: string;
  kauflandCategoryId: string;
  kauflandCategoryPath: string;
  title_ebay: string;
  title_kaufland: string;
  description_ebay: string;
  description_kaufland: string;
  item_specifics: MarketplaceAttribute[];
  attributes_kaufland: MarketplaceAttribute[];
  heroImageUrl: string | null;
  galleryImageUrls: string[];
}

export interface IdentificationJob {
  id: string;
  status: IdentificationJobStatus;
  attempts: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  model?: string | null;
  payload?: IdentificationJobPayloadSummary | null;
  error?: {
    message?: string;
  } | null;
  result?: IdentificationJobResultSummary | null;
  reuseEvents?: any[];
}
