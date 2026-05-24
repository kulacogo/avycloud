'use strict';

/**
 * Kaufland-Listings-Sync — pulls latest Kaufland units and caches them in
 * Firestore (`kauflandUnitsLive`) for fast Inventory-UI listed/not-listed
 * indicators. Also backfills `ops.kaufland.unitId` into `products_v2` so the
 * stock-sync-dispatcher can push to Kaufland without an extra lookup, and
 * detects drift (marketplace > warehouse) to queue outbound stock syncs
 * against the local source of truth.
 *
 * Extracted (Plan-D.0d) from the inline `POST /api/marketplace/kaufland/listings/sync`
 * route-handler so the same logic can be triggered by the safety-net cron in
 * `backend/index.js`. Route handler now delegates here verbatim, response shape
 * stays exactly identical.
 *
 * Multi-Tenant: tenantId is required and used for tenant-scoped product reads
 * (getAllProductsV2ForTenant) when supplied. The legacy global read path
 * (getAllProductsV2) is preserved when no tenantId is given — that matches the
 * pre-extraction behaviour for un-decorated requests.
 *
 * IMPORTANT: never pull `inventory.quantity` from marketplace into warehouse.
 * If Kaufland reports stock > 0 while warehouse is 0, we queue an outbound
 * stock sync to push local truth (and stop oversell).
 *
 * Returns `{ storefront, fetched, active, driftsDetected, reconciled,
 * reverseDriftsDetected, reverseDriftSamples, validityChecked, validityValid,
 * validityInvalid }` — additive extension of the pre-extraction route response
 * payload (older fields unchanged, new fields default to 0 when no validity
 * refresh ran).
 */

// TTL for the `product_valid` cache: Kaufland's indexing pipeline can take up
// to 24h to flip is_valid from false → true on freshly published listings.
// Lowered from 24h → 2h so freshly indexed units flip to Live in the UI faster
// (Kaufland frequently completes indexing well before 24h; 2h keeps API cost
// bounded while letting the dashboard reflect changes within the same session).
const VALIDITY_TTL_MS = 2 * 3600 * 1000;

/**
 * @param {object} opts
 * @param {string} [opts.tenantId]   tenant for product reads (optional; legacy global read when absent)
 * @param {string} [opts.storefront='de']
 * @returns {Promise<{storefront:string, fetched:number, active:number, driftsDetected:number, reconciled:number, reverseDriftsDetected:number, reverseDriftSamples:Array<object>, validityChecked:number, validityValid:number, validityInvalid:number}>}
 */
