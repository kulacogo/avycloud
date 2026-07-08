/**
 * Abstraktionsschicht für Produkt-Persistenz.
 *
 * saveProductV2() ist ein Drop-in-Replacement für saveProduct():
 *   - Gleiche Signatur: (product, options)
 *   - Ruft die originale saveProduct() auf (volle Business-Logik: SKU, Title-Policy etc.)
 *   - Schreibt ZUSÄTZLICH eine normalisierte Kopie in products_v2 (wenn USE_PRODUCTS_V2=true)
 *
 * Dual-Write-Pattern: Beide Collections werden parallel aktualisiert.
 * Lese-Pfade können über getCollection() gesteuert werden.
 */
const { firestore, saveProduct } = require('./firestore');
const { normalizeProduct, validateCanonical } = require('./product-canonical');

// Feature-Flag: Umschalten zwischen alter und neuer Collection
const COLLECTION = process.env.PRODUCT_COLLECTION || 'products';
const V2_COLLECTION = 'products_v2';
const USE_V2 = process.env.USE_PRODUCTS_V2 === 'true';

function getCollection() {
  return USE_V2 ? V2_COLLECTION : COLLECTION;
}

/**
 * Whether the non-blocking schema validation on the prod direct-write path runs.
 * Off via PRODUCT_SCHEMA_VALIDATE=false. Sampled via PRODUCT_SCHEMA_VALIDATE_RATE
 * (0..1, default 1.0) to throttle the extra Firestore read on hot save paths.
 */
