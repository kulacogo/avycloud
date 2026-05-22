'use strict';

/**
 * batch-optimize.js — Batch "Alles optimieren" for products with BIN but not listed on eBay.
 *
 * Reuses the full Gemini v2 chat pipeline (Google Search Grounding + function calling)
 * with the exact same prompt as the UI "Alles optimieren" quick-action.
 *
 * Changes are auto-accepted (no manual review) and saved via saveProductV2().
 *
 * Safety:
 * - Runs sequentially (1 product at a time) to respect Gemini rate limits
 * - Each product save goes through full saveProduct() business logic
 * - Errors on individual products don't abort the batch
 * - Full result log returned for audit
 */

const { firestore, getProduct, PRODUCTS_COLLECTION } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { runProductChatV2 } = require('./product-chat-v2');
const { normalizeDigits, isValidGtin } = require('../lib/gtin');

// "Alles optimieren" — exact message + scope from frontend GeminiChat.tsx (line 278)
const OPTIMIZE_ALL_MESSAGE = 'Optimiere Titel, Beschreibung, Highlights und Attribute. Recherchiere online und schlage konkrete Verbesserungen vor.';
const OPTIMIZE_ALL_SCOPE = 'title,attributes,highlights,description';

// Rate-limit delay between products (Gemini quota protection)
const DELAY_BETWEEN_PRODUCTS_MS = parseInt(process.env.BATCH_OPTIMIZE_DELAY_MS || '3000', 10);

// ---------------------------------------------------------------------------
// Filter: BIN assigned + NOT listed on eBay
// (matches frontend AdminTable.tsx logic exactly)
// ---------------------------------------------------------------------------

function hasBinAssignment(product) {
  // Primary storage location
  if (product?.storage?.binCode) return true;
  // Multiple bins — frontend checks array length only (no binCode check on elements)
  if (Array.isArray(product?.storageBins) && product.storageBins.length > 0) return true;
  return false;
}

/**
 * Build eBay "listed" lookup sets from Firestore — mirrors the frontend's
 * fetchEbaySkuIndex() + AdminTable isEbayListed logic.
 *
 * A product counts as "listed on eBay" if ANY of:
 *   1. ops.listingStatus.ebay === 'active'
 *   2. Product SKU found in ebayListingsLive (active=true)
 *   3. Product ID found in ebayListingLinks (status=matched, itemId active)
 *   4. marketplace.ebay.itemId is in active eBay item IDs
 */
async function buildEbayListedSets() {
  const [liveSnap, linksSnap] = await Promise.all([
    firestore.collection('ebayListingsLive').where('active', '==', true).get(),
    firestore.collection('ebayListingLinks').where('status', '==', 'matched').get(),
  ]);

  const activeItemIds = new Set();
  const listedSkus = new Set();
  const listedProductIds = new Set();

  // Active eBay listings → SKUs + itemIds
  liveSnap.docs.forEach((doc) => {
    const d = doc.data() || {};
    activeItemIds.add(doc.id);
    const rawList = Array.isArray(d.skuIndex) ? d.skuIndex : d.sku ? [d.sku] : [];
    for (const v of (Array.isArray(rawList) ? rawList : [rawList])) {
      const s = String(v || '').trim().toUpperCase();
      if (s) listedSkus.add(s);
    }
  });

  // Matched links → productIds (only if itemId is still active)
  linksSnap.docs.forEach((doc) => {
    if (!activeItemIds.has(doc.id)) return;
    const d = doc.data() || {};
    if (d.productId) listedProductIds.add(d.productId);
  });

  return { activeItemIds, listedSkus, listedProductIds };
}

function normalizeSku(v) {
  return String(v || '').trim().toUpperCase();
}

