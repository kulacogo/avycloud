
// Based on the provided JSON Schema

export type IdentificationMethod = "image" | "barcode" | "hybrid";
export type ImageSource = "upload" | "generated" | "web";
export type ImageVariant = "front" | "angle" | "detail" | "pack" | "other";
export type SyncStatus = "pending" | "synced" | "failed";

export interface Completeness {
  percent: number;
  missing: string[];
  total: number;
  filled: number;
  complete: boolean;
}

export type QualitySeverity = 'error' | 'warn' | 'info';

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  message: string;
  fields: string[];
  evidence_urls?: string[];
  confidence?: number;
  source?: string;
}

export interface QualityGateV1 {
  id: string;
  version: number;
  checked_at_iso: string;
  duration_ms?: number;
  ok: boolean;
  summary?: string;
  issues: QualityIssue[];
  evidence?: any;
  modelUsed?: string | null;
  reason?: string;
  requestedBy?: string;
  revision_checked?: number | null;
}

export interface DataQualityOps {
  quality_gate_v1?: QualityGateV1;
  last_quality_gate_iso?: string;
  [key: string]: any;
}

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
  sellPrice?: number;         // User-set sell price (used by eBay + Kaufland sync)
  buyPrice?: number;          // Purchase price / cost basis
  suggestedPrice?: number;    // Pricing Engine suggestion
  pricingTier?: number;       // 1=EAN match, 2=category match, 0=cost-plus
  pricingConfidence?: number; // 0.0-1.0
  pricingMatchBasis?: string; // Human-readable explanation
  lastPriceCheck?: string;    // ISO-8601 timestamp
  competitorPrices?: CompetitorListing[]; // Stored by background refresh runner
}

export interface CompetitorListing {
  marketplace: 'ebay' | 'kaufland';
  seller?: string;
  title: string;
  price: number;
  currency: string;
  shippingCost?: number;
  url?: string;
}

export interface CompetitorPricesResponse {
  ebay: CompetitorListing[];
  kaufland: CompetitorListing[];
  cached: boolean;
  fetched_at: string;
}

export interface PriceHistoryEntry {
  id: string;
  productId: string;
  competitor: string;
  marketplace: string;
  price: number;
  currency: string;
  source: string;
  title?: string | null;
  url?: string | null;
  timestamp: string;
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
  isbn?: string;
  mpn?: string;
  sku?: string;
}

export interface Details {
  short_description: string;
  key_features: string[];
  attributes: Record<string, string | number | boolean>;
  attributes_extra?: Record<string, unknown>;
  identifiers: Identifiers;
  images: ProductImage[];
  pricing: Pricing;
  // canonical eBay category id (see backend enforceEbayAspects)
  categoryId?: string;
  gpsr?: {
    entity_country?: string;
    country_code?: string; // ISO-like code (see backend normalization)
    manufacturer_name?: string;
    manufacturer_address?: string;
    manufacturer_city?: string;
    manufacturer_postalcode?: string;
    manufacturer_state_province?: string;
    email?: string;
    manufacturer_phone?: string;
    url?: string;
  };
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
  data_quality?: DataQualityOps;
  condition_locked?: boolean;
  listingStatus?: {
    ebay?: 'active' | 'inactive' | 'not_listed';
    kaufland?: 'active' | 'inactive' | 'not_listed';
    lastSyncAt?: string | null;
  };
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
  quantity?: number;
  unit?: string;
  inventoryId?: string | null;
  inventoryName?: string | null;
  // Derived quantities (physical/reserved/available) for warehouse flow
  physicalQuantity?: number;
  reservedQuantity?: number;
  availableQuantity?: number;
}