async function syncKauflandListingsCache({ tenantId, storefront = 'de' } = {}) {
  const sf = String(storefront || 'de').trim().toLowerCase();
  const { listUnits, getUnit } = require('../lib/kaufland-api');
  const { Timestamp } = require('@google-cloud/firestore');
  const { firestore } = require('../lib/firestore');
  const { getAllProductsV2, getAllProductsV2ForTenant } = require('../lib/product-store');
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');

  const units = await listUnits({ storefront: sf, limit: 100, maxPages: 300 });
  const now = Timestamp.now();
  const collection = firestore.collection('kauflandUnitsLive');
  const seenIds = new Set();

  let batch = firestore.batch();
  let batchCount = 0;
  const commitBatch = async () => {
    if (!batchCount) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  for (const unit of units) {
    const idUnit = Number(unit?.id_unit || 0);
    if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
    const docId = String(idUnit);
    seenIds.add(docId);

    const product = unit?.product && typeof unit.product === 'object' ? unit.product : {};
    const productEans = Array.isArray(product?.eans) ? product.eans : [];
    const normalizedEans = Array.from(
      new Set(
        productEans
          .map((v) => normalizeMarketplaceEan(v))
          .filter(Boolean)
      )
    );

    const idProduct = Number(unit?.id_product || product?.id_product || 0);
    const normalizedIdProduct = Number.isFinite(idProduct) && idProduct > 0 ? idProduct : null;
    const productUrl = String(product?.url || '').trim();
    const viewItemUrl = productUrl || (normalizedIdProduct ? `https://www.kaufland.de/product/${normalizedIdProduct}/` : null);

    // Extract title and three distinct prices from Kaufland API response:
    //   listing_price → max price set by seller (what we configure)
    //   minimum_price → min price floor set by seller
    //   price         → CURRENT customer-facing sell price (Kaufland's auto-pricer
    //                   adjusts dynamically between min and max). This is what
    //                   the Seller Portal displays as the active price — we need
    //                   it as the primary value in our UI so it matches Portal.
    const klTitle = typeof product?.title === 'string' && product.title.trim() ? product.title.trim() : null;
    const klListingPrice = Number.isFinite(Number(unit?.listing_price)) ? Number(unit.listing_price) : null;
    const klCurrentPrice = Number.isFinite(Number(unit?.price)) ? Number(unit.price) : null;
    const klMinimumPrice = Number.isFinite(Number(unit?.minimum_price)) ? Number(unit.minimum_price) : null;

    const payload = {
      id_unit: idUnit,
      id_offer: String(unit?.id_offer || '').trim() || null,
      id_offer_normalized: normalizeMarketplaceSku(unit?.id_offer),
      ean: normalizeMarketplaceEan(unit?.ean),
      eans: normalizedEans,
      id_product: normalizedIdProduct,
      view_item_url: viewItemUrl,
      amount: Number.isFinite(Number(unit?.amount)) ? Number(unit.amount) : null,
      status: String(unit?.status || '').trim() || null,
      storefront: String(unit?.storefront || sf || 'de').trim().toLowerCase(),
      active: String(unit?.status || '').trim().toUpperCase() === 'AVAILABLE',
      title: klTitle,
      listing_price: klListingPrice,
      current_price: klCurrentPrice,
      minimum_price: klMinimumPrice,
      updatedAt: now,
      source: 'kaufland-sync',
    };

    batch.set(collection.doc(docId), payload, { merge: true });
    batchCount += 1;
    if (batchCount >= 400) await commitBatch();
  }
  await commitBatch();

  // Mark stale cached rows as STALE (units no longer returned by API).
  //
  // Important: query ALL docs for this storefront, not just active=true.
  // Older code filtered to active=true which missed two ghost classes:
  //   1) ONHOLD docs that later disappeared from the API entirely → kept
  //      status='ONHOLD' forever, polluting "paused" count.
  //   2) AVAILABLE docs marked active=false by an earlier sync but never
  //      had their status field cleared → kept status='AVAILABLE',
  //      causing the listings endpoint to coerce isActive back to true.
  //
  // Setting status='STALE' makes the tombstone explicit so the route + UI
  // can filter cleanly. active=false is preserved as the primary signal.
  //
  // Cleanup policy (added 2026-05-24): tombstones must not accumulate forever.
  // A snapshot showed 468 STALE docs vs only 397 real Kaufland units — the
  // ghosts inflated every count and produced SKU duplicates (a re-listed
  // product whose unit-ID changed appeared once live + once STALE, e.g. ZMH
  // Pendelleuchte). We now HARD-DELETE two ghost classes instead of keeping
  // them as tombstones:
  //   a) superseded ghosts — a non-seen doc whose SKU now has a live unit
  //      (unit-ID rotated). Delete immediately; the live doc is the truth.
  //   b) aged-out tombstones — already STALE and removed > GHOST_TTL ago
  //      (genuinely gone from Kaufland; products_v2 still holds the product
  //      so it can be re-listed from there if needed).
  // First-time disappearances (still within grace period) are tombstoned as
  // before, so a transient /units API hiccup never deletes live data outright.
  const GHOST_TTL_MS = 7 * 24 * 3600 * 1000;
  const liveSkus = new Set();
  for (const unit of units) {
    const s = normalizeMarketplaceSku(unit?.id_offer);
    if (s) liveSkus.add(String(s).toLowerCase());
  }
  const existingSnap = await collection.where('storefront', '==', sf).get();
  if (!existingSnap.empty) {
    let staleBatch = firestore.batch();
    let staleBatchCount = 0;
    const flush = async () => {
      if (staleBatchCount > 0) {
        await staleBatch.commit();
        staleBatch = firestore.batch();
        staleBatchCount = 0;
      }
    };
    for (const doc of existingSnap.docs) {
      if (seenIds.has(doc.id)) continue;
      const existing = doc.data() || {};
      const docSku = String(existing.id_offer_normalized || existing.id_offer || '').trim().toLowerCase();
      const isSupersededGhost = docSku && liveSkus.has(docSku);
      const removedAtMs = typeof existing.removedAt?.toDate === 'function'
        ? existing.removedAt.toDate().getTime()
        : (typeof existing.removedAt === 'number' ? existing.removedAt : 0);
      const agedOut = existing.status === 'STALE' && removedAtMs && (Date.now() - removedAtMs) > GHOST_TTL_MS;

      if (isSupersededGhost || agedOut) {
        staleBatch.delete(collection.doc(doc.id)); // hard-remove ghost
        staleBatchCount += 1;
      } else if (existing.status === 'STALE' && existing.active === false) {
        continue; // already tombstoned, still within grace period
      } else {
        staleBatch.set(
          collection.doc(doc.id),
          {
            active: false,
            status: 'STALE',
            removedAt: now,
            updatedAt: now,
            source: 'kaufland-sync-stale',
          },
          { merge: true }
        );
        staleBatchCount += 1;
      }
      if (staleBatchCount >= 400) await flush();
    }
    await flush();
  }

  // ── Phase: refresh product.is_valid for AVAILABLE units ─────────────────
  // Kaufland's /units list API does NOT include product.is_valid — only the
  // single-unit GET with embedded=products carries it. Without this field we
  // would report Kaufland's binary `unit.status=AVAILABLE` as "Aktiv" and
  // overcount versus the Kaufland Portal, which additionally requires
  // `product.is_valid=true` (i.e. the product has finished Kaufland's quality
  // indexing pipeline). Freshly listed units can stay `is_valid=false` for up
  // to ~24h after publish.
  //
  // We fetch product.is_valid via getUnit(embedded='products') for units that:
  //   - are currently AVAILABLE (other statuses irrelevant for Portal "Aktiv")
  //   - AND either: lack the product_valid cache OR cache is stale (>24h)
  //                 OR were last seen invalid (re-check, may have indexed)
  //
  // Cost: bounded by AVAILABLE-count; after initial seed only ~freshly-listed
  // + stale-cache units (typically <50/sync) due to the 24h TTL.
  let validityChecked = 0;
  let validityValid = 0;
  let validityInvalid = 0;
  try {
    const validitySnap = await collection.where('storefront', '==', sf).get();
    const cachedById = new Map();
    validitySnap.docs.forEach((d) => cachedById.set(d.id, d.data() || {}));

    const validityCheckList = [];
    for (const unit of units) {
      if (String(unit?.status || '').toUpperCase() !== 'AVAILABLE') continue;
      const docId = String(unit.id_unit);
      const cached = cachedById.get(docId) || {};
      const lastCheckedRaw = cached.product_validity_checked_at;
      const lastChecked = (typeof lastCheckedRaw?.toDate === 'function'
        ? lastCheckedRaw.toDate().getTime()
        : (typeof lastCheckedRaw === 'number' ? lastCheckedRaw : 0));
      const isStale = !lastChecked || (Date.now() - lastChecked) > VALIDITY_TTL_MS;
      const wasInvalid = cached.product_valid === false;
      const neverChecked = cached.product_valid === undefined;
      if (neverChecked || wasInvalid || isStale) {
        validityCheckList.push(unit);
      }
    }

    if (validityCheckList.length > 0) {
      let valBatch = firestore.batch();
      let valBatchCount = 0;
      for (const unit of validityCheckList) {
        try {
          const detail = await getUnit(unit.id_unit, { storefront: sf, embedded: 'products' });
          const product = detail?.product;
          const isValid = product?.is_valid === true;

          // Backfill EAN from product.eans (list-API doesn't return ean for
          // catalog-matched units → cache has ean=''). Without this the
          // auto-repair phase can't call putProductData and skips them all.
          const docId = String(unit.id_unit);
          const cached = cachedById.get(docId) || {};
          const eansFromDetail = Array.isArray(product?.eans) ? product.eans : [];
          const normalizedEans = eansFromDetail
            .map((e) => String(e || '').replace(/\D+/g, '').trim())
            .filter((e) => e.length >= 8);
          const primaryEan = normalizedEans[0] || '';

          const update = { product_valid: isValid, product_validity_checked_at: now };
          if (!cached.ean && primaryEan) {
            update.ean = primaryEan;
            update.eans = normalizedEans;
          }

          valBatch.set(collection.doc(docId), update, { merge: true });
          valBatchCount += 1;
          validityChecked += 1;
          if (isValid) validityValid++; else validityInvalid++;
          if (valBatchCount >= 400) {
            await valBatch.commit();
            valBatch = firestore.batch();
            valBatchCount = 0;
          }
        } catch (_) { /* swallow per-unit, continue */ }
        await new Promise((r) => setTimeout(r, 50)); // rate-limit friendly
      }
      if (valBatchCount > 0) await valBatch.commit();
    }
  } catch (validityErr) {
    console.error('[kaufland-sync] validity refresh error (non-fatal):', validityErr.message);
  }

  // ── Phase: auto-repair invalid units ─────────────────────────────────────
  // Background-Heilung für Altbestand: für jeden AVAILABLE-Unit mit
  // product_valid=false reichen wir unsere VOLLE Produktdaten via
  // tryRepairKauflandProductData nochmal an Kaufland — dieselbe Mechanik
  // wie der neue Initial-Create-Pfad in lib/kaufland-api.js (Commit a24a19a),
  // nur als systemischer Background-Heilungs-Job für Listings die mit der
  // alten Skip-on-catalog-match Logik gepublished wurden.
  //
  // Schutz vor Repair-Spam:
  //   - `last_repair_at`-Marker im Cache, Re-Repair frühestens nach 6h
  //   - Hard-Cap MAX_REPAIRS_PER_RUN — spreads load über mehrere Sync-Läufe
  //
  // Steady state: nach 24h sollte die invalide-Backlog gegen 0 tendieren
  // (Kaufland indexiert die gepatchten Daten asynchron). Danach laufen
  // Repairs nur noch für sporadisch neu auftauchende Invalid-Items.
  const REPAIR_TTL_MS = 6 * 3600 * 1000;
  // Lowered from 50 → 30 to bound Gemini-cost from the new enrichment layer.
  // Throughput math: 120 backlog / 30 per-run / 4 runs/h = ~1h catch-up.
  const MAX_REPAIRS_PER_RUN = 30;
  let repairAttempted = 0;
  let repairSucceeded = 0;
  let enrichmentAttempted = 0;
  let enrichmentSucceeded = 0;
  const enrichmentFields = Object.create(null); // counter per field type
  try {
    const repairSnap = await collection.where('storefront', '==', sf).get();
    // Tenant-scoped read (D.0c pattern): when tenantId is given prefer the
    // tenant-filter path so we don't enumerate other tenants' products and
    // accidentally repair Kaufland units with mismatched-tenant data.
    // (Earlier "half-results" symptom turned out to be a local-test artifact:
    // USE_PRODUCTS_V2 env-var wasn't set, so getCollection() defaulted to the
    // legacy `products` collection. Production has USE_PRODUCTS_V2=true and
    // the function returns all products correctly.)
    const allProdsForRepair = tenantId
      ? await getAllProductsV2ForTenant(tenantId)
      : await getAllProductsV2();
    const skuMapRepair = new Map();
    const eanMapRepair = new Map();
    // brandGpsrMap: brand-lc → { gpsr, score, fromSku }
    // Vorberechnet einmal pro sync-run, an Enricher gereicht. Ermöglicht
    // "GPSR von einem Anker-Produkt auf alle anderen Anker-Produkte
    // mitnehmen" — fundus für invalide Listings die selbst keine GPSR haben.
    const brandGpsrMap = new Map();
    for (const p of allProdsForRepair) {
      const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
      if (sku) skuMapRepair.set(sku.toLowerCase(), p);
      const ean = (p?.identification?.ean || p?.details?.identifiers?.ean || '').trim();
      if (ean) eanMapRepair.set(ean, p);
      // Build brand-GPSR-Map
      const brand = (p?.identification?.brand || p?.details?.brand || '').trim();
      const gpsr = p?.details?.gpsr;
      if (brand && gpsr && (gpsr.manufacturer_name || gpsr.name)) {
        // Score nach Vollständigkeit + DE-Country-Bonus (EU-Listing braucht EU-Entity)
        const hasAddr = gpsr.manufacturer_address || gpsr.address;
        const hasEmail = gpsr.email || gpsr.manufacturer_email;
        const hasUrl = gpsr.url || gpsr.manufacturer_url;
        const hasCity = gpsr.manufacturer_city;
        const hasPostal = gpsr.manufacturer_postalcode;
        const hasCountry = gpsr.country_code || gpsr.entity_country;
        const isEUEntity = /^DE$|^AT$|^FR$|^NL$|^IT$|^ES$|^BE$|^IE$|^LU$/i.test(String(gpsr.country_code || ''))
          || /germany|deutschland|österreich|france|italy|spain|netherlands|belgium/i.test(String(gpsr.entity_country || ''));
        const score = (hasAddr ? 3 : 0) + (hasEmail ? 1 : 0) + (hasUrl ? 1 : 0)
          + (hasCity ? 1 : 0) + (hasPostal ? 1 : 0) + (hasCountry ? 1 : 0)
          + (isEUEntity ? 5 : 0); // EU-Entity bonus — Kaufland EU-Marktplatz braucht EU-Verantwortlichen
        const key = brand.toLowerCase();
        const existing = brandGpsrMap.get(key);
        if (!existing || score > existing.score) {
          brandGpsrMap.set(key, { gpsr, score, fromSku: sku });
        }
      }
    }

    const { tryRepairKauflandProductData } = require('./kaufland-product-data-repair');

    const candidates = [];
    repairSnap.forEach((d) => {
      const v = d.data() || {};
      if (v.active !== true) return;
      if (v.product_valid !== false) return;
      const lastRepairRaw = v.last_repair_at;
      const lastRepair = (typeof lastRepairRaw?.toDate === 'function'
        ? lastRepairRaw.toDate().getTime()
        : (typeof lastRepairRaw === 'number' ? lastRepairRaw : 0));
      if (lastRepair && (Date.now() - lastRepair) < REPAIR_TTL_MS) return;
      candidates.push({ docId: d.id, data: v });
    });

    const toRepair = candidates.slice(0, MAX_REPAIRS_PER_RUN);

    let repairBatch = firestore.batch();
    let repairBatchCount = 0;
    for (const { docId, data: v } of toRepair) {
      const sku = String(v.id_offer || '').toLowerCase();
      const eanCandidate = String(v.ean || '').trim()
        || (Array.isArray(v.eans) && v.eans[0]) || '';
      const matched = (sku && skuMapRepair.get(sku))
        || (eanCandidate && eanMapRepair.get(eanCandidate))
        || null;
      if (!matched || !eanCandidate) continue;
      try {
        // ── Enrichment pass ────────────────────────────────────────────
        // Fetch Kauflands view of the gaps + fill what we can via
        // GPSR-web/Gemini before handing off to the repair-call. Persist
        // the enriched product to products_v2 so future syncs benefit.
        // ALL errors are swallowed — sync must never crash on enrichment.
        let enrichedProduct = matched;
        try {
          const { getProductDataStatus } = require('../lib/kaufland-api');
          const status = await getProductDataStatus(eanCandidate).catch(() => null);
          const missing = Array.isArray(status?.missing_attributes) ? status.missing_attributes : [];
          const minOne = Array.isArray(status?.min_one_missing_attributes) ? status.min_one_missing_attributes : [];
          const fullList = [...missing, ...minOne];
          if (fullList.length) {
            const { enrichProductForKaufland } = require('./kaufland-attribute-enricher');
            const er = await enrichProductForKaufland(matched, fullList, { brandGpsrMap });
            if (er?.enriched && Array.isArray(er.enrichedFields) && er.enrichedFields.length) {
              enrichmentAttempted += 1;
              enrichedProduct = er.enriched;
              enrichmentSucceeded += 1;
              for (const f of er.enrichedFields) {
                enrichmentFields[f] = (enrichmentFields[f] || 0) + 1;
              }
              // Persist enriched data to products_v2 so future syncs benefit.
              // skipStockEvent: this is an attribute-only update — no stock change.
              try {
                const { saveProductV2 } = require('../lib/product-store');
                await saveProductV2(er.enriched, {
                  source: 'kaufland-attribute-enrichment',
                  stockChangeReason: 'attribute-enrichment',
                  skipStockEvent: true,
                });
              } catch (saveErr) {
                console.warn('[kaufland-sync] saveProductV2 after enrichment failed:', saveErr.message);
              }
            } else if (fullList.length) {
              enrichmentAttempted += 1;
            }
          }
        } catch (enrichErr) {
          console.warn('[kaufland-sync] enrichment phase failed (non-fatal):', enrichErr.message);
        }

        const r = await tryRepairKauflandProductData({
          product: enrichedProduct,
          ean: eanCandidate,
          idUnit: Number(v.id_unit),
          storefront: sf,
        });
        repairAttempted += 1;
        repairBatch.set(collection.doc(docId), { last_repair_at: now }, { merge: true });
        repairBatchCount += 1;
        if (r && (r.attempted || r.repaired) && Array.isArray(r.patchedKeys) && r.patchedKeys.length > 0) {
          repairSucceeded += 1;
        }
        if (repairBatchCount >= 400) {
          await repairBatch.commit();
          repairBatch = firestore.batch();
          repairBatchCount = 0;
        }
      } catch (_) { /* swallow per-unit, continue */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (repairBatchCount > 0) await repairBatch.commit();
    if (repairAttempted > 0) {
      const fieldsSummary = Object.keys(enrichmentFields).length
        ? ' enrich=' + Object.entries(enrichmentFields).map(([k, v]) => `${k}:${v}`).join(',')
        : '';
      console.log(`[kaufland-sync] auto-repair attempted=${repairAttempted} succeeded=${repairSucceeded} (cap=${MAX_REPAIRS_PER_RUN}, candidates=${candidates.length})${fieldsSummary}`);
    }
  } catch (repairErr) {
    console.error('[kaufland-sync] auto-repair error (non-fatal):', repairErr.message);
  }

  // ── Backfill ops.kaufland.unitId into products_v2 ────────────────────────
  // For every active unit, find the matching product_v2 doc (by SKU/EAN) and
  // write ops.kaufland.unitId so the stock-sync-dispatcher can push to
  // Kaufland without a separate lookup. Fire-and-forget, non-critical.
  try {
    // D.0c-style tenant fallback: prefer Firestore-side filter when a
    // tenantId is provided, else fall back to legacy global read.
    const allProds = tenantId
      ? await getAllProductsV2ForTenant(tenantId)
      : await getAllProductsV2();
    const skuToProduct = new Map();
    const eanToProduct = new Map();
    for (const p of allProds) {
      const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
      if (sku) skuToProduct.set(sku.toLowerCase(), p);
      const ean = (p?.identification?.ean || p?.details?.identifiers?.ean || '').trim();
      if (ean) eanToProduct.set(ean, p);
    }

    let opsBatch = firestore.batch();
    let opsBatchCount = 0;
    for (const unit of units) {
      const idUnit = Number(unit?.id_unit || 0);
      if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
      const unitSku = String(unit?.id_offer || '').trim();
      const unitEan = String(unit?.ean || '').trim();
      const prod = (unitSku && skuToProduct.get(unitSku.toLowerCase()))
        || (unitEan && eanToProduct.get(unitEan)) || null;
      if (!prod) continue;
      const existing = prod?.ops?.kaufland?.unitId;
      if (String(existing || '') === String(idUnit)) continue; // already correct
      opsBatch.update(firestore.collection('products_v2').doc(prod.id), {
        'ops.kaufland.unitId': String(idUnit),
      });
      opsBatchCount++;
      if (opsBatchCount >= 400) {
        await opsBatch.commit();
        opsBatch = firestore.batch();
        opsBatchCount = 0;
      }
    }
    if (opsBatchCount > 0) await opsBatch.commit();
    if (opsBatchCount > 0) console.log(`[kaufland-sync] Backfilled ops.kaufland.unitId for ${opsBatchCount} products`);
  } catch (opsErr) {
    console.error('[kaufland-sync] ops backfill error (non-fatal):', opsErr.message);
  }

  // ── Drift detection (marketplace > warehouse) ────────────────────────────
  // IMPORTANT: never pull `inventory.quantity` from marketplace into warehouse.
  // If Kaufland reports stock > 0 while warehouse is 0, we queue an outbound
  // stock sync to push local truth (and stop oversell).
  let reconciledCount = 0;
  let driftDetectedCount = 0;
  // Reverse drift (report-only): kaufland==0 or ONHOLD while warehouse>0.
  // We deliberately do NOT auto-reactivate — Kaufland may have deactivated
  // the listing for compliance / quality-gate / missing-data reasons.
  let reverseDriftsDetected = 0;
  const reverseDriftSamples = [];
  const MAX_REVERSE_SAMPLES = 10;
  try {
    const products = tenantId
      ? await getAllProductsV2ForTenant(tenantId)
      : await getAllProductsV2();
    const skuMap = new Map();
    const eanMap = new Map();
    const driftProducts = new Map();
    for (const p of products) {
      const sku = (p?.identification?.sku || '').trim().toLowerCase();
      if (sku) skuMap.set(sku, p);
      const ean = (p?.identification?.ean || '').trim();
      if (ean) eanMap.set(ean, p);
    }

    for (const unit of units) {
      const klAmount = Number(unit?.amount || 0);
      const klStatus = String(unit?.status || '').trim().toUpperCase();
      const idOffer = String(unit?.id_offer || '').trim().toLowerCase();
      const ean = String(unit?.ean || '').trim();
      const matched = (idOffer && skuMap.get(idOffer)) || (ean && eanMap.get(ean)) || null;
      if (!matched) continue;

      const whQty = typeof matched.inventory?.quantity === 'number' ? matched.inventory.quantity : null;

      // ── Forward drift: kaufland>0 while warehouse=0 (queue outbound sync) ──
      if (klAmount > 0 && whQty === 0) {
        driftDetectedCount++;
        if (matched?.id) {
          driftProducts.set(String(matched.id), matched);
        }
        console.warn(`[kaufland-sync] Stock drift detected sku=${matched?.identification?.sku || idOffer || 'unknown'} warehouse=0 kaufland=${klAmount} -> queue outbound sync`);
        continue;
      }

      // ── Reverse drift: warehouse>0 while kaufland=0 OR ONHOLD ──
      // Report-only — Kaufland may have deactivated for legitimate reasons
      // (compliance, quality-gate, missing data). We only surface to operator.
      if (whQty != null && whQty > 0 && (klAmount <= 0 || klStatus === 'ONHOLD')) {
        reverseDriftsDetected++;
        const sample = {
          sku: matched?.identification?.sku || idOffer || null,
          ean: matched?.identification?.ean || ean || null,
          productId: matched?.id || null,
          warehouseQty: whQty,
          kauflandAmount: klAmount,
          kauflandStatus: klStatus || null,
          idUnit: Number(unit?.id_unit || 0) || null,
        };
        if (reverseDriftSamples.length < MAX_REVERSE_SAMPLES) {
          reverseDriftSamples.push(sample);
        }
        console.warn(`[kaufland-sync] Reverse drift detected sku=${sample.sku || 'unknown'} warehouse=${whQty} kaufland=${klAmount} status=${klStatus || 'n/a'} -> REPORT-ONLY (no auto-reactivate)`);
      }
    }

    for (const product of driftProducts.values()) {
      try {
        await syncStockWithRetry({
          tenantId: product?.tenantId || tenantId || 'default',
          product,
          reason: 'kaufland-drift-detected',
        });
        reconciledCount++;
      } catch (syncErr) {
        console.warn(`[kaufland-sync] drift sync failed product=${product?.id || 'unknown'}: ${syncErr.message}`);
      }
    }
  } catch (reconErr) {
    console.error('[kaufland-sync] Reconciliation error (non-fatal):', reconErr.message);
  }

  // ── Realtime marker: signal frontend listeners that sync completed ──────
  // Frontend hooks subscribe to `system/kaufland-sync-state` via Firestore
  // onSnapshot and invalidate the listings React-Query cache when this doc
  // changes. Best-effort write — must NEVER throw and break the sync result.
  try {
    await firestore.collection('system').doc('kaufland-sync-state').set({
      lastSyncAt: now,
      storefront: sf,
      tenantId: tenantId || 'default',
      fetched: units.length,
      live: seenIds.size,
    }, { merge: true });
  } catch (markerErr) {
    console.warn('[kaufland-sync] marker write failed (non-fatal):', markerErr.message);
  }

  return {
    storefront: sf,
    fetched: units.length,
    active: seenIds.size,
    driftsDetected: driftDetectedCount,
    reconciled: reconciledCount,
    reverseDriftsDetected,
    reverseDriftSamples,
    validityChecked,
    validityValid,
    validityInvalid,
    repairAttempted,
    repairSucceeded,
    enrichmentAttempted,
    enrichmentSucceeded,
    enrichmentFields,
  };
}

// ─── Marketplace identifier normalisers ──────────────────────────────────
// Kept module-local + identical to the originals in routes/marketplace.js so
// the extracted service has zero external coupling on those helpers.

function normalizeMarketplaceSku(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeMarketplaceEan(value) {
  return String(value || '').replace(/\D+/g, '').trim();
}

module.exports = { syncKauflandListingsCache };