function isEbayListed(product, ebayIndex) {
  // 1. Canonical status
  if (product?.ops?.listingStatus?.ebay === 'active') return true;

  // 2. SKU in active listings
  const skuCandidates = [
    normalizeSku(product?.details?.identifiers?.sku),
    normalizeSku(product?.identification?.sku),
  ].filter(Boolean);
  if (skuCandidates.some(sku => ebayIndex.listedSkus.has(sku))) return true;

  // 3. Product ID in matched links
  if (product?.id && ebayIndex.listedProductIds.has(product.id)) return true;

  // 4. marketplace.ebay.itemId in active items
  const marketplaceItemId = String(product?.marketplace?.ebay?.itemId || '').trim();
  if (marketplaceItemId && ebayIndex.activeItemIds.has(marketplaceItemId)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Sold enrichment — mirrors routes/products.js buildSoldQuantityMap +
// attachReservedAvailability so we use live order data, not stale inventory
// ---------------------------------------------------------------------------

// HARDEN-Wave-7 (2026-05-22): aus zentralem Helper statt inline dupliziert.
const {
  EXCLUDED_ORDER_STATUSES,
  SHIPPED_ORDER_STATUSES,
  normalizeSkuKey,
} = require('../lib/order-status-helpers');

async function buildSoldQuantityMap() {
  const map = new Map();
  try {
    const snap = await firestore.collection('orders').get();
    snap.forEach((doc) => {
      const order = doc.data() || {};
      const status = (order.omsStatus || order.status || '').toLowerCase();
      if (!status || EXCLUDED_ORDER_STATUSES.has(status)) return;
      const items = Array.isArray(order.items) ? order.items : [];
      const isShipped = SHIPPED_ORDER_STATUSES.has(status);
      for (const item of items) {
        const key = normalizeSkuKey(item?.sku || item?.productId || '');
        const qty = Number(item?.quantity || 0);
        if (!key || qty <= 0) continue;
        const entry = map.get(key) || { sold: 0, open: 0 };
        if (isShipped) { entry.sold += qty; } else { entry.open += qty; }
        map.set(key, entry);
      }
    });
  } catch (error) {
    console.warn('[batch-optimize] buildSoldQuantityMap failed:', error.message);
  }
  return map;
}

function enrichWithSoldData(products, soldMap) {
  return products.map((product) => {
    const skuCandidate =
      product?.details?.identifiers?.sku || product?.identification?.sku || product?.id;
    const key = normalizeSkuKey(skuCandidate);
    const soldEntry = key ? soldMap.get(key) : null;
    const soldQuantity = soldEntry ? soldEntry.sold : 0;
    const openOrderQuantity = soldEntry ? soldEntry.open : 0;
    return {
      ...product,
      inventory: {
        ...(product.inventory || {}),
        soldQuantity,
        openOrderQuantity,
      },
    };
  });
}

function isNotSold(product) {
  const soldQuantity = Number(product?.inventory?.soldQuantity || 0) || 0;
  const openOrders = Number(product?.inventory?.openOrderQuantity || product?.inventory?.openOrders || 0) || 0;
  return soldQuantity <= 0 && openOrders <= 0;
}

/**
 * Ghost product filter — mirrors routes/products.js isGhostProduct().
 * Ghost = stub docs with no meaningful data (no name, SKU, barcode, images, etc.)
 */
function isGhostProduct(product = {}) {
  const identification = product?.identification || {};
  const details = product?.details || {};
  const identifiers = details?.identifiers || {};
  const ops = product?.ops || {};

  const hasName = typeof identification?.name === 'string' && identification.name.trim().length > 0;
  const hasSku =
    (typeof identification?.sku === 'string' && identification.sku.trim().length > 0) ||
    (typeof identifiers?.sku === 'string' && identifiers.sku.trim().length > 0);
  const hasBarcode =
    Boolean(identifiers?.ean || identifiers?.gtin || identifiers?.upc) ||
    (Array.isArray(identification?.barcodes) && identification.barcodes.length > 0);
  const hasImages = Array.isArray(details?.images) && details.images.length > 0;
  const hasAttrs = details?.attributes && typeof details.attributes === 'object' && Object.keys(details.attributes).length > 0;
  const hasPricing = Boolean(details?.pricing?.lowest_price?.amount);
  const hasPendingIntake = Number(ops?.pending_intake_quantity || 0) > 0;
  const hasOpsLink = Boolean(ops?.sync_status);

  const invQty = Number(product?.inventory?.quantity || 0);
  const hasStock =
    (Number.isFinite(invQty) && invQty > 0) ||
    Boolean(product?.storage?.binCode) ||
    (Array.isArray(product?.storageBins) && product.storageBins.some((b) => Number(b?.quantity || 0) > 0));

  return !(
    hasName || hasSku || hasBarcode || hasImages || hasAttrs ||
    hasPricing || hasPendingIntake || hasOpsLink || hasStock
  );
}

function isEligibleForBatchOptimize(product, ebayIndex) {
  if (!product?.id) return false;
  if (isGhostProduct(product)) return false;
  return hasBinAssignment(product) && !isEbayListed(product, ebayIndex) && isNotSold(product);
}

// ---------------------------------------------------------------------------
// Auto-accept: Apply Gemini datasheetChanges to product (backend equivalent
// of frontend applyAssistantChange in ProductSheet.tsx)
// ---------------------------------------------------------------------------

function applyChangesToProduct(product, change) {
  if (!change || typeof change !== 'object') return product;

  const next = JSON.parse(JSON.stringify(product));
  next.identification = next.identification || {};
  next.details = next.details || {};

  // 1. Identity / Title
  if (change.identity || change.title) {
    if (change.title) {
      next.identification.name = change.title;
    }
    if (change.identity) {
      if (change.identity.name) next.identification.name = change.identity.name;
      if (change.identity.brand) next.identification.brand = change.identity.brand;
      if (change.identity.category) {
        // Only accept categories validated against local eBay taxonomy
        const { findEbayCategory } = require('../lib/ebay-taxonomy');
        const resolved = findEbayCategory(change.identity.category);
        if (resolved?.id) {
          next.identification.category = resolved.breadcrumb;
          next.details.categoryId = String(resolved.id);
        }
      }
      if (change.identity.sku) next.identification.sku = change.identity.sku;

      // Barcodes: merge + validate
      if (Array.isArray(change.identity.barcodes) && change.identity.barcodes.length) {
        const existing = Array.isArray(next.identification.barcodes) ? next.identification.barcodes : [];
        const merged = new Set([...existing, ...change.identity.barcodes]);
        next.identification.barcodes = Array.from(merged)
          .map(b => normalizeDigits(String(b)))
          .filter(b => b && isValidGtin(b));
      }
    }
  }

  // 1.5 eBay category — only accept taxonomy-validated categories
  if (change.categoryId || change.categoryPath) {
    const { findEbayCategory } = require('../lib/ebay-taxonomy');
    const resolved =
      (change.categoryId ? findEbayCategory(String(change.categoryId).replace(/\D+/g, '')) : null) ||
      (change.categoryPath ? findEbayCategory(change.categoryPath) : null);
    if (resolved?.id) {
      next.details.categoryId = String(resolved.id);
      next.identification.category = resolved.breadcrumb;
    }
  }

  // 2. Short description
  if (change.short_description) {
    next.details.short_description = change.short_description;
  }

  // 3. Key features
  if (Array.isArray(change.key_features) && change.key_features.length > 0) {
    next.details.key_features = change.key_features;
  }

  // 3.5 GPSR (merge)
  if (change.gpsr && typeof change.gpsr === 'object') {
    next.details.gpsr = {
      ...(next.details.gpsr || {}),
      ...change.gpsr,
    };
  }

  // 4. Attributes (merge, with filtering)
  if (change.attributes && typeof change.attributes === 'object') {
    const attrs = Array.isArray(change.attributes) ? change.attributes : Object.entries(change.attributes).map(([k, v]) => ({ key: k, value: v }));
    const cleanedIncoming = {};

    for (const attr of (Array.isArray(attrs) ? attrs : [])) {
      const key = typeof attr === 'object' && attr?.key ? String(attr.key).trim() : (typeof attr === 'string' ? attr : '');
      const value = typeof attr === 'object' ? String(attr?.value ?? '').trim() : '';
      if (!key || !value) continue;

      const keyLower = key.toLowerCase();

      // GPSR keys → redirect to gpsr object
      if (keyLower.startsWith('gpsr ') || keyLower.startsWith('gpsr_')) {
        next.details.gpsr = next.details.gpsr || {};
        if (keyLower.includes('manufacturer') && keyLower.includes('name')) {
          next.details.gpsr.manufacturer_name = value;
          continue;
        }
        if (keyLower.includes('manufacturer') && (keyLower.includes('address') || keyLower.includes('adresse'))) {
          next.details.gpsr.manufacturer_address = value;
          continue;
        }
        if (keyLower.includes('email') || keyLower.includes('e-mail')) {
          next.details.gpsr.email = value;
          continue;
        }
        if (keyLower.includes('url') || keyLower.includes('website') || keyLower.includes('webseite')) {
          next.details.gpsr.url = value;
          continue;
        }
        continue;
      }

      // Skip marketplace keys
      if (keyLower.includes('ebay') || keyLower.includes('kaufland')) continue;

      // Barcode keys → redirect to barcodes
      if (/^(ean|gtin|upc|barcode|barcodes|ean\/gtin)$/i.test(keyLower) || keyLower.includes('ean') || keyLower.includes('gtin') || keyLower.includes('upc')) {
        const digits = normalizeDigits(String(value));
        if (digits && isValidGtin(digits)) {
          next.identification.barcodes = next.identification.barcodes || [];
          const merged = new Set([...next.identification.barcodes, digits]);
          next.identification.barcodes = Array.from(merged);
        }
        continue;
      }

      cleanedIncoming[key] = value;
    }

    // If attributes came as a plain object (after sanitization in product-chat-v2), handle that too
    if (!Array.isArray(change.attributes) && typeof change.attributes === 'object') {
      for (const [key, value] of Object.entries(change.attributes)) {
        if (!key) continue;
        const keyLower = key.toLowerCase();
        if (keyLower.startsWith('gpsr') || keyLower.includes('ebay') || keyLower.includes('kaufland')) continue;
        if (/ean|gtin|upc|barcode/i.test(keyLower)) continue;
        cleanedIncoming[key] = typeof value === 'string' ? value : String(value ?? '');
      }
    }

    next.details.attributes = {
      ...(next.details.attributes || {}),
      ...cleanedIncoming,
    };
  }

  // 5. Pricing
  if (change.pricing) {
    next.details.pricing = {
      ...(next.details.pricing || {}),
      ...change.pricing,
      lowest_price: {
        ...(next.details.pricing?.lowest_price || {}),
        ...(change.pricing?.lowest_price || {}),
      },
    };
  }

  // 6. Notes
  if (change.notes) {
    const mergeUnique = (a, b) => {
      const left = Array.isArray(a) ? a : [];
      const right = Array.isArray(b) ? b : [];
      const out = [];
      const seen = new Set();
      for (const item of [...left, ...right]) {
        const s = item == null ? '' : String(item).trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
      }
      return out;
    };
    next.notes = {
      unsure: mergeUnique(next.notes?.unsure, change.notes?.unsure),
      warnings: mergeUnique(next.notes?.warnings, change.notes?.warnings),
    };
  }

  return next;
}

// ---------------------------------------------------------------------------
// Main batch function
// ---------------------------------------------------------------------------

/**
 * Run "Alles optimieren" on all eligible products (BIN assigned, not on eBay).
 *
 * @param {object} opts
 * @param {number} [opts.limit]           Max products to process (0 = all)
 * @param {number} [opts.offset]          Skip first N eligible products
 * @param {boolean} [opts.dryRun=false]   If true, run Gemini but don't save
 * @param {string} [opts.tenantId]        Tenant filter (required for multi-tenant)
 * @param {Function} [opts.onProgress]    Progress callback: ({ current, total, productId, status })
 * @returns {Promise<object>} Summary with per-product results
 */
async function runBatchOptimize({
  limit = 0,
  offset = 0,
  dryRun = false,
  tenantId = null,
  onProgress = null,
} = {}) {
  const startedAt = Date.now();
  console.log(`[batch-optimize] Starting... dryRun=${dryRun}, limit=${limit}, offset=${offset}, tenantId=${tenantId || 'none'}`);

  // 1. Fetch all products
  let query = firestore.collection(PRODUCTS_COLLECTION);
  if (tenantId) {
    query = query.where('tenantId', '==', tenantId);
  }
  const snapshot = await query.get();
  const allProducts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  console.log(`[batch-optimize] Loaded ${allProducts.length} products total`);

  // 2. Enrich with live sold data from orders + build eBay index
  const [soldMap, ebayIndex] = await Promise.all([
    buildSoldQuantityMap(),
    buildEbayListedSets(),
  ]);
  const enrichedProducts = enrichWithSoldData(allProducts, soldMap);
  console.log(`[batch-optimize] eBay index: ${ebayIndex.activeItemIds.size} active items, ${ebayIndex.listedSkus.size} SKUs, ${ebayIndex.listedProductIds.size} linked products`);
  console.log(`[batch-optimize] Sold map: ${soldMap.size} SKUs with order activity`);
  let eligible = enrichedProducts.filter(p => isEligibleForBatchOptimize(p, ebayIndex));
  console.log(`[batch-optimize] ${eligible.length} products eligible (BIN assigned + not on eBay)`);

  // 3. Apply offset + limit
  if (offset > 0) {
    eligible = eligible.slice(offset);
  }
  if (limit > 0) {
    eligible = eligible.slice(0, limit);
  }

  console.log(`[batch-optimize] Processing ${eligible.length} products (offset=${offset}, limit=${limit})`);

  // 4. Process each product
  const results = [];
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < eligible.length; i++) {
    const product = eligible[i];
    const productName = product?.identification?.name || product?.id || 'unknown';
    const logPrefix = `[batch-optimize] [${i + 1}/${eligible.length}]`;

    onProgress?.({
      current: i + 1,
      total: eligible.length,
      productId: product.id,
      productName,
      status: 'processing',
    });

    try {
      console.log(`${logPrefix} Processing: ${productName} (${product.id})`);

      // Run Gemini "Alles optimieren"
      const chatResult = await runProductChatV2(product, OPTIMIZE_ALL_MESSAGE, {
        scope: OPTIMIZE_ALL_SCOPE,
        history: [],
        attachments: [],
      });

      const changes = chatResult?.datasheetChanges || [];

      if (!changes.length) {
        console.log(`${logPrefix} No changes suggested by Gemini — skipping`);
        skippedCount++;
        results.push({
          productId: product.id,
          productName,
          status: 'skipped',
          reason: 'no_changes_suggested',
          geminiMessage: (chatResult?.message || '').slice(0, 300),
        });
        continue;
      }

      // Consolidate all changes into one
      const consolidated = changes[0]; // Already consolidated by runProductChatV2

      // Auto-accept: apply changes to product
      const updatedProduct = applyChangesToProduct(product, consolidated);

      // Track what changed
      const changedFields = Object.keys(consolidated).filter(k => k !== 'summary');

      if (dryRun) {
        console.log(`${logPrefix} DRY-RUN — would apply: ${changedFields.join(', ')}`);
        results.push({
          productId: product.id,
          productName,
          status: 'dry_run',
          changedFields,
          summary: consolidated.summary || '',
        });
        successCount++;
      } else {
        // Save via saveProductV2() — full business logic
        await saveProductV2(updatedProduct);
        console.log(`${logPrefix} SAVED — applied: ${changedFields.join(', ')}`);

        successCount++;
        results.push({
          productId: product.id,
          productName,
          status: 'saved',
          changedFields,
          summary: consolidated.summary || '',
        });
      }

      onProgress?.({
        current: i + 1,
        total: eligible.length,
        productId: product.id,
        productName,
        status: 'done',
        changedFields,
      });

    } catch (err) {
      console.error(`${logPrefix} ERROR for ${product.id}: ${err.message}`);
      errorCount++;
      results.push({
        productId: product.id,
        productName,
        status: 'error',
        error: err.message?.slice(0, 500),
      });

      onProgress?.({
        current: i + 1,
        total: eligible.length,
        productId: product.id,
        productName,
        status: 'error',
        error: err.message?.slice(0, 200),
      });
    }

    // Rate-limit delay (skip after last product)
    if (i < eligible.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PRODUCTS_MS));
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = {
    totalEligible: eligible.length,
    processed: results.length,
    success: successCount,
    errors: errorCount,
    skipped: skippedCount,
    dryRun,
    elapsedMs,
    elapsedFormatted: `${Math.round(elapsedMs / 1000)}s`,
    results,
  };

  console.log(`[batch-optimize] DONE in ${summary.elapsedFormatted}: ${successCount} saved, ${errorCount} errors, ${skippedCount} skipped`);
  return summary;
}

// ---------------------------------------------------------------------------
// Preview: list eligible products without running optimization
// ---------------------------------------------------------------------------

async function previewBatchOptimize({ tenantId = null } = {}) {
  let query = firestore.collection(PRODUCTS_COLLECTION);
  if (tenantId) {
    query = query.where('tenantId', '==', tenantId);
  }
  const snapshot = await query.get();
  const allProducts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const [soldMap, ebayIndex] = await Promise.all([
    buildSoldQuantityMap(),
    buildEbayListedSets(),
  ]);
  const enrichedProducts = enrichWithSoldData(allProducts, soldMap);
  const eligible = enrichedProducts.filter(p => isEligibleForBatchOptimize(p, ebayIndex));

  return {
    totalProducts: allProducts.length,
    eligibleCount: eligible.length,
    products: eligible.map(p => ({
      id: p.id,
      name: p.identification?.name || 'Unbenannt',
      sku: p.identification?.sku || null,
      brand: p.identification?.brand || null,
      binCode: p.storage?.binCode || (p.storageBins?.[0]?.binCode) || null,
      ebayStatus: p.ops?.listingStatus?.ebay || 'not_listed',
      hasDescription: Boolean(p.details?.short_description),
      hasHighlights: Array.isArray(p.details?.key_features) && p.details.key_features.length > 0,
    })),
  };
}

module.exports = {
  runBatchOptimize,
  previewBatchOptimize,
  isEligibleForBatchOptimize,
  applyChangesToProduct,
  hasBinAssignment,
  isEbayListed,
  buildEbayListedSets,
  buildSoldQuantityMap,
  enrichWithSoldData,
};
