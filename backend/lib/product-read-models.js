'use strict';

// Explicit read contracts. These projected objects must never be persisted.
// Detail/edit endpoints and all operational stock writers still load full docs.
const PRODUCT_TABLE_FIELDS = [
  'id', 'tenantId', 'identification', 'details', 'inventory', 'storage', 'storageBins',
  'completeness', 'pricing', 'marketplace', 'marketplace_listings', 'binCode', 'createdAt', 'updatedAt',
  ...[
    'sync_status', 'last_saved_iso', 'last_synced_iso', 'created_at_iso', 'identified_by',
    'base_product_id', 'pending_intake_quantity', 'revision', 'condition_locked',
    'listingStatus', 'sourceLot', 'sourceLotAt', 'readiness', 'readiness_editor',
    'readiness_set_at', 'autoImprove', 'ebay', 'kaufland', 'avy_category', 'relocation',
    'identify', 'image_cleanup',
  ].map(field => `ops.${field}`),
];
const MARKETPLACE_PRODUCT_FIELDS = [
  'id', 'tenantId', 'identification', 'details.identifiers', 'details.pricing.sellPrice',
  'details.images', 'details.category', 'details.categoryId',
  'inventory', 'storageBins', 'storage', 'binCode',
];
const FINANCE_PRODUCT_FIELDS = [
  'id', 'tenantId', 'identification.sku', 'identification.barcodes',
  'details.identifiers', 'details.pricing.buyPrice', 'details.pricing.sellPrice',
  'details.pricing.lowest_price.amount', 'inventory.quantity', 'ops.sourceLot',
];
const FINANCE_ORDER_FIELDS = [
  'tenantId', 'omsStatus', 'status', 'statusLabel', 'createdAt', 'updatedAt',
  'marketplace', 'source', 'items', 'totalAmount',
];
const FINANCE_LISTING_FIELDS = [
  'tenantId', 'active', 'listingStatus', 'startTime', 'endedAtIso', 'endTime', 'lastSeenAt',
];
module.exports = {
  PRODUCT_TABLE_FIELDS, MARKETPLACE_PRODUCT_FIELDS, FINANCE_PRODUCT_FIELDS,
  FINANCE_ORDER_FIELDS, FINANCE_LISTING_FIELDS,
};
