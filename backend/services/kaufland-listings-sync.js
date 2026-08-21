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
 * validityInvalid, invalidReasons }` — additive extension of the
 * pre-extraction route response payload (older fields unchanged, new fields
 * default to 0 when no validity refresh ran).
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
  // Hoisted: die pending-publish-heal-Phase unten braucht dieselbe Produktliste
  // — wiederverwenden statt ein zweites Mal die ganze Collection zu lesen.
  let allProdsForRepair = [];
  try {
    const repairSnap = await collection.where('storefront', '==', sf).get();
    // Tenant-scoped read (D.0c pattern): when tenantId is given prefer the
    // tenant-filter path so we don't enumerate other tenants' products and
    // accidentally repair Kaufland units with mismatched-tenant data.
    // (Earlier "half-results" symptom turned out to be a local-test artifact:
    // USE_PRODUCTS_V2 env-var wasn't set, so getCollection() defaulted to the
    // legacy `products` collection. Production has USE_PRODUCTS_V2=true and
    // the function returns all products correctly.)
    allProdsForRepair = tenantId
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
          // DECLINED-Werte als Hints an den Enricher (Mapping wie in
          // syncKauflandInvalidReasons): z.B. material_composition mit
          // invalid_text_format erzwingt dort das %-Re-Format, auch wenn
          // lokal bereits ein Wert existiert.
          const declined = (Array.isArray(status?.attribute_values) ? status.attribute_values : [])
            .filter((av) => String(av?.state || '').trim().toUpperCase() === 'DECLINED')
            .map((av) => ({
              attribute: String(av?.attribute || '').trim(),
              message: String(av?.message || '').replace(/^reason:\s*/i, '').trim(),
            }))
            .filter((e) => e.attribute || e.message);
          if (fullList.length || declined.length) {
            const { enrichProductForKaufland } = require('./kaufland-attribute-enricher');
            const er = await enrichProductForKaufland(matched, fullList, { brandGpsrMap, declined });
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
            } else {
              // fullList.length || declined.length ist hier garantiert
              // (outer guard) — Versuch ohne Ergebnis zählt als attempted.
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

  // ── Phase: invalid reasons ───────────────────────────────────────────────
  // Holt für product_valid=false Units die KONKRETEN Kaufland-Gründe
  // (fehlende Pflichtattribute + DECLINED-Werte) via getProductDataStatus und
  // spiegelt sie in die kauflandUnitsLive-Docs + als persistenten Listing-
  // Fehler aufs zugehörige products_v2-Produkt (Listing-Fehler-Cockpit).
  // Läuft bewusst NACH der validity-refresh-Phase (frische product_valid-
  // Werte im Snapshot) und nach der Auto-Repair-Phase, damit die dort
  // gehoistete Produktliste (allProdsForRepair) wiederverwendet werden kann.
  let invalidReasons = { candidates: 0, fetched: 0, cleared: 0 };
  try {
    const reasonsSnap = await collection.where('storefront', '==', sf).get();
    const unitDocs = reasonsSnap.docs.map((d) => ({ docId: d.id, data: d.data() || {} }));
    // Fallback-Reload nur falls die Repair-Phase vor dem Produkt-Read
    // gecrasht ist (allProdsForRepair dann leer) — gleiche Mechanik wie die
    // pending-heal-Phase unten.
    const prodsForReasons = allProdsForRepair.length
      ? allProdsForRepair
      : (tenantId ? await getAllProductsV2ForTenant(tenantId) : await getAllProductsV2());
    invalidReasons = await syncKauflandInvalidReasons({
      unitDocs,
      products: prodsForReasons,
      storefront: sf,
    });
  } catch (reasonsErr) {
    console.error('[kaufland-sync] invalid-reasons error (non-fatal):', reasonsErr.message);
  }

  // ── Phase: pending-publish heal ──────────────────────────────────────────
  // Schließt die systemische Lücke hinter KAUFLAND_PRODUCT_DATA_PENDING: der
  // Publish-Pfad reicht Produktdaten ein, POST /units scheitert weil Kaufland
  // asynchron validiert, die Route antwortet 202 — und NICHTS retried. Die
  // Auto-Repair-Phase oben iteriert nur über kauflandUnitsLive, sieht also
  // Produkte OHNE Unit nie. Kandidaten kommen deshalb aus der Produktliste
  // (Marker `marketplace.kaufland.publish_pending_at`, gesetzt von
  // routes/marketplace.js beim 202). Details/Testbarkeit: siehe
  // healPendingKauflandPublishes unten.
  let pendingHeal = { candidates: 0, attempted: 0, healed: 0 };
  try {
    // Fallback-Reload nur falls die Repair-Phase vor dem Produkt-Read
    // gecrasht ist (allProdsForRepair dann leer) — kein Composite-Index nötig.
    const prodsForHeal = allProdsForRepair.length
      ? allProdsForRepair
      : (tenantId ? await getAllProductsV2ForTenant(tenantId) : await getAllProductsV2());
    pendingHeal = await healPendingKauflandPublishes({ products: prodsForHeal, storefront: sf, tenantId });
  } catch (healErr) {
    console.error('[kaufland-sync] pending-heal error (non-fatal):', healErr.message);
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
    invalidReasons,
    pendingHeal,
  };
}

// ─── Invalid-reasons sync ────────────────────────────────────────────────
// Kaufland zeigt product_valid=false Units im Portal als "Inaktiv" mit Badge
// "Ungültig" — die GRÜNDE (fehlende/abgelehnte Pflichtattribute) liefert nur
// GET /product-data/status/{ean}. Diese Phase spiegelt sie in die Mirror-Docs
// (kauflandUnitsLive) und als Listing-Fehler aufs Produkt, damit avycloud
// denselben Zustand zeigt wie das Kaufland-Portal.
// Re-Fetch pro Unit frühestens nach 6h (Marker invalid_reasons_checked_at).
const INVALID_REASONS_TTL_MS = 6 * 3600 * 1000;
// Hard-Cap pro Sync-Lauf — Rest wird im nächsten Lauf abgetragen (Sync läuft
// alle 15 min; 449-Unit-Mirror mit ~110 invaliden Units ist nach 3 Läufen durch).
const MAX_REASON_FETCHES_PER_RUN = 40;
// Fehler-Code der von dieser Phase geschrieben/gelöscht wird. Fremde Codes
// (z.B. KAUFLAND_MANUFACTURER_NOT_WHITELISTED) werden NIE überschrieben.
const INVALID_REASONS_ERROR_CODE = 'KAUFLAND_PRODUCT_DATA_INVALID';

/**
 * Synchronisiert die Ungültigkeits-Gründe für product_valid=false Units.
 *
 * Für jeden nicht-retired Mirror-Doc mit `product_valid === false` (TTL-Gate
 * 6h, Cap 40/Lauf) wird getProductDataStatus(ean) geholt und in den Mirror-Doc
 * gemerged: `invalid_missing_attributes` (missing + min_one, dedupe),
 * `invalid_declined` ([{attribute, message}] nur state=DECLINED),
 * `invalid_reasons_checked_at` (ISO). Zusätzlich landet auf dem zugehörigen
 * products_v2-Produkt (SKU/EAN-Match, gleiche Mechanik wie skuMapRepair/
 * eanMapRepair) ein persistenter Listing-Fehler mit Code
 * KAUFLAND_PRODUCT_DATA_INVALID — NUR wenn das Produkt keinen anderslautenden
 * Fehler trägt (fremde Fehler wie KAUFLAND_MANUFACTURER_NOT_WHITELISTED
 * bleiben unberührt).
 *
 * Selbstheilung: Units die wieder `product_valid === true` sind, verlieren die
 * drei invalid_*-Mirror-Felder (FieldValue.delete()); der Produkt-Listing-
 * Fehler wird NUR gelöscht wenn er von dieser Phase stammt (Code-Check).
 *
 * Als exportierte Funktion mit injizierbaren `deps` gebaut (Muster
 * healPendingKauflandPublishes), damit Tests sie ohne require.cache-Akrobatik
 * mit Fakes fahren können. Externe Module werden erst NACH der Kandidaten-
 * Selektion aufgelöst — der No-op-Fall lädt nichts nach.
 *
 * @param {object} opts
 * @param {Array<{docId:string, data:object}>} opts.unitDocs  kauflandUnitsLive-Docs (id + data)
 * @param {Array<object>} opts.products   bereits geladene products_v2-Liste
 * @param {string} [opts.storefront='de']
 * @param {object} [opts.deps]            Test-Injektion: kauflandApi, firestore,
 *                                        FieldValue, now, sleepMs
 * @returns {Promise<{candidates:number, fetched:number, cleared:number}>}
 */
async function syncKauflandInvalidReasons({ unitDocs = [], products = [], storefront = 'de', deps = {} } = {}) {
  void storefront; // Docs sind bereits storefront-gefiltert; Param für Symmetrie/Future-Use
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const sleepMs = Number.isFinite(deps.sleepMs) ? deps.sleepMs : 100;
  const stats = { candidates: 0, fetched: 0, cleared: 0 };

  const { isRetiredKauflandUnit } = require('../lib/kaufland-unit-status');

  const parseCheckedAt = (raw) => {
    if (typeof raw?.toDate === 'function') return raw.toDate().getTime();
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };
  // 12-stellige UPCs auf EAN-13 padden — Kauflands product-data-Status liegt
  // unter der gepaddeten Form (siehe toKauflandEan in lib/kaufland-api.js).
  const padUpc = (digits) => (digits.length === 12 ? '0' + digits : digits);
  const eanOf = (v) => padUpc(String(v?.ean || '').replace(/\D+/g, '').trim())
    || padUpc(String((Array.isArray(v?.eans) && v.eans[0]) || '').replace(/\D+/g, '').trim());

  const fetchCandidates = [];
  const clearCandidates = [];
  for (const entry of (Array.isArray(unitDocs) ? unitDocs : [])) {
    const docId = entry?.docId;
    const v = entry?.data || {};
    if (!docId) continue;
    if (isRetiredKauflandUnit(v)) continue; // Tombstones (STALE/NOT_FOUND) sind keine Listings
    if (v.product_valid === false) {
      const lastChecked = parseCheckedAt(v.invalid_reasons_checked_at);
      if (lastChecked && (nowMs - lastChecked) < INVALID_REASONS_TTL_MS) continue; // TTL frisch
      const ean = eanOf(v);
      if (!ean) continue; // ohne EAN kein Product-Data-Status abfragbar
      fetchCandidates.push({ docId, data: v, ean });
    } else if (v.product_valid === true) {
      const hasReasonFields = v.invalid_missing_attributes !== undefined
        || v.invalid_declined !== undefined
        || v.invalid_reasons_checked_at !== undefined;
      if (hasReasonFields) clearCandidates.push({ docId, data: v });
    }
  }
  stats.candidates = fetchCandidates.length;
  const toFetch = fetchCandidates.slice(0, MAX_REASON_FETCHES_PER_RUN);
  if (!toFetch.length && !clearCandidates.length) return stats;

  // Deps erst hier auflösen — hält den häufigen No-op-Pfad frei von
  // Modul-Loads (und Tests ohne diese Mocks lauffähig).
  const kauflandApi = deps.kauflandApi || require('../lib/kaufland-api');
  const firestoreDb = deps.firestore || require('../lib/firestore').firestore;
  const FieldValueRef = deps.FieldValue || require('@google-cloud/firestore').FieldValue;
  const unitsCol = firestoreDb.collection('kauflandUnitsLive');
  const productsCol = firestoreDb.collection('products_v2');

  // Produkt-Match nach derselben Mechanik wie skuMapRepair/eanMapRepair in der
  // Auto-Repair-Phase (SKU lowercase, EAN exakt).
  const skuMap = new Map();
  const eanMap = new Map();
  for (const p of (Array.isArray(products) ? products : [])) {
    const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
    if (sku) skuMap.set(sku.toLowerCase(), p);
    const ean = (p?.identification?.ean || p?.details?.identifiers?.ean || '').trim();
    if (ean) eanMap.set(ean, p);
  }
  const matchProduct = (v) => {
    const sku = String(v?.id_offer || '').trim().toLowerCase();
    const eanCandidate = String(v?.ean || '').trim()
      || (Array.isArray(v?.eans) && v.eans[0]) || '';
    return (sku && skuMap.get(sku)) || (eanCandidate && eanMap.get(eanCandidate)) || null;
  };
  const listingErrorsOf = (p) => {
    const errs = p?.marketplace?.kaufland?.listing_errors;
    return Array.isArray(errs) ? errs : [];
  };
  // Fremder Fehler = mindestens ein Eintrag mit anderem (oder fehlendem) Code
  // — der stammt aus einem anderen Pfad (Publish/Heal) und darf nicht
  // weggebügelt werden.
  const hasForeignListingError = (p) => listingErrorsOf(p)
    .some((e) => String(e?.code || '') !== INVALID_REASONS_ERROR_CODE);
  const hasOwnListingError = (p) => {
    const errs = listingErrorsOf(p);
    return errs.length > 0 && errs.every((e) => String(e?.code || '') === INVALID_REASONS_ERROR_CODE);
  };

  // ── Selbstheilung: wieder-valide Units verlieren die Grund-Felder ────────
  for (const { docId, data: v } of clearCandidates) {
    try {
      await unitsCol.doc(docId).set({
        invalid_missing_attributes: FieldValueRef.delete(),
        invalid_declined: FieldValueRef.delete(),
        invalid_reasons_checked_at: FieldValueRef.delete(),
      }, { merge: true });
      stats.cleared += 1;
      const matched = matchProduct(v);
      if (matched && matched.id && hasOwnListingError(matched)) {
        await productsCol.doc(String(matched.id)).update({
          'marketplace.kaufland.listing_errors': FieldValueRef.delete(),
          'marketplace.kaufland.listing_errors_at': FieldValueRef.delete(),
        }).catch(() => null);
      }
    } catch (_) { /* swallow per-doc, continue */ }
  }

  // ── Gründe holen + spiegeln ──────────────────────────────────────────────
  for (const { docId, data: v, ean } of toFetch) {
    try {
      const status = await kauflandApi.getProductDataStatus(ean);
      const missing = Array.isArray(status?.missing_attributes) ? status.missing_attributes : [];
      const minOne = Array.isArray(status?.min_one_missing_attributes) ? status.min_one_missing_attributes : [];
      const missingAll = Array.from(new Set(
        [...missing, ...minOne].map((a) => String(a || '').trim()).filter(Boolean)
      ));
      const declined = (Array.isArray(status?.attribute_values) ? status.attribute_values : [])
        .filter((av) => String(av?.state || '').trim().toUpperCase() === 'DECLINED')
        .map((av) => ({
          attribute: String(av?.attribute || '').trim(),
          // Kaufland liefert z.B. 'reason: media_not_ready_yet' — Präfix weg.
          message: String(av?.message || '').replace(/^reason:\s*/i, '').trim(),
        }))
        .filter((e) => e.attribute || e.message);
      const checkedAtIso = new Date(nowMs).toISOString();

      await unitsCol.doc(docId).set({
        invalid_missing_attributes: missingAll,
        invalid_declined: declined,
        invalid_reasons_checked_at: checkedAtIso,
      }, { merge: true });
      stats.fetched += 1;

      // Listing-Fehler aufs Produkt (Cockpit-Sichtbarkeit) — gleiches Format
      // wie persistKauflandListingError in routes/marketplace.js.
      const matched = matchProduct(v);
      if (matched && matched.id && !hasForeignListingError(matched)) {
        const parts = [];
        if (missingAll.length) parts.push(`fehlende Produktdaten: ${missingAll.join(', ')}`);
        if (declined.length) {
          parts.push(`abgelehnt: ${declined
            .map((e) => (e.message ? `${e.attribute} (${e.message})` : e.attribute))
            .join(', ')}`);
        }
        if (!parts.length) {
          const reason = String(status?.product_not_ready_reason || '').trim();
          if (reason) parts.push(reason);
        }
        if (parts.length) {
          await productsCol.doc(String(matched.id)).update({
            'marketplace.kaufland.listing_errors': [{
              code: INVALID_REASONS_ERROR_CODE,
              message: `Kaufland-Angebot inaktiv — ${parts.join('; ')}`,
              severity: 'Error',
            }],
            'marketplace.kaufland.listing_errors_at': checkedAtIso,
          }).catch(() => null);
        }
      }
    } catch (_) { /* swallow per-doc, continue — ohne checked_at-Write greift der nächste Lauf */ }
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  }

  if (stats.fetched || stats.cleared || stats.candidates) {
    console.log(`[kaufland-sync] invalid-reasons fetched=${stats.fetched} cleared=${stats.cleared} (cap=${MAX_REASON_FETCHES_PER_RUN})`);
  }
  return stats;
}

// ─── Pending-publish heal ────────────────────────────────────────────────
// Cap pro Lauf hält API-Last + Gemini-Kosten (Enricher) beschränkt — der
// Sync läuft alle 15 min, Backlog wird über mehrere Läufe abgetragen.
const MAX_PENDING_HEALS_PER_RUN = 20;
// Kaufland-Validierung braucht Zeit; frühestens 30 min nach dem Publish-
// Versuch wieder anfragen (kein Spam direkt nach dem 202).
const PENDING_HEAL_MIN_AGE_MS = 30 * 60 * 1000;
// Nach 7 Tagen ohne product_ready stimmt strukturell etwas nicht — dann
// zusätzlich als Listing-Fehler ins Cockpit heben (Operator-Sichtbarkeit).
// (Mit dem 24h-Verfall unten normalerweise unerreichbar; bleibt als Netz,
// falls KAUFLAND_PENDING_HEAL_MAX_AGE_MS bewusst über 7 Tage gesetzt wird.)
const PENDING_HEAL_STALE_MS = 7 * 24 * 3600 * 1000;
// BETREIBER-ENTSCHEIDUNG 2026-08-21 ("ich will Angebote listen, wenn ich
// listen will"): Ein Publish-Klick darf von der Heal-Phase nur noch INNERHALB
// dieses Fensters vollendet werden. Ältere Marker VERFALLEN (Marker wird
// gelöscht, Audit-Feld publish_pending_expired_at bleibt). Vorher verfiel
// der Marker NIE — ein wochenalter, längst vergessener Klick konnte
// plötzlich ein Live-Angebot erzeugen (gemessen: 7 Marker vom 11.07.
// standen am 21.08. noch offen). Untergrenze 1h schützt vor Fehlkonfiguration.
const PENDING_HEAL_MAX_AGE_MS = Math.max(
  60 * 60 * 1000,
  parseInt(process.env.KAUFLAND_PENDING_HEAL_MAX_AGE_MS || String(24 * 3600 * 1000), 10) || 24 * 3600 * 1000
);
// Enrich+Repair (Gemini-Kosten + Kaufland-PATCH) höchstens alle 6h pro Produkt
// — aligned mit REPAIR_TTL_MS der Auto-Repair-Phase. Der billige Status-Check
// und createUnit-bei-ready laufen weiterhin in jedem 15-min-Lauf.
const PENDING_HEAL_REPAIR_TTL_MS = 6 * 3600 * 1000;

/**
 * Heilt Publishes, die mit KAUFLAND_PRODUCT_DATA_PENDING (HTTP 202) endeten:
 * Produktdaten liegen bei Kaufland, aber die Unit existiert noch nicht.
 * Kandidaten = Produkte mit `marketplace.kaufland.publish_pending_at` und
 * ohne `ops.kaufland.unitId` (mit Unit ist die Auto-Repair-Phase zuständig).
 *
 * Als eigene, exportierte Funktion mit injizierbaren `deps` gebaut, damit
 * Tests sie ohne require.cache-Akrobatik mit Fakes fahren können. Alle
 * externen Module werden erst NACH der Kandidaten-Selektion aufgelöst —
 * der No-op-Fall (kein Marker gesetzt) lädt nichts nach.
 *
 * @param {object} opts
 * @param {Array<object>} opts.products   bereits geladene products_v2-Liste
 * @param {string} [opts.storefront='de']
 * @param {string} [opts.tenantId]
 * @param {object} [opts.deps]            Test-Injektion: kauflandApi, firestore,
 *                                        saveProductV2, enrichProductForKaufland,
 *                                        tryRepairKauflandProductData,
 *                                        mergeKauflandOverrides, FieldValue, now
 * @returns {Promise<{candidates:number, attempted:number, healed:number}>}
 */
async function healPendingKauflandPublishes({ products = [], storefront = 'de', tenantId = null, deps = {} } = {}) {
  const sf = String(storefront || 'de').trim().toLowerCase();
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const stats = { candidates: 0, attempted: 0, healed: 0 };

  const candidates = [];
  const expired = [];
  for (const p of (Array.isArray(products) ? products : [])) {
    if (!p || !p.id) continue;
    const pendingAtRaw = p?.marketplace?.kaufland?.publish_pending_at;
    if (!pendingAtRaw) continue;
    if (p?.ops?.kaufland?.unitId) continue; // Unit existiert → Auto-Repair-Phase zuständig
    const pendingAtMs = Date.parse(pendingAtRaw);
    if (!Number.isFinite(pendingAtMs)) continue;
    const ageMs = nowMs - pendingAtMs;
    if (ageMs < PENDING_HEAL_MIN_AGE_MS) continue;
    if (ageMs > PENDING_HEAL_MAX_AGE_MS) {
      // Klick zu alt → verfällt (Betreiber-Entscheidung 2026-08-21). Reiner
      // Cleanup, kein Status-Check, kein createUnit.
      expired.push(p);
      continue;
    }
    candidates.push({ product: p, pendingAtMs });
  }
  stats.candidates = candidates.length;
  // `expired` nur bei Vorkommen melden — hält den Rückgabe-Vertrag der
  // bestehenden Aufrufer/Tests (candidates/attempted/healed) additiv.
  if (expired.length) stats.expired = expired.length;
  const toProcess = candidates.slice(0, MAX_PENDING_HEALS_PER_RUN);
  if (!toProcess.length && !expired.length) {
    if (stats.candidates) {
      console.log(`[kaufland-sync] pending-heal candidates=${stats.candidates} attempted=0 healed=0`);
    }
    return stats;
  }

  // Deps erst hier auflösen — hält den häufigen No-Kandidaten-Pfad frei von
  // Modul-Loads (und Tests ohne diese Mocks lauffähig).
  const kauflandApi = deps.kauflandApi || require('../lib/kaufland-api');
  const firestoreDb = deps.firestore || require('../lib/firestore').firestore;
  const saveProductV2 = deps.saveProductV2 || require('../lib/product-store').saveProductV2;
  const enrichProductForKaufland = deps.enrichProductForKaufland
    || require('./kaufland-attribute-enricher').enrichProductForKaufland;
  const tryRepairKauflandProductData = deps.tryRepairKauflandProductData
    || require('./kaufland-product-data-repair').tryRepairKauflandProductData;
  const mergeKauflandOverrides = deps.mergeKauflandOverrides
    || require('../lib/integration-defaults').mergeKauflandOverrides;
  const FieldValueRef = deps.FieldValue || require('@google-cloud/firestore').FieldValue;
  const productsCol = firestoreDb.collection('products_v2');

  // Kaufland-Defaults (Versandgruppe/Lager) lazy + einmalig pro Lauf — nur
  // nötig wenn mindestens ein Kandidat den createUnit-Pfad erreicht.
  let klDefaultsPromise = null;
  const getKlDefaults = () => {
    if (!klDefaultsPromise) {
      klDefaultsPromise = Promise.resolve()
        .then(() => mergeKauflandOverrides({}, { tenantId: tenantId || 'default' }))
        .catch(() => ({}));
    }
    return klDefaultsPromise;
  };

  const persistListingError = async (productId, message, code = null) => {
    // Gleiches Format wie persistKauflandListingError (routes/marketplace.js),
    // damit das Listing-Fehler-Cockpit die Einträge klassifizieren kann.
    await productsCol.doc(String(productId)).update({
      'marketplace.kaufland.listing_errors': [{ code: code || null, message: String(message), severity: 'Error' }],
      'marketplace.kaufland.listing_errors_at': new Date(nowMs).toISOString(),
    }).catch(() => null);
  };

  // Verfallene Marker aufräumen (Betreiber-Entscheidung 2026-08-21): Marker
  // weg, Audit-Feld bleibt — damit ist nachvollziehbar, DASS ein Klick
  // verfallen ist, aber nichts kann ihn mehr ungefragt vollenden.
  for (const p of expired) {
    await productsCol.doc(String(p.id)).update({
      'marketplace.kaufland.publish_pending_at': FieldValueRef.delete(),
      'marketplace.kaufland.publish_pending': FieldValueRef.delete(),
      'marketplace.kaufland.publish_pending_expired_at': new Date(nowMs).toISOString(),
    }).catch(() => null);
  }
  if (expired.length) {
    console.log(`[kaufland-sync] pending-heal: ${expired.length} Marker älter als ${Math.round(PENDING_HEAL_MAX_AGE_MS / 3600000)}h verfallen (kein Auto-Listing)`);
  }
  if (!toProcess.length) {
    console.log(`[kaufland-sync] pending-heal candidates=${stats.candidates} attempted=0 healed=0`);
    return stats;
  }

  for (const { product: p, pendingAtMs } of toProcess) {
    try {
      // toKauflandEan padded 12-stellige UPCs auf EAN-13 — Kauflands
      // product-data liegt unter der gepaddeten Form (Incident 2026-07-16:
      // Funko-UPCs pollten mit 12 Stellen ewig ins 404, healed=0).
      const ean = kauflandApi.toKauflandEan
        ? kauflandApi.toKauflandEan(p?.details?.identifiers?.ean)
        : String(p?.details?.identifiers?.ean || '').replace(/\D+/g, '').trim();
      if (!ean) continue; // ohne EAN kein Product-Data-Status abfragbar
      stats.attempted += 1;

      const status = await kauflandApi.getProductDataStatus(ean).catch(() => null);
      const missing = Array.isArray(status?.missing_attributes) ? status.missing_attributes : [];
      const minOne = Array.isArray(status?.min_one_missing_attributes) ? status.min_one_missing_attributes : [];
      const fullList = [...missing, ...minOne];
      // DECLINED-Werte als Enricher-Hints (gleiches Mapping wie Auto-Repair-
      // Phase / syncKauflandInvalidReasons — 'reason: '-Präfix gestrippt).
      const declined = (Array.isArray(status?.attribute_values) ? status.attribute_values : [])
        .filter((av) => String(av?.state || '').trim().toUpperCase() === 'DECLINED')
        .map((av) => ({
          attribute: String(av?.attribute || '').trim(),
          message: String(av?.message || '').replace(/^reason:\s*/i, '').trim(),
        }))
        .filter((e) => e.attribute || e.message);

      if (status?.product_ready !== true) {
        // Noch nicht ready → Lücken schließen helfen. Bewusst minimal
        // dupliziert statt aus der Auto-Repair-Phase extrahiert (siehe
        // Enrichment-Block dort, gleiche Mechanik) — Extraktion würde den
        // battle-tested Block umschreiben, das Regressions-Risiko ist es
        // hier nicht wert.
        const lastRepairRaw = p?.marketplace?.kaufland?.publish_pending?.last_repair_at;
        const lastRepairMs = lastRepairRaw ? Date.parse(lastRepairRaw) : 0;
        const repairDue = !(Number.isFinite(lastRepairMs) && lastRepairMs > 0)
          || (nowMs - lastRepairMs) > PENDING_HEAL_REPAIR_TTL_MS;
        if ((fullList.length || declined.length) && repairDue) {
          let enrichedProduct = p;
          try {
            const er = await enrichProductForKaufland(p, fullList, { declined });
            if (er?.enriched && Array.isArray(er.enrichedFields) && er.enrichedFields.length) {
              enrichedProduct = er.enriched;
              try {
                await saveProductV2(er.enriched, {
                  source: 'kaufland-pending-heal',
                  stockChangeReason: 'attribute-enrichment',
                  skipStockEvent: true,
                });
              } catch (saveErr) {
                console.warn('[kaufland-sync] pending-heal saveProductV2 failed:', saveErr.message);
              }
            }
          } catch (enrichErr) {
            console.warn('[kaufland-sync] pending-heal enrichment failed (non-fatal):', enrichErr.message);
          }
          await tryRepairKauflandProductData({
            product: enrichedProduct,
            ean,
            idUnit: null,
            storefront: sf,
          }).catch(() => null);
          await productsCol.doc(String(p.id)).update({
            'marketplace.kaufland.publish_pending.last_repair_at': new Date(nowMs).toISOString(),
          }).catch(() => null);
        }
        if ((nowMs - pendingAtMs) > PENDING_HEAL_STALE_MS) {
          // >7 Tage nicht validiert → Operator muss ran; Marker bleibt stehen,
          // damit der Heal weiter versucht falls Kaufland doch noch fertig wird.
          const msg = `Kaufland-Produktdaten seit über 7 Tagen nicht validiert`
            + (fullList.length ? ` — fehlende Attribute: ${fullList.join(', ')}` : '');
          await persistListingError(p.id, msg, 'KAUFLAND_PRODUCT_DATA_PENDING');
        }
        continue;
      }

      // product_ready → Unit anlegen. Defaults wie im Bulk-Publish-Pfad
      // (routes/marketplace.js): ohne Versandgruppe/Lager scheitert das
      // Listing operativ, Fallbacks 144080/70462 sind die Legacy-Defaults.
      const productForCreate = JSON.parse(JSON.stringify(p));
      const klDefaults = await getKlDefaults();
      const kl = productForCreate.details?.kaufland
        || productForCreate.details?.marketplaces?.kaufland
        || {};
      productForCreate.details = productForCreate.details || {};
      productForCreate.details.kaufland = productForCreate.details.kaufland || {};
      if (!(Number(kl.id_shipping_group) > 0)) {
        productForCreate.details.kaufland.id_shipping_group = klDefaults.shippingGroupId || 144080;
      }
      if (!(Number(kl.id_warehouse) > 0)) {
        productForCreate.details.kaufland.id_warehouse = klDefaults.warehouseId || 70462;
      }

      // Preis-Gate: im UNBEAUFSICHTIGTEN Heal-Pfad darf NUR ein ausdrücklich
      // gesetzter Verkaufspreis live gehen (Betreiber-Entscheidung
      // 2026-08-21). Der frühere Fallback bis auf lowest_price.amount hätte
      // den RECHERCHIERTEN Marktpreis ungeprüft online gestellt. Bewusst
      // ENGER als pickUnitData: dort steht der Operator daneben, hier nicht.
      const rawPrice = productForCreate?.details?.pricing?.sellPrice
        ?? productForCreate?.pricing?.kaufland?.price
        ?? productForCreate?.pricing?.sellPrice
        ?? null;
      const sellPrice = Number(String(rawPrice ?? '').replace(',', '.'));
      if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
        await persistListingError(
          p.id,
          'Kaufland-Produktdaten sind validiert, aber kein bestätigter Verkaufspreis (sellPrice) vorhanden — automatisches Listen abgelehnt',
          'KAUFLAND_PRICE_INVALID'
        );
        continue;
      }

      try {
        const result = await kauflandApi.createUnit(productForCreate, { storefront: sf });
        await productsCol.doc(String(p.id)).update({
          'marketplace.kaufland.publish_pending_at': FieldValueRef.delete(),
          'marketplace.kaufland.publish_pending': FieldValueRef.delete(),
          'marketplace.kaufland.listing_errors': FieldValueRef.delete(),
          'marketplace.kaufland.listing_errors_at': FieldValueRef.delete(),
        }).catch(() => null);
        stats.healed += 1;
        console.log(`[kaufland-sync] pending-publish healed ean=${ean} id_unit=${result?.id_unit || 'n/a'}`);
      } catch (createErr) {
        if (createErr?.code === 'KAUFLAND_PRODUCT_DATA_PENDING') {
          // Kaufland verdaut noch — Versuch zählen, Marker bleibt, nächster Lauf.
          await productsCol.doc(String(p.id)).update({
            'marketplace.kaufland.publish_pending.attempts': FieldValueRef.increment(1),
          }).catch(() => null);
        } else {
          // Harter Fehler (z.B. EAN invalid) → Cockpit; Marker bleibt stehen,
          // der Cap begrenzt die Retry-Last pro Lauf.
          await persistListingError(p.id, createErr?.message || 'Publish fehlgeschlagen', createErr?.code || null);
        }
      }
    } catch (healErr) {
      // Per-Produkt swallowen — der Sync darf an keinem Einzelfall sterben.
      console.warn('[kaufland-sync] pending-heal item failed (non-fatal):', healErr?.message || healErr);
    }
  }

  console.log(`[kaufland-sync] pending-heal candidates=${stats.candidates} attempted=${stats.attempted} healed=${stats.healed}`);
  return stats;
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

module.exports = { syncKauflandListingsCache, healPendingKauflandPublishes, syncKauflandInvalidReasons };