function schemaValidateEnabled() {
  if (process.env.PRODUCT_SCHEMA_VALIDATE === 'false') return false;
  const rate = parseFloat(process.env.PRODUCT_SCHEMA_VALIDATE_RATE || '1');
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

/**
 * PRODUCT_GHOST_GATE — opt-in (default OFF) prevention gate that stops NEW
 * ghost docs from being created. Default 'false' == today's behavior EXACTLY
 * (today's logging/telemetry is untouched, nothing is ever blocked).
 *
 * Root cause of ~1084 ghost products: validateCanonical() already DETECTS the
 * ghost signature (placeholder name/brand/category, UUID/`prod-` id with a
 * barcode), but saveProductV2() only LOGS — never blocks. This gate blocks the
 * single narrow case that is safe to block: a brand-new, content-less,
 * order-less, listing-less ghost. It NEVER blocks an UPDATE to an existing doc
 * (enrichment of an in-progress product must always go through).
 */
function productGhostGateEnabled() {
  return process.env.PRODUCT_GHOST_GATE === 'true';
}

const GHOST_PLACEHOLDERS = new Set([
  'unbekannt', 'unknown', 'n/a', 'na', '-', '—', '--', 'null',
  'unbekanntes produkt', 'no name', 'noname',
]);

/** A value is "usable content" if it is a non-placeholder, non-trivial string. */
function _hasUsableText(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (GHOST_PLACEHOLDERS.has(trimmed.toLowerCase())) return false;
  // A pure barcode/EAN used as a "name" is not real content.
  if (/^\d{8,14}$/.test(trimmed)) return false;
  return true;
}

/**
 * Does the incoming product carry any real, human-usable content?
 * Used as gate-condition (d): if there is a usable title/brand/description, the
 * doc is a legitimate in-progress product and is NEVER rejected.
 */
function _hasRealContent(product) {
  const ident = product?.identification || {};
  const details = product?.details || {};
  if (_hasUsableText(ident.name) || _hasUsableText(product?.name)) return true;
  if (_hasUsableText(ident.brand)) return true;
  if (_hasUsableText(details.short_description) || _hasUsableText(details.description)) return true;
  if (_hasUsableText(details.long_description)) return true;
  if (Array.isArray(details.key_features) && details.key_features.some(_hasUsableText)) return true;
  return false;
}

/**
 * Does the incoming product already have orders or marketplace listings?
 * Used as gate-condition (c): a product that is live somewhere (or has sold) is
 * NEVER rejected — its existence is load-bearing regardless of its name.
 */
function _hasOrdersOrListings(product) {
  const ops = product?.ops || {};
  const marketplace = product?.marketplace || product?.details?.marketplace || {};

  // Marketplace listing ids (eBay item id / Kaufland unit id), any known shape.
  const ebayItemId = ops?.ebay?.itemId || marketplace?.ebay?.itemId || product?.ebayItemId;
  if (ebayItemId) return true;
  const kauflandUnitId = ops?.kaufland?.unitId || ops?.kaufland?.id_unit || marketplace?.kaufland?.unitId;
  if (kauflandUnitId) return true;

  // Orders / sales metadata.
  const orderCount = Number(ops?.order_count ?? product?.order_count ?? 0);
  if (orderCount > 0) return true;
  const salesCount = Number(ops?.salesCount ?? product?.salesCount ?? 0);
  if (salesCount > 0) return true;

  return false;
}

/**
 * Ghost-signature detection for the gate. REUSES validateCanonical() as the
 * primary detector and adds the same placeholder / UUID-or-`prod-` / pure-EAN
 * "name" heuristics it encodes — without modifying product-canonical.js.
 *
 * validateCanonical() is exact-match on a fixed placeholder list and only flags
 * a UUID id when a barcode exists, so the dominant production ghost
 * ("Unbekanntes Produkt" + UUID + no barcode) slips past it. The gate widens
 * detection on the IDENTITY only — the actual block still also requires (c) no
 * orders/listings AND (d) no real content, so legitimate docs are never caught.
 *
 * @returns {{ghost: boolean, errors: string[]}}
 */
function detectGhostSignature(product) {
  const errors = [];

  // 1) Reuse the canonical validator verbatim (covers exact-placeholder names,
  //    legacy fields, marketplace-keys-in-attributes, barcode-id mismatch).
  try {
    const v = validateCanonical(product);
    if (!v.valid && Array.isArray(v.errors)) errors.push(...v.errors);
  } catch (_) { /* validation must not throw the gate */ }

  const ident = product?.identification || {};
  const rawName = typeof ident.name === 'string' ? ident.name.trim() : '';
  const nameLc = rawName.toLowerCase();

  // 2) Placeholder name — superset incl. multi-word forms validateCanonical misses.
  if (!rawName || GHOST_PLACEHOLDERS.has(nameLc)) {
    errors.push(`Ghost name (placeholder/empty): "${rawName}"`);
  }

  // 3) A pure barcode/EAN used as the product name is a ghost signature.
  if (/^\d{8,14}$/.test(rawName)) {
    errors.push(`Ghost name (bare EAN/barcode): "${rawName}"`);
  }

  // 4) UUID / `prod-` document id with no usable name → ghost shell.
  const id = product?.id ? String(product.id) : '';
  const isOpaqueId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || /^prod-/.test(id);
  if (isOpaqueId && (!rawName || GHOST_PLACEHOLDERS.has(nameLc))) {
    errors.push(`Ghost id (opaque ${id.slice(0, 12)}… with no usable name)`);
  }

  return { ghost: errors.length > 0, errors };
}

/**
 * Structured rejection error so the upstream identify/improve path can catch by
 * code and retry / re-identify instead of silently persisting a ghost.
 */
function makeGhostRejectedError(productId, validationErrors) {
  const err = new Error(`Product ${productId} rejected by PRODUCT_GHOST_GATE: ghost signature with no content, orders, or listings`);
  err.code = 'PRODUCT_GHOST_REJECTED';
  err.productId = productId;
  err.validationErrors = validationErrors || [];
  err.retryable = true;
  return err;
}

/**
 * Produkt speichern — Drop-in-Replacement für saveProduct().
 *
 * 1. Ruft die originale saveProduct(product, options) auf → volle Business-Logik
 * 2. Wenn USE_PRODUCTS_V2=true: schreibt normalisierte Kopie nach products_v2
 *
 * Signatur: saveProductV2(product, options) — identisch zu saveProduct().
 */
async function saveProductV2(product, options = {}) {
  const { PRODUCTS_COLLECTION } = require('./firestore');

  // Pre-State-Read (best-effort): Qty vor der Mutation fuer Stock-Change-Detection.
  // Skippable via options.skipStockEvent (z.B. bei Bulk-Imports).
  // Siehe CLAUDE.md Punkt 10 (Oversell-Verbot) und Plan P2.3 + P2.4.
  let preQty = null;
  let preSku = null;
  let preTenantId = null;
  // Whether a doc with this id already exists in the target collection.
  // null = unknown (pre-read skipped/failed), true = exists (UPDATE),
  // false = confirmed absent (NEW doc). The ghost gate only ever blocks when
  // this is *confirmed* false, so a skipped/failed pre-read can never block.
  let preDocExists = null;
  const productId = product?.id;
  if (productId && !options.skipStockEvent) {
    try {
      const preSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      preDocExists = !!preSnap.exists;
      if (preSnap.exists) {
        const pre = preSnap.data() || {};
        preQty = pre.inventory?.quantity ?? null;
        preSku = pre.identification?.sku || pre.details?.identifiers?.sku || null;
        preTenantId = pre.tenantId || null;
      }
    } catch (_) {
      // non-fatal — Pre-Read ist optional
    }
  } else if (productId && productGhostGateEnabled()) {
    // skipStockEvent-Pfade (Bulk-Imports/-Backfills) haben früher den Ghost-Gate
    // komplett umgangen, weil preDocExists ohne Pre-Read nie 'false' wurde —
    // genau so entstanden am 2026-03-23 die 206 Geister-Hüllen. Bei aktivem Gate
    // machen wir hier einen reinen Existenz-Read (keine Stock-Felder, kein
    // stock:changed): Updates bleiben ungeblockt, nur NEUE Geister werden erkannt.
    try {
      const preSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      preDocExists = !!preSnap.exists;
    } catch (_) {
      // fail-open: preDocExists bleibt null → Gate blockt nie
    }
  }

  // ── PRODUCT_GHOST_GATE (default OFF) ────────────────────────────────────────
  // Stop NEW ghost docs from ever being created. ALL of these must hold to
  // reject (otherwise: proceed exactly as today):
  //   (a) it would CREATE A NEW doc        → preDocExists === false (confirmed)
  //   (b) canonical validation flags ghost → validateCanonical reports errors
  //   (c) no orders AND no listings        → !_hasOrdersOrListings(product)
  //   (d) no real content                  → !_hasRealContent(product)
  // NEVER blocks an UPDATE, and NEVER blocks when the flag is off. The gate runs
  // BEFORE saveProduct() so a rejected ghost is never written anywhere.
  // Gilt auch für skipStockEvent-Aufrufer (Existenz-Read oben) — Bulk-Pfade
  // dürfen keine neuen Geister mehr anlegen (Incident 2026-03-23, 206 Hüllen).
  if (productGhostGateEnabled() && productId && preDocExists === false) {
    try {
      const normalizedIncoming = normalizeProduct(product);
      const { ghost, errors } = detectGhostSignature(normalizedIncoming);
      if (ghost && !_hasOrdersOrListings(product) && !_hasRealContent(product)) {
        // Best-effort telemetry — mirrors the existing product_schema_violations
        // shape but flags blocked:true. Must never itself break the throw.
        try {
          await firestore.collection('product_schema_violations').add({
            productId,
            tenantId: normalizedIncoming.tenantId || product.tenantId || 'default',
            errors,
            blocked: true,
            gate: 'PRODUCT_GHOST_GATE',
            source: options.source || 'saveProductV2',
            createdAt: new Date().toISOString(),
          });
        } catch (telemetryErr) {
          console.warn(`[saveProductV2] ghost-gate telemetry write failed for ${productId}: ${telemetryErr.message}`);
        }
        console.warn(`[saveProductV2] PRODUCT_GHOST_GATE rejected NEW ghost doc ${productId}:`, errors);
        throw makeGhostRejectedError(productId, errors);
      }
    } catch (gateErr) {
      // Only the structured rejection propagates. Any other error in gate
      // evaluation (e.g. normalize threw on weird input) must NOT block the save
      // → fall through to today's behavior.
      if (gateErr && gateErr.code === 'PRODUCT_GHOST_REJECTED') throw gateErr;
      console.warn(`[saveProductV2] ghost-gate evaluation error for ${productId} (ignored, save proceeds): ${gateErr?.message}`);
    }
  }

  // 1) Originale saveProduct() ausführen — alle Business-Logik bleibt erhalten
  //    (SKU-Allokation, Title-Policy, Category-Mapping, Identifier-Sync etc.)
  const result = await saveProduct(product, options);

  // 2) Normalisierte Kopie in products_v2 schreiben (Dual-Write)
  //    NUR nötig wenn saveProduct() in eine ANDERE Collection schreibt als products_v2.
  //    Wenn PRODUCTS_COLLECTION === V2_COLLECTION, schreibt saveProduct() bereits direkt
  //    nach products_v2 → Dual-Write ist redundant und erzeugt durch _pickCanonicalId
  //    sogar Duplikate unter abweichenden Document-IDs (BUG-085).
  const isDualWriteNeeded = PRODUCTS_COLLECTION !== V2_COLLECTION;

  if (USE_V2 && isDualWriteNeeded) {
    try {
      const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      const freshData = freshSnap.exists ? { id: productId, ...freshSnap.data() } : product;

      const normalized = normalizeProduct(freshData);
      const validation = validateCanonical(normalized);
      if (!validation.valid) {
        console.error(`[saveProductV2] Validation failed for ${productId}:`, validation.errors);
        normalized.ops._validationErrors = validation.errors;
      }

      const targetId = normalized.id || productId;
      await firestore.collection(V2_COLLECTION).doc(targetId).set(normalized, { merge: true });
    } catch (err) {
      console.error(`[saveProductV2] v2 write failed for ${product.id}: ${err.message}`);
    }
  } else if (USE_V2 && productId && schemaValidateEnabled()) {
    // Prod direct-write path (PRODUCTS_COLLECTION === products_v2): saveProduct()
    // already wrote to products_v2, so the dual-write validation above never ran
    // and corrupt schema could land silently. Validate here too — but PURELY
    // observationally: log + record violations, NEVER block or mutate the save.
    try {
      const freshSnap = await firestore.collection(V2_COLLECTION).doc(productId).get();
      if (freshSnap.exists) {
        const normalized = normalizeProduct({ id: productId, ...freshSnap.data() });
        const validation = validateCanonical(normalized);
        if (!validation.valid) {
          console.warn(`[saveProductV2] schema validation (non-blocking) failed for ${productId}:`, validation.errors);
          // Best-effort telemetry; must never block or fail the save.
          firestore.collection('product_schema_violations').add({
            productId,
            tenantId: normalized.tenantId || 'default',
            errors: validation.errors,
            source: options.source || 'saveProductV2',
            createdAt: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[saveProductV2] non-blocking validation failed for ${productId}: ${err.message}`);
    }
  }

  // Post-State-Read + Stock-Change-Notify (emit + ledger).
  if (productId && !options.skipStockEvent && preQty !== null) {
    try {
      const postSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      if (postSnap.exists) {
        const post = postSnap.data() || {};
        const postQty = post.inventory?.quantity ?? null;
        if (postQty !== null && Number(preQty) !== Number(postQty)) {
          const { notifyStockChange } = require('./stock-change-events');
          await notifyStockChange({
            tenantId: post.tenantId || preTenantId || 'default',
            productId,
            sku: post.identification?.sku || post.details?.identifiers?.sku || preSku,
            before: Number(preQty),
            after: Number(postQty),
            reason: options.stockChangeReason || 'saveProductV2',
            source: options.source || 'saveProductV2',
            actor: options.actor || null,
          });
        }
      }
    } catch (err) {
      console.warn(`[saveProductV2] stock-change-notify failed for ${productId}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Produkt lesen — aus aktiver Collection.
 */
async function getProductV2(productId) {
  const doc = await firestore.collection(getCollection()).doc(productId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * Alle Produkte lesen — aus aktiver Collection.
 */
async function getAllProductsV2(queryFn) {
  let ref = firestore.collection(getCollection());
  if (queryFn) ref = queryFn(ref);
  const snap = await ref.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Tenant-scoped variant of getAllProductsV2. MANDATORY tenantId.
 *
 * Mirror of firestore.js#getAllProductsForTenant but for the V2 collection
 * (products_v2). Additive helper — does NOT replace getAllProductsV2(). Call
 * sites should opt-in via the D.0b-style ternary fallback:
 *
 *   const products = tenantId
 *     ? await getAllProductsV2ForTenant(tenantId)
 *     : await getAllProductsV2();
 *
 * This guarantees zero behaviour change for routes that don't yet plumb a
 * tenantId through, while letting attachUserContext-mounted routes get
 * Firestore-side filtering (cheaper reads, no cross-tenant leakage).
 *
 * @param {string} tenantId - non-empty tenant identifier
 * @param {object} [options] - reserved for future query options
 * @param {Function} [options.queryFn] - optional query refiner (chains after
 *   the tenantId where-clause).
 * @returns {Promise<Array>} - product docs filtered by tenantId
 * @throws {Error} - if tenantId is missing, not a string, or empty/whitespace
 */
async function getAllProductsV2ForTenant(tenantId, options = {}) {
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error('getAllProductsV2ForTenant: tenantId is required and must be a non-empty string');
  }

  // D.0b-Hotfix 2026-05-11: Production-Realität — products_v2-Docs haben kein
  // tenantId-Feld (Multi-Tenant nur im Code vorbereitet). Für tenantId='default'
  // → Legacy-Compat: liefere Docs ohne tenantId-Feld ODER tenantId='default'.
  // Nach Backfill (Phase B) Legacy-Branch entfernen.
  if (tenantId === 'default') {
    let ref = firestore.collection(getCollection());
    if (typeof options.queryFn === 'function') ref = options.queryFn(ref);
    const snap = await ref.get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((doc) => !doc.tenantId || doc.tenantId === 'default');
  }

  let ref = firestore.collection(getCollection()).where('tenantId', '==', tenantId);
  if (typeof options.queryFn === 'function') ref = options.queryFn(ref);
  const snap = await ref.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Lookup product weight by SKU or EAN.
 * Returns weight in kg (number) or null if not found / no weight.
 *
 * @param {string|null} sku
 * @param {string|null} ean
 * @returns {Promise<number|null>}
 */
async function getProductWeightBySku(sku, ean) {
  if (!sku && !ean) return null;

  const col = firestore.collection(getCollection());
  let product = null;

  // 1. Try SKU
  if (sku) {
    const snap = await col.where('identification.sku', '==', sku).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  // 2. Fallback: EAN via identification.barcodes
  if (!product && ean) {
    const snap = await col.where('identification.barcodes', 'array-contains', ean).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  if (!product) return null;

  // Extract weight with fallback chain
  const w = product.details?.weight
    ?? product.details?.attributes?.weight
    ?? product.details?.attributes?.['Gewicht (kg)']
    ?? product.details?.attributes?.['Gewicht']
    ?? null;

  return (typeof w === 'number' && w > 0) ? w : null;
}

module.exports = {
  saveProductV2,
  getProductV2,
  getAllProductsV2,
  getAllProductsV2ForTenant,
  getProductWeightBySku,
  getCollection,
  COLLECTION,
  V2_COLLECTION,
  USE_V2,
};