export interface InventoryRecord {
  inventoryId: string;
  name: string;
  description?: string;
  vendorCode?: string | null;
  fiscalYear?: number | null;
  sequence?: number | null;
  type?: string | null;
  defaultWarehouse?: string | null;
  defaultPriceGroup?: string | null;
  isActive?: boolean;
  isExternal?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Product {
  id: string; // Not in original schema, but needed for React keys and state management. Usually EAN or a generated hash.
  identification: Identification;
  details: Details;
  ops: Ops;
  completeness?: Completeness;
  notes?: Notes;
  inventory?: InventoryInfo; // legacy, to be ignored
  storage?: ProductStorageLocation | null;
  storageBins?: ProductStorageBinEntry[];
  marketplace_listings?: {
    ebay?: { title: string; description: string; categoryId: string; categoryName: string; attributes: Record<string, string>; validation: { ready: boolean; issues: { severity: string; message: string }[] } };
    kaufland?: { title: string; description: string; categoryId: string; categoryName: string; attributes: Record<string, string>; validation: { ready: boolean; issues: { severity: string; message: string }[] } };
    generated_at?: string;
    [key: string]: unknown;
  };
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
  categoryId?: string;
  categoryPath?: string;
  short_description?: string;
  key_features?: string[];
  attributes?: Record<string, string | number | boolean>;
  gpsr?: {
    entity_country?: string;
    country_code?: string;
    manufacturer_name?: string;
    manufacturer_address?: string;
    manufacturer_city?: string;
    manufacturer_postalcode?: string;
    manufacturer_state_province?: string;
    email?: string;
    manufacturer_phone?: string;
    url?: string;
  };
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

export type OrderStatus = 'new' | 'picking' | 'picked' | 'packed' | 'other';

export type OmsStatus = 'pending' | 'confirmed' | 'picking' | 'picked' | 'packing' | 'packed' | 'shipped' | 'delivered' | 'completed' | 'cancelled' | 'returned' | 'on_hold';

/** Resolve effective OMS status from an order — prefers omsStatus, falls back to legacy status. */
export function getOrderStatus(order: Order): OmsStatus {
  return (order.omsStatus || order.status || 'pending') as OmsStatus;
}

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
  taxRate?: number;
  currency?: string;
  pickHint?: OrderItemPickHint | null;
  pickCompleted?: boolean;
}

export interface OrderCustomer {
  name?: string | null;
  street?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface Order {
  id: string;
  orderId?: string;
  orderSource?: string | null;
  orderSourceId?: string | null;
  number?: string | null;
  source: string;
  marketplace?: string | null;
  marketplaceOrderId?: string | null;
  status: OrderStatus;
  omsStatus?: OmsStatus;
  omsStatusLabel?: string;
  statusLabel: string;
  statusId?: string | null;
  createdAt: string;
  updatedAt: string;
  pickedAt?: string | null;
  packedAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  currency?: string;
  totalAmount?: number;
  customer: OrderCustomer;
  items: OrderItem[];
  notes?: string | null;
  paymentStatus?: string | null;
  shippingService?: string | null;
  trackingNumber?: string | null;
  weight?: number | null;
  buyerNote?: string | null;
  vatRate?: number;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  deliveryNoteNumber?: string | null;
}

export interface OrderTimelineEvent {
  id: string;
  event: string;
  fromStatus: string;
  toStatus: string;
  fromStatusLabel: string;
  toStatusLabel: string;
  actor?: { uid: string; email: string } | null;
  note?: string | null;
  timestamp: string;
}

/* ─── Return Enums ─── */
export type ReturnReason = 'defekt' | 'falsche_lieferung' | 'nicht_wie_beschrieben' | 'zu_spaet' | 'meinungsaenderung' | 'doppelbestellung' | 'sonstiges';
export type ReturnItemCondition = 'a_ware' | 'b_ware' | 'c_ware';
export type ReturnRefundType = 'vollerstattung' | 'teilerstattung' | 'gutschrift' | 'umtausch';
export type ReturnStatus = 'eingegangen' | 'neu' | 'in_pruefung' | 'erstattet' | 'teilweise_erstattet' | 'abgelehnt' | 'abgeschlossen';

export interface DashboardMetricsDay {
  // Bucket start (UTC). Format depends on bucket type:
  // - day/week/month: YYYY-MM-DD
  // - hour: full ISO timestamp (e.g. 2026-02-11T08:00:00.000Z)
  date: string;
  orders: number;
  revenue: number;
}

export interface DashboardMetrics {
  generated_at_iso: string;
  range?: {
    preset?: string | null;
    label?: string;
    from_iso?: string;
    to_iso?: string;
    bucket?: 'hour' | 'day' | 'week' | 'month';
    bucket_step_hours?: number;
    bucket_step_days?: number;
    days?: number;
    buckets?: number;
  };
  currency: string;
  revenue: {
    total: number;
    month: number;
    month_start_iso: string;
    all_non_cancelled_total?: number;
    window_non_cancelled_total?: number;
    window_start_iso?: string;
    window_days?: number;
    payout_brutto_window?: number;
    payout_brutto_ytd?: number;
    payout_source?: string;
  };
  orders: {
    open_current: number;
    completed_total: number;
    completed_month: number;
    returns_total: number;
    returns_month: number;
    status_breakdown?: {
      neu: number;
      kommissioniert: number;
      verpackt: number;
      versendet: number;
      zugestellt: number;
      cancelled: number;
      other: number;
    };
  };
  volume_7d: {
    window_days: number;
    days: DashboardMetricsDay[];
  };
}

export interface FinanceAccountBalance {
  id: string;
  name: string;
  balance: number;
  currency: string;
}

export interface FinanceShipping {
  total_cost: number;
  parcel_count: number;
  dhl_count?: number;
  dpd_count?: number;
  direct_dhl_cost_netto?: number;
  source?: string;
  currency: string;
  from_date: string;
  to_date: string;
}

export interface FinanceMetrics {
  generated_at_iso: string;
  accounts: FinanceAccountBalance[];
  total_balance: number;
  shipping: FinanceShipping | null;
  shipping_ytd: FinanceShipping | null;
  errors: string[];
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

export interface EbayCategoryOption {
  id: string;
  breadcrumb: string;
  name?: string;
  leaf?: boolean;
}

export type EbayAspectUsage = 'RECOMMENDED' | 'OPTIONAL';

export interface EbayAspectCatalogRow {
  name: string;
  required: boolean;
  usage: EbayAspectUsage | null;
  dataType: string | null;
  advancedDataType: string | null;
  mode: string | null;
  format: string | null;
  itemToAspectCardinality: string | null;
  maxLength: number | null;
  enabledForVariations: boolean | null;
  applicableTo: string[];
  expectedRequiredByDate: string | null;
  valuesCount: number;
}

export interface EbayCategoryTaxonomyEntry {
  id: string;
  name: string;
  breadcrumb: string;
  root?: string;
  leaf?: boolean;
  banned?: boolean;
}

export interface EbayCategoryAspectCatalog {
  categoryId: string | null;
  hasCatalogEntry?: boolean;
  hasAspectData: boolean;
  requiredAspects: string[];
  recommendedAspects: string[];
  optionalAspects: string[];
  allAspects: string[];
  aspects: EbayAspectCatalogRow[];
}

export interface EbayTaxonomyCategoriesResponse {
  ok: true;
  data: {
    items: EbayCategoryTaxonomyEntry[];
    total: number;
    includeBanned: boolean;
    leafOnly: boolean;
  };
}

export interface EbayTaxonomyCategoryAspectsResponse {
  ok: true;
  data: {
    category: EbayCategoryTaxonomyEntry;
    catalog: EbayCategoryAspectCatalog;
  };
}

export interface EbayListingRow {
  itemId: string;
  sku?: string | null;
  title?: string | null;
  subtitle?: string | null;
  listingType?: string | null;
  listingStatus?: string | null;
  active?: boolean;
  primaryCategoryId?: string | null;
  productId?: string | null;
  matchStatus?: 'matched' | 'ambiguous' | 'unmatched' | string;
  matchMethod?: string | null;
  matchConfidence?: number | null;
  gapCount?: number;
  gapCriticalCount?: number;
  gapReadyCount?: number;
  gapDocUpdatedAt?: string | null;
  updatedAt?: string | null;
  viewItemUrl?: string | null;
  currentPrice?: number | null;
  currency?: string | null;
  quantityAvailable?: number | null;
  categoryName?: string | null;
  warehouseStock?: number | null;
  binLocation?: string | null;
  stockMismatch?: boolean;
}

export interface EbayListingLink {
  itemId: string;
  status?: 'matched' | 'ambiguous' | 'unmatched' | string;
  method?: string | null;
  confidence?: number | null;
  productId?: string | null;
  candidateProductIds?: string[];
}

export interface EbayGapSuggestion {
  from?: string;
  to?: string;
  missingOnEbay?: string[];
  extraOnEbay?: string[];
  [key: string]: any;
}

export interface EbayGap {
  id: string;
  type: string;
  field: string;
  severity: 'critical' | 'warn' | 'info' | string;
  status:
    | 'new'
    | 'reviewed'
    | 'accepted'
    | 'ignored'
    | 'ready_to_sync'
    | 'synced'
    | 'failed'
    | string;
  listingValue?: any;
  avyValue?: any;
  message?: string | null;
  suggestion?: EbayGapSuggestion | null;
  syncDirection?: 'accept_avy' | 'accept_ebay' | string;
}

export interface EbayGapDoc {
  itemId: string;
  listingSku?: string | null;
  productId?: string | null;
  linkStatus?: string | null;
  summary?: {
    total?: number;
    critical?: number;
    warn?: number;
    info?: number;
    byStatus?: Record<string, number>;
  };
  gaps?: EbayGap[];
  updatedAtIso?: string | null;
}

export interface EbayListingDetail {
  listing: Record<string, any> & { itemId: string };
  link?: EbayListingLink | null;
  product?: Record<string, any> | null;
  gaps?: EbayGapDoc | null;
}

export interface EbaySyncDryRunItem {
  itemId: string;
  callName?: string | null;
  canApply: boolean;
  blockers: string[];
  warnings: string[];
  patch?: Record<string, any> | null;
  touchedGapIds?: string[];
}

export interface EbaySyncDryRunResult {
  summary: {
    total: number;
    ready: number;
    blocked: number;
  };
  items: EbaySyncDryRunItem[];
}

export interface EbaySyncApplyResult {
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  results: Array<{
    itemId: string;
    ok: boolean;
    skipped?: boolean;
    message?: string;
    callName?: string;
    ack?: string;
    touchedGapIds?: string[];
  }>;
  dryRun?: {
    total: number;
    ready: number;
    blocked: number;
  };
}

// --- eBay Publish types ---

export interface EbayPublishOverrides {
  title?: string;
  subtitle?: string;
  primaryCategoryId?: string;
  description?: string;
  startPrice?: number;
  price?: number;
  currency?: string;
  quantity?: number;
  conditionId?: string;
  sku?: string;
  pictureUrls?: string[];
  ean?: string;
  isbn?: string;
  mpn?: string;
  brand?: string;
  itemSpecifics?: Record<string, string[]>;
  country?: string;
  postalCode?: string;
  location?: string;
  listingDuration?: string;
  dispatchTimeMax?: number;
  shippingProfileId?: string;
  returnProfileId?: string;
  paymentProfileId?: string;
}

export interface EbayPublishFee {
  name: string;
  amount: string;
  currency?: string | null;
}

export interface EbayPublishVerifyResult {
  productId: string;
  canPublish: boolean;
  blockers: string[];
  warnings: string[];
  fees: EbayPublishFee[] | null;
  item?: Record<string, any>;
}

export interface EbayPublishResult {
  productId: string;
  ok: boolean;
  itemId?: string;
  ack?: string;
  blockers?: string[];
  warnings: string[];
  fees?: EbayPublishFee[];
  startTime?: string | null;
  endTime?: string | null;
}

export interface EbayBulkPublishVerifyResult {
  summary: { total: number; ready: number; blocked: number };
  items: EbayPublishVerifyResult[];
}

export interface EbayBulkPublishResult {
  summary: { total: number; success: number; failed: number };
  results: EbayPublishResult[];
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
  gtin_confidence?: number;
  ean_confidence?: number;
  barcode_sources?: Array<{
    code: string;
    length?: number;
    confidence?: number;
    sources?: string[];
  }>;
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


// ── Pre-Listing Validation (VAL-001) ──

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fields: string[];
  suggestion: string | null;
}

export interface ValidationMarketplaceResult {
  marketplace: string;
  score: number;
  ready: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  counts: { errors: number; warnings: number; info: number };
}

export interface ValidationResults {
  ebay?: ValidationMarketplaceResult;
  kaufland?: ValidationMarketplaceResult;
}

export interface ValidationBatchEntry {
  productId: string;
  productName: string | null;
  error?: string;
  ebay?: { score: number; ready: boolean; counts: { errors: number; warnings: number; info: number } };
  kaufland?: { score: number; ready: boolean; counts: { errors: number; warnings: number; info: number } };
}

export interface ValidationBatchResponse {
  ok: boolean;
  results: ValidationBatchEntry[];
  summary: { total: number; ebay_ready?: number; kaufland_ready?: number };
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
