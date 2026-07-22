/**
 * Stock Sync Dispatcher
 *
 * After a stock-out (or stock-in), pushes updated quantity to ALL connected
 * marketplace channels: eBay, Kaufland.
 *
 * Usage:
 *   const { syncStockToAllChannels } = require('./stock-sync-dispatcher');
 *   await syncStockToAllChannels({ tenantId, product });
 */

const { firestore } = require('../lib/firestore');
const { classifyMarketplaceError } = require('../lib/marketplace-error-classifier');
const { computeNextRetryAt } = require('../lib/retry-backoff');
const { guardListingPrice } = require('../lib/best-offer-guard');

const SYNC_LOG_COLLECTION = 'stock_sync_log';
const STOCK_SYNC_FAILURES_COLLECTION = 'stock_sync_failures';
const STOCK_OPERATION_FAILURES_COLLECTION = 'stock_operation_failures';

// WP1 Kill-Switch (Teil E, Task 4/5). default OFF → exakt heutiges Verhalten
// (In-Process-30s-setTimeout-Retry). ON → durable Pfad: synchron in die Queue,
// Drain retried per nextRetryAt/Backoff. Rollback = Flag auf false.
function durableDrainEnabled() {
  return String(process.env.SYNC_DURABLE_DRAIN || '').toLowerCase() === 'true';
}

// WP2 Kill-Switch (Teil E / F0.X). default OFF → Preis-Push unverändert.
// ON → vor dem eBay-Revise die Best-Offer-Auto-Ablehnungsschwelle lesen und
// einen BIN ≤ Schwelle NICHT senden (Listing kann nicht un-änderbar werden).
function bestOfferGuardEnabled() {
  return String(process.env.BEST_OFFER_PRICE_GUARD || '').toLowerCase() === 'true';
}

// Best-effort read of the live auto-decline threshold (MinimumBestOfferPrice).
// Fail-open: on any read error returns null → guard treats as unknown → push proceeds.
async function readEbayAutoDeclineThreshold(itemId) {
  try {
    const { getEbayItem } = require('../lib/ebay-trading-api');
    const observed = await getEbayItem(String(itemId));
    const t = observed?.item?.minimumBestOfferPrice;
    return Number.isFinite(Number(t)) ? Number(t) : null;
  } catch (err) {
    console.warn(`[price-sync] best-offer threshold read failed for ${itemId}: ${err.message}`);
    return null;
  }
}

// Aggregierte Fehlerklasse für ein Failure-Bündel. Precedence wählt die Klasse,
// die das Retry-Scheduling treiben soll (retrybare zuerst, rate_limited dominiert
// wegen Quota-Wartezeit). Nie destruktiv (Klassen-Invariante, Task 1).
const CLASS_PRECEDENCE = ['rate_limited', 'transient', 'unknown', 'listing_config', 'auth'];
function classifyFailureBundle(failedChannels) {
  const classes = (failedChannels || []).map(
    (r) => classifyMarketplaceError(r?.error || `status:${r?.status || ''}`).class
  );
  return CLASS_PRECEDENCE.find((c) => classes.includes(c)) || 'unknown';
}

function extractProductSku(product) {
  return String(
    product?.identification?.sku
    || product?.details?.identifiers?.sku
    || ''
  ).trim();
}

/**
 * Pick the eBay live-listing row that is still ACTIVE. NEVER falls back to an
 * ended/inactive row — doing so made stock-sync resolve a dead itemId and
 * re-push to it on every cycle (production logs: 600+ wasted "already ended"
 * eBay Trading-API calls/day, from just 14 dead listings, one hit 234×/day).
 * Returns null when there is no active listing (→ no eBay call is made).
 */
function pickActiveListing(docs) {
  return (Array.isArray(docs) ? docs : []).find((row) => row && row.active !== false) || null;
}

/**
 * Whether an eBay error message is a transient daily-call-limit error. Such
 * errors must NOT trigger the fail-safe-end (it would kill a healthy listing and
 * the end call is itself rate-limited) — defer and let the drain retry instead.
 */
function isRateLimited(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('exceeded usage limit') || lower.includes('check your call usage');
}

// A definitive "this Kaufland unit does not exist" signal (404). Distinct from a
// transient error: the unit is gone, so retrying it is pointless.
function isUnitNotFound(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('not found') || lower.includes('404') || lower.includes('not_found');
}

/**
 * Retire a dead Kaufland unit so the stock-sync loop stops hammering it.
 *
 * The dispatcher already cleared the stale unitId on the product, but the SKU/EAN
 * resolver re-pulled the SAME dead unit from `kauflandUnitsLive` (still active=true)
 * and wrote it back → endless loop (diagnosed 2026-06-23, ~117 fails/24h for 2 SKUs).
 *
 * Fix: clear the product unitId AND mark the mirror entry inactive so the resolver
 * (which filters active==true) stops re-selecting it. `kaufland-listings-sync`
 * re-activates the entry if the unit genuinely still exists, so this self-corrects
 * a (hypothetical) transient 404.
 */
async function retireKauflandUnit({ productId, unitId, reason = 'unit_not_found' }) {
  const now = new Date().toISOString();
  try {
    // update() statt set({merge:true}): ein set-merge auf ein gelöschtes Produkt
    // erzeugt eine leere ops-only-Hülle neu (Geister-Produkt). update() schlägt
    // auf fehlenden Docs fehl (NOT_FOUND, gRPC code 5) — genau das wollen wir.
    await firestore.collection('products_v2').doc(productId).update({
      'ops.kaufland.unitId': null,
      'ops.kaufland.unitIdCleared': now,
      'ops.kaufland.unitIdClearReason': reason,
    });
  } catch (clearErr) {
    if (clearErr?.code === 5) {
      console.log(`[stock-sync] Product ${productId} no longer exists — skip kaufland unitId clear (no shell resurrection)`);
    } else {
      console.warn(`[stock-sync] Failed to clear stale kaufland unitId for product=${productId}: ${clearErr?.message}`);
    }
  }
  if (unitId) {
    try {
      await firestore.collection('kauflandUnitsLive').doc(String(unitId)).set(
        { active: false, status: 'NOT_FOUND', notFoundAt: now, notFoundReason: reason },
        { merge: true }
      );
    } catch (mirrorErr) {
      console.warn(`[stock-sync] Failed to deactivate stale kaufland mirror unit=${unitId}: ${mirrorErr?.message}`);
    }
  }
  console.log(`[stock-sync] Retired stale kaufland unit=${unitId} for product=${productId} (${reason})`);
}

async function persistSyncFailureForDrain({
  tenantId,
  product,
  reason,
  failedChannels = [],
}) {
  const productId = String(product?.id || '');
  const sku = extractProductSku(product);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const channels = failedChannels.map((r) => String(r?.channel || 'unknown'));
  const errors = failedChannels.map((r) => String(r?.error || `status:${r?.status || 'unknown'}`));

  // Klassifizieren + initialen Backoff stempeln (additive Felder; der Drain liest
  // sie nur bei aktivem Flag, ignoriert sie sonst). attempts=0 → erster Drain-Lauf.
  const classification = classifyFailureBundle(failedChannels);
  const nextRetryAt = computeNextRetryAt({ attempts: 1, now, classification });

  await firestore.collection(STOCK_SYNC_FAILURES_COLLECTION).add({
    tenantId,
    productId,
    reason,
    failedChannels: channels,
    errors,
    createdAt,
  }).catch(() => {});

  await firestore.collection(STOCK_OPERATION_FAILURES_COLLECTION).add({
    tenantId,
    operation: 'stock-sync',
    status: 'pending',
    reason,
    productId,
    source: 'stock-sync-dispatcher',
    classification,
    nextRetryAt,
    attempts: 0,
    failures: failedChannels.map((r) => ({
      step: 'marketplaceSync',
      sku: sku || null,
      productId,
      channel: r?.channel || null,
      error: r?.error || `status:${r?.status || 'unknown'}`,
    })),
    createdAt,
  }).catch(() => {});
}

async function resolveEbayItemIdFromLiveListing({ productId, freshProduct }) {
  const sku = extractProductSku(freshProduct);
  if (!sku) return null;
  try {
    const listingsSnap = await firestore.collection('ebayListingsLive')
      .where('sku', '==', sku)
      .limit(5)
      .get();
    if (listingsSnap.empty) return null;
    const docs = listingsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const activeListing = pickActiveListing(docs);
    if (!activeListing) return null; // no ACTIVE listing → don't revive a dead itemId
    const itemId = String(activeListing?.itemId || activeListing?.id || '').trim();
    if (!itemId) return null;
    await firestore.collection('products_v2').doc(productId)
      .set({ ops: { ebay: { itemId, itemIdSource: 'ebayListingsLive', itemIdResolvedAt: new Date().toISOString() } } }, { merge: true })
      .catch(() => {});
    console.log(`[stock-sync] ebay itemId resolved via listing lookup: ${itemId} (sku=${sku})`);
    return itemId;
  } catch (err) {
    console.warn(`[stock-sync] ebay itemId lookup failed for product=${productId}: ${err.message}`);
    return null;
  }
}

/**
 * Merkt sich am Produkt, DASS und WELCHES eBay-Listing der Stock-Sync wegen
 * availableQty=0 beendet hat (Incident 2026-07-19, SKU-6656556112). Nur mit
 * diesem Marker darf der Sync später automatisch relisten — manuell (Operator/
 * eBay-seitig) beendete Angebote werden NIE ungefragt wiederbelebt.
 * update() statt set-merge: kein Wiederbeleben gelöschter Produkte als Hülle.
 */
async function writeZeroStockEndMarker({ productId, itemId, reason }) {
  try {
    await firestore.collection('products_v2').doc(productId).update({
      'ops.ebay.zeroStockEnd': {
        itemId: String(itemId),
        at: new Date().toISOString(),
        reason: String(reason || 'zero-stock'),
      },
    });
  } catch (err) {
    if (err?.code !== 5) {
      console.warn(`[stock-sync] zeroStockEnd marker write failed for ${productId}: ${err?.message}`);
    }
  }
}

/**
 * SELBSTHEILUNG (Incident 2026-07-19): kommt Bestand zurück, nachdem der
 * Zero-Stock-Pfad das eBay-Listing beendet hat, wird es via
 * RelistFixedPriceItem wiederbelebt statt für immer still übersprungen
 * (Revise auf ein beendetes Listing kann es nie zurückholen). eBay erzeugt
 * eine NEUE ItemID; Produkt + Mirror werden sofort umgehängt, der 15-min
 * Light-Sync füllt die restlichen Mirror-Felder nach.
 *
 * @returns {string} neue ItemID
 * @throws bei Relist-Fehler (Aufrufer stempelt retryable-Failure → Drain)
 */
async function relistEndedEbayListing({ productId, freshProduct, endedItemId, quantity }) {
  const relisted = await relistWithSiteResolution(String(endedItemId), { quantity });
  const newItemId = String(relisted?.itemId || '').trim();
  if (!newItemId) {
    throw new Error(`RelistFixedPriceItem lieferte keine neue ItemID (ack=${relisted?.ack || 'unknown'})`);
  }
  const nowIso = new Date().toISOString();
  try {
    await firestore.collection('products_v2').doc(productId).update({
      'ops.ebay.itemId': newItemId,
      'ops.ebay.itemIdSource': 'relist',
      'ops.ebay.relistedAt': nowIso,
      'ops.ebay.relistedFrom': String(endedItemId),
      'ops.ebay.zeroStockEnd': null,
      'listingStatus.ebay': 'active',
    });
  } catch (err) {
    if (err?.code !== 5) {
      console.warn(`[stock-sync] relist product update failed for ${productId}: ${err?.message}`);
    }
  }
  try {
    const sku = extractProductSku(freshProduct);
    await firestore.collection('ebayListingsLive').doc(newItemId).set({
      itemId: newItemId,
      sku: sku || null,
      active: true,
      relistedFrom: String(endedItemId),
      relistedAt: nowIso,
      quantityAvailable: Number(quantity) || null,
      source: 'stock-sync-relist',
    }, { merge: true });
  } catch (_) { /* best-effort mirror seed */ }
  console.log(
    `[stock-sync] ebay RELIST product=${productId} ${endedItemId} → ${newItemId} qty=${quantity} (Bestand zurück — Listing wiederbelebt)`
  );
  return newItemId;
}

// eBay verweigert den Relist dauerhaft (nur 1× pro beendetem Listing, nur der
// Verkäufer, nur ≤90 Tage) — Retry ist dann sinnlos, der Drain darf nicht
// unbegrenzt Failure-Docs erzeugen.
const MAX_RELIST_ATTEMPTS = 5;
const RELIST_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Relist ist SITE-GEBUNDEN (empirisch 2026-07-22): ein auf ebay.at/it/es/be/fr
// erstelltes Listing lässt sich nur mit SEINER Site-ID im Header relisten.
// Die Site steht nirgends im ActiveList-Feed — einzige Quelle ist die Domain
// der viewItemUrl im Mirror-Doc.
const EBAY_DOMAIN_TO_SITE_ID = {
  'ebay.de': '77',
  'ebay.at': '16',
  'ebay.fr': '71',
  'ebay.it': '101',
  'ebay.es': '186',
  'benl.ebay.be': '123',
  'befr.ebay.be': '23',
  'ebay.nl': '146',
  'ebay.ie': '205',
  'ebay.co.uk': '3',
  'ebay.pl': '212',
};

async function resolveListingSiteId(itemId) {
  try {
    const snap = await firestore.collection('ebayListingsLive').doc(String(itemId)).get();
    const url = String(snap.data()?.viewItemUrl || '');
    const m = url.match(/https?:\/\/(?:www\.)?([a-z.]*ebay\.[a-z.]+)\//i);
    if (m && EBAY_DOMAIN_TO_SITE_ID[m[1].toLowerCase()]) {
      return EBAY_DOMAIN_TO_SITE_ID[m[1].toLowerCase()];
    }
  } catch (_) { /* fallback default site */ }
  return null; // callTradingApi fällt auf die konfigurierte Default-Site zurück
}

// "Nicht auf dieser eBay-Website eingestellt" — falsche Site-ID im Header.
// Kommt lokalisiert zurück (DE/NL/…). Belgien-Sonderfall: benl (123) und
// befr (23) teilen sich die URL-Domain-Sprache nicht zuverlässig mit der
// Erstell-Site → bei diesem Fehler einmal mit der Schwester-Site retrien
// (empirisch 2026-07-22, SKU-9550750665: Mirror-URL benl, erstellt auf befr).
function isWrongSiteError(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('nicht auf dieser ebay-website')
    || lower.includes('niet op deze ebay-website')
    || lower.includes('not listed on this ebay site')
    || lower.includes('ursprünglich nicht auf dieser');
}

function alternateSiteId(siteId) {
  if (String(siteId) === '123') return '23';
  if (String(siteId) === '23') return '123';
  return null;
}

// Relist mit Site-Auflösung + einmaligem Schwester-Site-Retry (BE).
async function relistWithSiteResolution(itemId, { quantity }) {
  const { relistFixedPriceItem } = require('../lib/ebay-trading-api');
  const siteId = await resolveListingSiteId(itemId);
  try {
    return await relistFixedPriceItem(String(itemId), { quantity, siteId });
  } catch (err) {
    const alt = alternateSiteId(siteId);
    if (alt && isWrongSiteError(err?.message)) {
      console.log(`[stock-sync] Relist ${itemId}: falsche Site ${siteId} → Retry mit Schwester-Site ${alt}`);
      return relistFixedPriceItem(String(itemId), { quantity, siteId: alt });
    }
    throw err;
  }
}

function isPermanentRelistError(msg) {
  // "nicht auf dieser eBay-Website eingestellt" zählt als permanent, WENN es
  // nach dem Schwester-Site-Retry (relistWithSiteResolution) noch auftritt —
  // weitere Retries mit denselben Sites sind sinnlos (kein Drain-Loop).
  return /cannot be relisted|kann nicht (erneut|wieder) (ein)?gelistet|not the seller|nicht der verk[äa]ufer|belongs to another|another seller|nicht auf dieser ebay-website|niet op deze ebay-website|not listed on this ebay site|ursprünglich nicht auf dieser/i
    .test(String(msg || ''));
}

// Selbstheilung aufgeben: Marker leeren (Heal-Cron + Drain hören auf), Audit-
// Feld hinterlassen, Operator EINMAL alarmieren. Kein Marktplatz-Write —
// Punkt-14-sicher (wir hören nur auf zu versuchen).
async function abandonZeroStockEndMarker({ productId, marker, reason }) {
  try {
    await firestore.collection('products_v2').doc(productId).update({
      'ops.ebay.zeroStockEnd': null,
      'ops.ebay.zeroStockEndAbandoned': {
        ...(marker || {}),
        abandonedAt: new Date().toISOString(),
        abandonReason: String(reason || '').slice(0, 300),
      },
    });
  } catch (err) {
    if (err?.code !== 5) console.warn(`[stock-sync] abandon marker failed for ${productId}: ${err?.message}`);
  }
  try {
    const { emitOpsAlert } = require('../lib/ops-alert');
    emitOpsAlert({
      source: 'stock-sync-relist',
      severity: 'warning',
      tenantId: 'default',
      message: `eBay-Relist aufgegeben: Produkt ${productId}, beendetes Listing ${marker?.itemId || '?'} — ${reason}. Produkt hat Bestand, aber kein Angebot: bitte manuell über Publish listen.`,
      context: { productId, itemId: marker?.itemId || null, reason: String(reason || '') },
    });
  } catch (_) { /* best-effort */ }
}

/**
 * Marker-basierter Relist-Versuch mit Give-up-Guard (Review-Findings 7/9):
 * Versuchs-Cap + 90-Tage-Fenster + Permanent-Fehler-Klassifikation. Transiente
 * Fehler → retryable Failure (Drain), permanente → Marker aufgeben + Alarm.
 */
async function attemptMarkerRelist({ productId, freshProduct, marker, quantity, results }) {
  const attempts = Number(marker?.relistAttempts || 0);
  const markerAge = marker?.at ? Date.now() - Date.parse(marker.at) : 0;
  if (attempts >= MAX_RELIST_ATTEMPTS || (Number.isFinite(markerAge) && markerAge > RELIST_WINDOW_MS)) {
    const reason = attempts >= MAX_RELIST_ATTEMPTS
      ? `${attempts} Relist-Versuche fehlgeschlagen`
      : 'Relist-Fenster (90 Tage) abgelaufen';
    await abandonZeroStockEndMarker({ productId, marker, reason });
    results.push({ channel: 'ebay', status: 'skipped', itemId: marker?.itemId, action: 'relist_abandoned', quantityPushed: 0 });
    console.warn(`[stock-sync] ebay RELIST ABANDONED product=${productId} itemId=${marker?.itemId}: ${reason}`);
    return;
  }

  // SIBLING-RELIST (Lücke bewiesen 2026-07-22, SKU-9550750665): der Fan-Out
  // endet bei Null-Bestand ALLE Länder-Listings, die Selbstheilung holte aber
  // nur das getrackte zurück — 4 internationale Listings blieben trotz
  // Bestand tot. Jetzt: Geschwister ZUERST (jedes einzeln aus der Marker-
  // Liste abgearbeitet und bei Erfolg/permanentem Fehler entfernt), das
  // getrackte ZULETZT — denn dessen Erfolg leert den Marker. Bricht ein
  // Geschwister transient ab, bleibt der Marker samt Restliste stehen und
  // der Drain wiederholt den kompletten Sync.
  const pendingSiblings = (Array.isArray(marker?.siblingItemIds) ? marker.siblingItemIds : [])
    .map((v) => String(v || '').trim()).filter(Boolean);
  let remainingSiblings = [...pendingSiblings];
  for (const sibId of pendingSiblings) {
    try {
      const relisted = await relistWithSiteResolution(sibId, { quantity });
      const newId = String(relisted?.itemId || '').trim();
      if (!newId) throw new Error(`RelistFixedPriceItem lieferte keine neue ItemID (ack=${relisted?.ack || 'unknown'})`);
      const sku = extractProductSku(freshProduct);
      await firestore.collection('ebayListingsLive').doc(newId).set({
        itemId: newId,
        sku: sku || null,
        active: true,
        relistedFrom: sibId,
        relistedAt: new Date().toISOString(),
        quantityAvailable: Number(quantity) || null,
        source: 'stock-sync-relist-sibling',
      }, { merge: true }).catch(() => {});
      remainingSiblings = remainingSiblings.filter((id) => id !== sibId);
      await firestore.collection('products_v2').doc(productId)
        .update({ 'ops.ebay.zeroStockEnd.siblingItemIds': remainingSiblings })
        .catch(() => {});
      results.push({ channel: 'ebay', status: 'success', itemId: newId, quantityPushed: quantity, action: 'relisted_sibling' });
      console.log(`[stock-sync] ebay RELIST sibling product=${productId} ${sibId} → ${newId} qty=${quantity}`);
    } catch (sibErr) {
      const sibMsg = sibErr?.message || String(sibErr);
      if (isPermanentRelistError(sibMsg)) {
        // Dieses Geschwister ist nie relistbar (Alt-Konto/bereits relisted/
        // >90d) — aus der Liste nehmen, Rest + getracktes weiterversuchen.
        remainingSiblings = remainingSiblings.filter((id) => id !== sibId);
        await firestore.collection('products_v2').doc(productId)
          .update({ 'ops.ebay.zeroStockEnd.siblingItemIds': remainingSiblings })
          .catch(() => {});
        results.push({ channel: 'ebay', status: 'skipped', itemId: sibId, action: 'sibling_relist_permanently_failed', error: sibMsg, quantityPushed: 0 });
        console.warn(`[stock-sync] ebay RELIST sibling permanent abgelehnt product=${productId} ${sibId}: ${sibMsg.slice(0, 120)}`);
        continue;
      }
      // Transient: Marker + Restliste bleiben stehen, Drain wiederholt alles.
      try {
        await firestore.collection('products_v2').doc(productId).update({
          'ops.ebay.zeroStockEnd.relistAttempts': attempts + 1,
          'ops.ebay.zeroStockEnd.lastRelistAttemptAt': new Date().toISOString(),
        });
      } catch (_) { /* best-effort */ }
      results.push({ channel: 'ebay', status: 'failed', itemId: sibId, error: sibMsg, retryable: true, action: 'sibling_relist_failed' });
      console.warn(`[stock-sync] ebay RELIST sibling FAILED product=${productId} ${sibId} — deferring to drain: ${sibMsg}`);
      return;
    }
  }

  try {
    const newItemId = await relistEndedEbayListing({
      productId,
      freshProduct,
      endedItemId: marker.itemId,
      quantity,
    });
    results.push({ channel: 'ebay', status: 'success', itemId: newItemId, quantityPushed: quantity, action: 'relisted' });
  } catch (relistErr) {
    const relistMsg = relistErr?.message || String(relistErr);
    if (isPermanentRelistError(relistMsg)) {
      await abandonZeroStockEndMarker({ productId, marker, reason: `permanent abgelehnt: ${relistMsg}` });
      results.push({ channel: 'ebay', status: 'skipped', itemId: marker.itemId, action: 'relist_permanently_failed', error: relistMsg, quantityPushed: 0 });
      console.warn(`[stock-sync] ebay RELIST permanent abgelehnt product=${productId} itemId=${marker.itemId}: ${relistMsg}`);
      return;
    }
    // Versuchszähler stempeln, dann via Drain retrien (nie destruktiv, Punkt 14)
    try {
      await firestore.collection('products_v2').doc(productId).update({
        'ops.ebay.zeroStockEnd.relistAttempts': attempts + 1,
        'ops.ebay.zeroStockEnd.lastRelistAttemptAt': new Date().toISOString(),
      });
    } catch (_) { /* best-effort */ }
    results.push({ channel: 'ebay', status: 'failed', itemId: marker.itemId, error: relistMsg, retryable: true, action: 'relist_failed' });
    console.warn(`[stock-sync] ebay RELIST FAILED product=${productId} itemId=${marker.itemId} — deferring to drain: ${relistMsg}`);
  }
}

/**
 * Find products by SKU — searches both identification.sku and details.identifiers.sku
 * to avoid the silent-miss bug where products only have SKU in one field.
 */
async function findProductsBySkuChunk(skuChunk) {
  const found = new Map();
  // Primary: identification.sku
  const snap1 = await firestore.collection('products_v2')
    .where('identification.sku', 'in', skuChunk)
    .get();
  for (const doc of snap1.docs) {
    found.set(doc.id, { id: doc.id, ...doc.data() });
  }
  // Fallback: details.identifiers.sku (for products that only have SKU there)
  const snap2 = await firestore.collection('products_v2')
    .where('details.identifiers.sku', 'in', skuChunk)
    .get();
  for (const doc of snap2.docs) {
    if (!found.has(doc.id)) {
      found.set(doc.id, { id: doc.id, ...doc.data() });
    }
  }
  return [...found.values()];
}

/**
 * Compute true available quantity for a product by subtracting
 * active reservations from physical stock.
 *
 * @param {Object} product - Product with inventory.quantity and identification.sku
 * @param {string} tenantId
 * @returns {Promise<{ physicalQty: number, reservedQty: number, availableQty: number }>}
 */
async function computeAvailableQuantity(product, tenantId = 'default') {
  const physicalQty = Number(product?.inventory?.quantity ?? 0);
  const sku = String(product?.identification?.sku || product?.details?.identifiers?.sku || '').trim();
  const productId = String(product?.id || '');

  let reservedQty = 0;
  try {
    const { getReservedQuantity } = require('./stock-reservation');
    const reservations = [];
    if (sku) {
      reservations.push(await getReservedQuantity({ tenantId, sku }));
    }
    if (productId) {
      reservations.push(await getReservedQuantity({ tenantId, productId }));
    }
    reservedQty = reservations.length > 0 ? Math.max(...reservations) : 0;
  } catch (err) {
    console.warn(`[stock-sync] reservation lookup failed for ${sku || productId}: ${err.message}`);
  }

  const availableQty = Math.max(0, physicalQty - reservedQty);
  return { physicalQty, reservedQty, availableQty };
}

/**
 * Sync stock quantity to all connected marketplace channels for a product.
 * Computes real availableQuantity from physical stock minus active reservations.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (default: 'default')
 * @param {Object} params.product - Full product object from Firestore
 * @param {string} [params.reason] - Why the sync was triggered (e.g., 'stock-out', 'stock-in')
 * @returns {Object} { results: Array<{ channel, status, error? }> }
 */
async function syncStockToAllChannels({ tenantId = 'default', product, reason = 'manual', onlyChannels = null }) {
  if (!product?.id) {
    return { results: [{ channel: 'all', status: 'skipped', error: 'no product id' }] };
  }

  // Additiver Kanal-Filter (Oversell-Incident 2026-07-11): der Auto-Heal darf
  // nur die Kanäle anfassen, die tatsächlich GESENKT werden müssen. Ohne den
  // Filter würde ein Down-Push für Kanal A denselben (evtl. stale-hohen)
  // availableQty auch auf Kanal B schreiben und dort ein frisch ausverkauftes
  // Listing wieder scharf machen. null/leer = alle Kanäle (Default, unverändert
  // für alle bestehenden Aufrufer).
  const channelFilter = Array.isArray(onlyChannels) && onlyChannels.length
    ? new Set(onlyChannels.map((c) => String(c || '').toLowerCase()).filter(Boolean))
    : null;
  const channelAllowed = (name) => !channelFilter || channelFilter.has(name);

  const productId = String(product.id);
  const { withStockLock } = require('../lib/stock-lock');

  return withStockLock(`sync:${productId}`, async () => {

  // Read fresh product data from Firestore to avoid stale quantities
  let freshProduct = product;
  try {
    const freshDoc = await firestore.collection('products_v2').doc(productId).get();
    if (freshDoc.exists) {
      freshProduct = { id: freshDoc.id, ...freshDoc.data() };
    }
  } catch (err) {
    console.warn(`[stock-sync] fresh read failed for ${productId}, using passed object: ${err.message}`);
  }

  const { physicalQty: quantity, reservedQty, availableQty: availableQuantity } =
    await computeAvailableQuantity(freshProduct, tenantId);
  const results = [];
  const isZeroStock = availableQuantity === 0;

  if (isZeroStock) {
    console.warn(`[stock-sync] ⚠️ ZERO STOCK product=${productId} physical=${quantity} reserved=${reservedQty} → pushing 0 to all channels`);
  }

  // --- eBay ---
  const ebayItemId = freshProduct?.ops?.ebay?.itemId
    || freshProduct?.ops?.ebay?.item_id
    || freshProduct?.marketplace?.ebay?.itemId;
  let resolvedEbayItemId = ebayItemId;
  if (!resolvedEbayItemId && channelAllowed('ebay')) {
    resolvedEbayItemId = await resolveEbayItemIdFromLiveListing({ productId, freshProduct });
  }

  const isEndedListing = (msg) => {
    const lower = String(msg || '').toLowerCase();
    return lower.includes('beendet') || lower.includes('ended') || lower.includes('1047');
  };

  // Fremdes/entferntes Listing = TERMINAL, nie retrybar (Quota-Fresser
  // 2026-07-21: 4 Produkte mit 389…-Alt-Konto-ItemIDs erzeugten ~250
  // sinnlose END-Retries/Tag über Drain+Reconciliation, weil "Auf den
  // Artikel kann nicht zugegriffen werden…" weder isEndedListing noch
  // isRateLimited matcht). Der Pointer ist tot → aufräumen statt hämmern.
  const isForeignOrRemovedListing = (msg) => {
    const lower = String(msg || '').toLowerCase();
    return lower.includes('kann nicht zugegriffen')
      || lower.includes('nicht der verkäufer')
      || lower.includes('not the seller')
      || lower.includes('angebot entfernt')
      || lower.includes('belongs to another')
      || lower.includes('ungültige artikelnummer')
      || lower.includes('invalid item id');
  };

  if (resolvedEbayItemId && channelAllowed('ebay')) {
    const clearStaleItemId = async () => {
      try {
        // update() statt set({merge:true}) — kein Neu-Anlegen gelöschter Produkte
        // als ops-only-Hülle (Geister-Produkt). NOT_FOUND wird unten behandelt.
        await firestore.collection('products_v2').doc(productId).update({
          'ops.ebay.itemId': null,
          'ops.ebay.itemIdCleared': new Date().toISOString(),
          'ops.ebay.itemIdClearReason': 'listing_ended',
          'listingStatus.ebay': 'inactive',
        });
        // Mark the cached live listing inactive too, so resolveEbayItemIdFromLiveListing
        // stops handing the stale itemId straight back next cycle (the loop behind
        // 600+ wasted "already ended" eBay calls/day). A re-list re-activates it via
        // the listing ingest.
        // NUR die Docs der TOTEN ItemID deaktivieren — die "ended"-Evidenz gilt
        // ausschließlich für resolvedEbayItemId. Vorher wurden ALLE ≤5 Docs der
        // SKU inaktiv gestempelt und damit auch parallel existierende, live
        // laufende Listings (Operator-Duplikat-Relists) aus dem Mirror gelöscht
        // (beobachtet 2026-07-20 08:23 an SKU-6656556112: 4 Docs auf einen
        // Schlag inaktiv). Der Light-Sync korrigierte das erst 15 min später.
        try {
          const sku = extractProductSku(freshProduct);
          const deadId = String(resolvedEbayItemId || '');
          if (sku && deadId) {
            const snap = await firestore.collection('ebayListingsLive').where('sku', '==', sku).limit(5).get();
            await Promise.all(snap.docs
              .filter((d) => d.id === deadId || String(d.data()?.itemId || '') === deadId)
              .map((d) =>
                d.ref.set({ active: false, endedDetectedAt: new Date().toISOString() }, { merge: true }).catch(() => {})
              ));
          }
        } catch (_) { /* best-effort cache cleanup */ }
        console.log(`[stock-sync] Cleared stale ebay itemId + marked listing inactive for product=${productId} (listing ended)`);
      } catch (clearErr) {
        if (clearErr?.code === 5) {
          console.log(`[stock-sync] Product ${productId} no longer exists — skip ebay itemId clear (no shell resurrection)`);
        } else {
          console.warn(`[stock-sync] Failed to clear stale ebay itemId: ${clearErr?.message}`);
        }
      }
    };

    if (isZeroStock) {
      // Zero stock: end listing instead of revise(qty=0) which eBay rejects
      try {
        const { endFixedPriceItem } = require('../lib/ebay-trading-api');
        await endFixedPriceItem(String(resolvedEbayItemId), { reason: 'NotAvailable' });
        // Selbstheilungs-Marker: WIR haben dieses Listing wegen Null-Bestand
        // beendet → sobald wieder Bestand da ist, darf der Sync es automatisch
        // relisten (Incident 2026-07-19: ohne Marker+Relist blieb ein wegen
        // Doppelzählung fälschlich beendetes Listing für immer tot).
        await writeZeroStockEndMarker({ productId, itemId: resolvedEbayItemId, reason });
        results.push({ channel: 'ebay', status: 'success', itemId: resolvedEbayItemId, quantityPushed: 0, zeroStock: true, action: 'ended' });
        console.log(`[stock-sync] ebay END product=${productId} itemId=${resolvedEbayItemId} → ended (zero stock)`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (isEndedListing(errMsg)) {
          // Listing was already ended — treat as success, clear stale itemId.
          // BEWUSST KEIN zeroStockEnd-Marker (Review-Finding 4): "already
          // ended" beweist NICHT, dass WIR beendet haben — es kann eine
          // Operator-Entscheidung von vor Stunden/Tagen sein. Marker nur, wenn
          // unser eigenes EndFixedPriceItem tatsächlich durchging (oben).
          // Im Zweifel nicht wiederbeleben — konservativ wie vor dem Fix.
          results.push({ channel: 'ebay', status: 'success', itemId: resolvedEbayItemId, quantityPushed: 0, zeroStock: true, action: 'already_ended' });
          console.log(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} already ended, clearing stale itemId`);
          await clearStaleItemId();
        } else if (isForeignOrRemovedListing(errMsg)) {
          // Alt-Konto-/entfernte ItemID: es GIBT nichts zu beenden. Terminal
          // aufräumen (skipped, kein Drain-Doc) statt für immer zu retrien.
          results.push({ channel: 'ebay', status: 'skipped', itemId: resolvedEbayItemId, error: 'foreign_or_removed_itemid', action: 'stale_pointer_cleared', quantityPushed: 0 });
          console.warn(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} fremd/entfernt → stale Pointer bereinigt (kein Retry): ${errMsg.slice(0, 120)}`);
          await clearStaleItemId();
        } else {
          results.push({ channel: 'ebay', status: 'error', error: errMsg });
          console.warn(`[stock-sync] ebay END FAILED product=${productId} itemId=${resolvedEbayItemId}:`, errMsg);
          if (isEndedListing(errMsg)) await clearStaleItemId();
        }
      }
    } else {
      // Stock > 0: revise quantity. If this fails, fail-safe end the listing
      // to prevent oversell on stale higher marketplace quantity.
      try {
        const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
        const result = await reviseFixedPriceItem({
          itemId: String(resolvedEbayItemId),
          quantity: availableQuantity,
        });
        const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
        results.push({ channel: 'ebay', status, itemId: resolvedEbayItemId, quantityPushed: availableQuantity, zeroStock: false });
        console.log(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} qty=${availableQuantity} status=${status}`);
        // Erfolgreicher Revise = Liveness-Beweis des aktuellen Listings → ein
        // evtl. noch stehender Selbstheilungs-Marker ist erledigt (einziger
        // legitimer Clear-Punkt neben erfolgreichem Relist — Review-Findings
        // 3/10: sonst triggert der Heal-Cron dieses Produkt jeden Zyklus neu).
        if (status === 'success' && freshProduct?.ops?.ebay?.zeroStockEnd) {
          await firestore.collection('products_v2').doc(productId)
            .update({ 'ops.ebay.zeroStockEnd': null })
            .catch(() => {});
        }
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (isEndedListing(errMsg)) {
          // Listing was ended — can't revise. Bestand ist aber > 0!
          // Duplikat-Schutz VOR clearStaleItemId prüfen: existiert für die SKU
          // ein ANDERES noch aktives Listing (Operator-Relist direkt auf eBay),
          // NICHT relisten — sonst zwei parallele Angebote derselben Einheit.
          let otherActiveItemId = null;
          // Fail-CLOSED (Review-Finding 5): schlägt die Guard-Query fehl,
          // wissen wir nicht, ob ein Zweit-Listing lebt → NICHT blind
          // relisten, sondern retryable an den Drain übergeben.
          let dupGuardOk = false;
          try {
            const sku = extractProductSku(freshProduct);
            if (sku) {
              const dupSnap = await firestore.collection('ebayListingsLive').where('sku', '==', sku).limit(5).get();
              const other = dupSnap.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .find((row) => row.active !== false && String(row.itemId || row.id) !== String(resolvedEbayItemId));
              if (other) otherActiveItemId = String(other.itemId || other.id);
            }
            dupGuardOk = true; // ohne SKU keine Mirror-Rows möglich → Guard erfüllt
          } catch (guardErr) {
            console.warn(`[stock-sync] dup-guard query failed for product=${productId}: ${guardErr?.message}`);
          }
          await clearStaleItemId();

          const marker = freshProduct?.ops?.ebay?.zeroStockEnd;
          if (otherActiveItemId) {
            // Anderes Listing lebt (laut Mirror) → dorthin umhängen, nächster
            // Sync revised es. Der Marker bleibt BEWUSST stehen (Review-
            // Findings 1/6/12): der Mirror kann stale sein — erst ein
            // ERFOLGREICHER Revise/Relist beweist Leben und leert den Marker.
            // Ist die Row stale-tot, schlägt der nächste Revise fehl und der
            // Marker ermöglicht dann die Relist-Selbstheilung.
            try {
              await firestore.collection('products_v2').doc(productId).update({
                'ops.ebay.itemId': otherActiveItemId,
                'ops.ebay.itemIdSource': 'ebayListingsLive',
              });
            } catch (_) { /* best-effort */ }
            results.push({ channel: 'ebay', status: 'skipped', itemId: otherActiveItemId, action: 'switched_to_other_active_listing', quantityPushed: 0 });
            console.log(`[stock-sync] ebay product=${productId} ${resolvedEbayItemId} ended, aber ${otherActiveItemId} ist aktiv (Mirror) → itemId umgehängt`);
          } else if (marker?.itemId && String(marker.itemId) === String(resolvedEbayItemId) && dupGuardOk) {
            // WIR haben GENAU DIESES Listing wegen Null-Bestand beendet +
            // Bestand ist zurück → SELBSTHEILUNG. Marker-Match-Guard (Review-
            // Finding 10): ein Marker für eine ANDERE (ältere) ItemID darf
            // nicht ein vom Operator später beendetes Listing wiederbeleben.
            await attemptMarkerRelist({ productId, freshProduct, marker, quantity: availableQuantity, results });
          } else if (marker?.itemId && String(marker.itemId) === String(resolvedEbayItemId) && !dupGuardOk) {
            results.push({ channel: 'ebay', status: 'failed', itemId: marker.itemId, error: 'dup_guard_unavailable', retryable: true, action: 'relist_deferred' });
            console.warn(`[stock-sync] ebay RELIST deferred product=${productId} — Duplikat-Guard nicht verfügbar, Drain retried`);
          } else {
            // Kein Marker = nicht von uns beendet (Operator/eBay) → wie bisher
            // überspringen, niemals ungefragt wiederbeleben.
            results.push({ channel: 'ebay', status: 'skipped', itemId: resolvedEbayItemId, error: 'listing_ended', quantityPushed: 0 });
            console.warn(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} listing ended (kein zeroStockEnd-Marker), cleared stale itemId`);
          }
        } else if (isRateLimited(errMsg)) {
          // Transient eBay rate limit — the listing is NOT dead. Ending it would
          // be WRONG (lose a live sale) and the end call would itself be rate-
          // limited ("fail_safe_end_failed"). Defer: record a retryable failure;
          // the drain retries once quota resets. Avoids a doomed 2nd call AND
          // avoids killing healthy listings on a transient error.
          results.push({ channel: 'ebay', status: 'failed', itemId: resolvedEbayItemId, error: errMsg, retryable: true });
          console.warn(`[stock-sync] ebay RATE-LIMITED product=${productId} itemId=${resolvedEbayItemId} — deferring (no fail-safe end): ${errMsg}`);
        } else if (isForeignOrRemovedListing(errMsg)) {
          // Alt-Konto-/entfernte ItemID beim Revise: der Pointer ist tot,
          // Retry sinnlos → terminal aufräumen (kein Drain-Doc). Der nächste
          // Sync resolvet ggf. ein echtes aktives Listing aus dem Mirror.
          results.push({ channel: 'ebay', status: 'skipped', itemId: resolvedEbayItemId, error: 'foreign_or_removed_itemid', action: 'stale_pointer_cleared', quantityPushed: 0 });
          console.warn(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} fremd/entfernt beim Revise → stale Pointer bereinigt (kein Retry): ${errMsg.slice(0, 120)}`);
          await clearStaleItemId();
        } else {
          // A revise failure at stock > 0 means the eBay listing is UNCHANGED —
          // it does NOT prove the stock is gone. Ending it here was a silent,
          // destructive over-reaction: Incident 2026-06-16 killed 66 healthy
          // listings in 30d this way (Best-Offer pricing-config errors,
          // transient "operation aborted", image errors) — 0 were genuine
          // stock-outs. The fake-`success` end also bypassed the drain, so no
          // repair was ever queued. Per the oversell architecture
          // (decisions.md), a failed sync belongs in the durable drain, NOT a
          // marketplace mutation: record a retryable failure so
          // syncStockWithRetry → stock_operation_failures → stock-failure-drain
          // retries, and stock-reconciliation independently reconciles. The true
          // zero-stock end is handled above in the isZeroStock branch.
          results.push({
            channel: 'ebay',
            status: 'failed',
            itemId: resolvedEbayItemId,
            error: errMsg,
            retryable: true,
            action: 'revise_failed_deferred',
          });
          console.warn(
            `[stock-sync] ebay REVISE FAILED product=${productId} itemId=${resolvedEbayItemId} — deferring to drain (NOT ending healthy listing): ${errMsg}`
          );
        }
      }
    }
  } else if (channelAllowed('ebay') && !isZeroStock && freshProduct?.ops?.ebay?.zeroStockEnd?.itemId) {
    // Post-Clear-Selbstheilung: die ItemID wurde nach dem Zero-Stock-End
    // bereits genullt (clearStaleItemId) und der Mirror ist inaktiv — bis zum
    // Incident 2026-07-19 übersprang der Sync eBay hier STILL für immer (kein
    // Fehler, kein Drain, kein Alarm). Mit zeroStockEnd-Marker + Bestand > 0
    // wird das von UNS beendete Listing jetzt wiederbelebt.
    // resolveEbayItemIdFromLiveListing lief oben bereits und fand KEIN aktives
    // Mirror-Listing (sonst wäre resolvedEbayItemId gesetzt) — Duplikat-Guard
    // damit implizit erfüllt. Give-up-Guard + Permanent-Klassifikation im
    // Helper (Review-Findings 7/9).
    const marker = freshProduct.ops.ebay.zeroStockEnd;
    await attemptMarkerRelist({ productId, freshProduct, marker, quantity: availableQuantity, results });
  }

  // ── eBay Multi-Site-Fan-Out (2026-07-21) ──────────────────────────────────
  // Der internationale Rollout (19.07.) erzeugte pro SKU bis zu 6 UNABHÄNGIGE
  // Listings (eigene ItemID je Länderseite: de/it/es/be/at/fr), jedes mit
  // vollem Bestand. Der Block oben bedient nur die GETRACKTE ItemID
  // (ops.ebay.itemId, i. d. R. DE) — ohne Fan-Out liefen die Geschwister-
  // Listings nach jedem Verkauf/Pick mit stalem Bestand weiter →
  // Cross-Site-Oversell (Multi-Site-Variante des Incidents 2026-04).
  // Hier: Menge auf ALLE weiteren aktiven Listings der SKU pushen, bei
  // Null-Bestand ALLE beenden. Lifecycle (zeroStockEnd-Marker/Relist/Switch)
  // bleibt bewusst dem getrackten Listing vorbehalten — die Länder-Listings
  // verwaltet das Internationalisierungs-Tool des Operators.
  if (channelAllowed('ebay')) {
    try {
      const sku = extractProductSku(freshProduct);
      // Erfolgreich beendete Geschwister-IDs sammeln — sie wandern unten in
      // den zeroStockEnd-Marker, damit die Selbstheilung bei Bestands-
      // Rückkehr ALLE Länder-Listings wiederbelebt, nicht nur das getrackte
      // (Lücke bewiesen 2026-07-22 an SKU-9550750665).
      const endedSiblingIds = [];
      if (sku) {
        const sibSnap = await firestore.collection('ebayListingsLive').where('sku', '==', sku).limit(10).get();
        const trackedId = String(resolvedEbayItemId || '');
        const seenSiblings = new Set();
        for (const doc of sibSnap.docs) {
          const data = doc.data() || {};
          const sibId = String(data.itemId || doc.id);
          if (!sibId || sibId === trackedId || data.active === false || seenSiblings.has(sibId)) continue;
          seenSiblings.add(sibId);
          try {
            if (isZeroStock) {
              const { endFixedPriceItem } = require('../lib/ebay-trading-api');
              await endFixedPriceItem(sibId, { reason: 'NotAvailable' });
              endedSiblingIds.push(sibId);
              results.push({ channel: 'ebay', status: 'success', itemId: sibId, quantityPushed: 0, zeroStock: true, action: 'ended_sibling_site' });
              await doc.ref.set({ active: false, endedDetectedAt: new Date().toISOString(), endedReason: 'zero_stock_fanout' }, { merge: true }).catch(() => {});
              console.log(`[stock-sync] ebay END sibling product=${productId} itemId=${sibId} (zero stock, Multi-Site)`);
            } else {
              const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
              const r = await reviseFixedPriceItem({ itemId: sibId, quantity: availableQuantity });
              const st = r?.ack === 'Success' || r?.ack === 'Warning' ? 'success' : 'failed';
              results.push({ channel: 'ebay', status: st, itemId: sibId, quantityPushed: availableQuantity, action: 'revise_sibling_site' });
            }
          } catch (sibErr) {
            const msg = sibErr?.message || String(sibErr);
            if (isEndedListing(msg) || isForeignOrRemovedListing(msg)) {
              // Geschwister-Listing tot/fremd → nur DESSEN Mirror-Row
              // deaktivieren (kein Drain-Doc, kein Retry) — der Light-Sync
              // re-aktiviert es, falls es doch lebt.
              await doc.ref.set({ active: false, endedDetectedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
              results.push({ channel: 'ebay', status: 'skipped', itemId: sibId, error: 'sibling_ended_or_foreign', quantityPushed: 0 });
            } else if (isRateLimited(msg)) {
              results.push({ channel: 'ebay', status: 'failed', itemId: sibId, error: msg, retryable: true, action: 'sibling_rate_limited' });
            } else {
              // Punkt 14: nie destruktiv auf Fehler reagieren — retryable in
              // den Drain, der den kompletten Sync (inkl. Fan-Out) wiederholt.
              results.push({ channel: 'ebay', status: 'failed', itemId: sibId, error: msg, retryable: true, action: 'sibling_revise_failed' });
              console.warn(`[stock-sync] ebay sibling FAILED product=${productId} itemId=${sibId}: ${msg.slice(0, 140)}`);
            }
          }
        }
      }

      // Beendete Geschwister im Selbstheilungs-Marker festhalten. Drei Fälle:
      // (a) Marker wurde in diesem Lauf durchs getrackte End geschrieben →
      //     siblingItemIds ergänzen. (b) Marker existierte schon vorher →
      //     Liste mergen. (c) KEIN Marker (kein getracktes End gelaufen, aber
      //     Geschwister beendet) → Marker mit erstem Geschwister als Anker
      //     anlegen, Rest als siblings — sonst wären sie unheilbar verwaist.
      if (isZeroStock && endedSiblingIds.length) {
        const prior = freshProduct?.ops?.ebay?.zeroStockEnd || null;
        const trackedEndedThisRun = results.some((r) => r.channel === 'ebay' && r.action === 'ended');
        const priorSiblings = Array.isArray(prior?.siblingItemIds) ? prior.siblingItemIds.map(String) : [];
        if (trackedEndedThisRun || prior?.itemId) {
          const merged = [...new Set([...priorSiblings, ...endedSiblingIds])];
          await firestore.collection('products_v2').doc(productId)
            .update({ 'ops.ebay.zeroStockEnd.siblingItemIds': merged })
            .catch(() => {});
        } else {
          const [anchor, ...rest] = endedSiblingIds;
          await writeZeroStockEndMarker({ productId, itemId: anchor, reason });
          if (rest.length) {
            await firestore.collection('products_v2').doc(productId)
              .update({ 'ops.ebay.zeroStockEnd.siblingItemIds': rest })
              .catch(() => {});
          }
        }
      }
    } catch (fanoutErr) {
      console.warn(`[stock-sync] ebay Multi-Site-Fan-Out failed for product=${productId}: ${fanoutErr?.message}`);
    }
  }

  // --- Kaufland ---
  // Primary: unitId stored in product ops. Fallback: look up from kauflandUnitsLive
  // by SKU or EAN. This handles products that were listed on Kaufland before
  // ops.kaufland.unitId was written (majority of historical products).
  let kauflandUnitId = freshProduct?.ops?.kaufland?.unitId
    || freshProduct?.ops?.kaufland?.id_unit
    || freshProduct?.marketplace?.kaufland?.unitId;

  if (!kauflandUnitId && channelAllowed('kaufland')) {
    try {
      const sku = String(freshProduct?.identification?.sku || freshProduct?.details?.identifiers?.sku || '').trim();
      const ean = String(freshProduct?.identification?.ean || freshProduct?.details?.identifiers?.ean || '').trim();
      let unitSnap = null;
      if (sku) {
        unitSnap = await firestore.collection('kauflandUnitsLive')
          .where('id_offer', '==', sku)
          .where('active', '==', true)
          .limit(1)
          .get();
      }
      if ((!unitSnap || unitSnap.empty) && ean) {
        unitSnap = await firestore.collection('kauflandUnitsLive')
          .where('ean', '==', ean)
          .where('active', '==', true)
          .limit(1)
          .get();
      }
      if (unitSnap && !unitSnap.empty) {
        kauflandUnitId = unitSnap.docs[0].id;
        console.log(`[stock-sync] kaufland unitId resolved via lookup: ${kauflandUnitId} (sku=${sku})`);
        // Write back to product so future syncs don't need the lookup
        firestore.collection('products_v2').doc(productId)
          .update({ 'ops.kaufland.unitId': kauflandUnitId })
          .catch(() => {});
      }
    } catch (err) {
      console.warn(`[stock-sync] kaufland unitId lookup failed for product=${productId}: ${err.message}`);
    }
  }

  if (kauflandUnitId && channelAllowed('kaufland')) {
    if (isZeroStock) {
      // Zero stock: explicitly set ONHOLD first — bypasses price validation in updateUnit()
      // This guarantees the listing is deactivated even if price/SKU data is missing.
      try {
        const { setUnitStatus } = require('../lib/kaufland-api');
        await setUnitStatus(kauflandUnitId, 'ONHOLD', { storefront: 'de' });
        results.push({
          channel: 'kaufland',
          status: 'success',
          unitId: kauflandUnitId,
          quantityPushed: 0,
          zeroStock: true,
          action: 'onhold',
        });
        console.log(
          `[stock-sync] kaufland ONHOLD product=${productId} unitId=${kauflandUnitId} → status=ONHOLD`
        );
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (isUnitNotFound(errMsg)) {
          // Unit is gone on Kaufland — retire it (clear product + deactivate mirror
          // so the resolver stops re-pulling the dead unit) and record a
          // non-retryable skip, NOT an error: no drain retry, no activity-feed noise.
          await retireKauflandUnit({ productId, unitId: kauflandUnitId });
          results.push({ channel: 'kaufland', status: 'skipped', unitId: kauflandUnitId, action: 'unit_retired', error: 'unit_not_found' });
          console.warn(`[stock-sync] kaufland ONHOLD product=${productId} unitId=${kauflandUnitId}: Unit Not Found → retired (no retry)`);
        } else {
          results.push({ channel: 'kaufland', status: 'error', error: errMsg, action: 'onhold' });
          console.warn(
            `[stock-sync] kaufland ONHOLD FAILED product=${productId} unitId=${kauflandUnitId}:`,
            errMsg
          );
        }
      }
    } else {
      // Stock > 0: full update (price + qty + sets status=AVAILABLE automatically)
      // If update fails, fail-safe set ONHOLD to avoid oversell.
      try {
        const { updateUnit } = require('../lib/kaufland-api');
        const productWithAvailable = {
          ...freshProduct,
          inventory: {
            ...(freshProduct.inventory || {}),
            availableQuantity,
          },
        };
        const result = await updateUnit(kauflandUnitId, productWithAvailable, { storefront: 'de' });
        results.push({
          channel: 'kaufland',
          status: result?.updated ? 'success' : 'failed',
          unitId: kauflandUnitId,
          quantityPushed: availableQuantity,
          zeroStock: false,
        });
        console.log(
          `[stock-sync] kaufland product=${productId} unitId=${kauflandUnitId} qty=${availableQuantity} status=success`
        );
      } catch (err) {
        const errMsg = err?.message || String(err);
        try {
          const { setUnitStatus } = require('../lib/kaufland-api');
          await setUnitStatus(kauflandUnitId, 'ONHOLD', { storefront: 'de' });
          // WICHTIG: Das ONHOLD ist nur die Oversell-Sicherung, NICHT der Erfolg.
          // Der eigentliche updateUnit-Fehler MUSS als 'failed' in den Drain
          // (stock_operation_failures), sonst bleibt ein lagerndes Produkt nach
          // einem transienten Kaufland-Fehler unbegrenzt ONHOLD/unverkäuflich —
          // dasselbe Fake-Success-Muster wie im eBay-Incident 2026-06-16.
          results.push({
            channel: 'kaufland',
            status: 'failed',
            unitId: kauflandUnitId,
            quantityPushed: 0,
            action: 'fail_safe_onhold',
            note: 'quantity_update_failed_unit_onhold',
            error: errMsg,
            retryable: true,
          });
          console.warn(
            `[stock-sync] kaufland FAIL-SAFE ONHOLD product=${productId} unitId=${kauflandUnitId} after update failure (queued for drain retry): ${errMsg}`
          );
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr?.message || String(fallbackErr);
          if (isUnitNotFound(errMsg) || isUnitNotFound(fallbackMsg)) {
            // Unit is gone on Kaufland — retire it and skip (non-retryable): clear
            // the product unitId AND deactivate the mirror entry so the resolver
            // stops re-pulling the dead unit. No drain retry, no activity-feed noise.
            await retireKauflandUnit({ productId, unitId: kauflandUnitId });
            results.push({ channel: 'kaufland', status: 'skipped', unitId: kauflandUnitId, action: 'unit_retired', error: 'unit_not_found' });
            console.warn(`[stock-sync] kaufland product=${productId} unitId=${kauflandUnitId}: Unit Not Found → retired (no retry)`);
          } else {
            results.push({ channel: 'kaufland', status: 'error', error: `${errMsg}; fail_safe_onhold_failed: ${fallbackMsg}` });
            console.warn(
              `[stock-sync] kaufland FAILED product=${productId} unitId=${kauflandUnitId}; fail-safe ONHOLD failed:`,
              fallbackMsg
            );
          }
        }
      }
    }
  }

  // Log sync attempt to Firestore for audit trail
  try {
    await firestore.collection(SYNC_LOG_COLLECTION).add({
      tenantId,
      productId,
      reason,
      quantity,
      reservedQty,
      availableQuantity,
      zeroStock: isZeroStock,
      results,
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[stock-sync] log write failed:', logErr?.message);
  }

  return { results };
  }); // withStockLock
}

/**
 * Sync price to all connected marketplace channels for a product.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Object} params.product
 * @param {Object} params.prices - { ebay?: number, kaufland?: number }
 * @returns {Object} { results }
 */
async function syncPriceToAllChannels({ tenantId = 'default', product, prices = {} }) {
  if (!product?.id) {
    return { results: [{ channel: 'all', status: 'skipped', error: 'no product id' }] };
  }

  const productId = String(product.id);
  const results = [];

  // --- eBay Price ---
  const ebayItemId = product?.ops?.ebay?.itemId
    || product?.ops?.ebay?.item_id
    || product?.marketplace?.ebay?.itemId;
  const ebayPrice = prices.ebay ?? product?.pricing?.ebay?.price ?? product?.details?.pricing?.sellPrice ?? product?.pricing?.sellPrice;

  if (ebayItemId && Number.isFinite(ebayPrice) && ebayPrice > 0) {
    // WP2 / F0.X: never push a Sofortkaufpreis at or below the Best-Offer
    // auto-decline threshold — that revise would jam the listing un-changeably.
    let guardBlocked = false;
    if (bestOfferGuardEnabled()) {
      const threshold = await readEbayAutoDeclineThreshold(ebayItemId);
      const guard = guardListingPrice({ newPrice: ebayPrice, autoDeclineThreshold: threshold });
      if (!guard.safe) {
        guardBlocked = true;
        results.push({
          channel: 'ebay',
          status: 'skipped',
          reason: 'best-offer-guard',
          attemptedPrice: ebayPrice,
          autoDeclineThreshold: threshold,
          minSafePrice: guard.minSafePrice,
        });
        console.warn(`[price-sync] ebay BLOCKED by best-offer-guard product=${productId}: price ${ebayPrice} <= auto-decline ${threshold} (minSafe ${guard.minSafePrice})`);
      }
    }

    if (!guardBlocked) {
      try {
        const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
        const result = await reviseFixedPriceItem({
          itemId: String(ebayItemId),
          startPrice: ebayPrice,
          currency: 'EUR',
        });
        const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
        results.push({ channel: 'ebay', status, pricePushed: ebayPrice });
        console.log(`[price-sync] ebay product=${productId} price=${ebayPrice} status=${status}`);
      } catch (err) {
        results.push({ channel: 'ebay', status: 'error', error: err?.message });
        console.warn(`[price-sync] ebay FAILED product=${productId}:`, err?.message || err);
      }
    }
  }

  // --- Kaufland Price ---
  const kauflandUnitId = product?.ops?.kaufland?.unitId
    || product?.ops?.kaufland?.id_unit
    || product?.marketplace?.kaufland?.unitId;
  const kauflandPrice = prices.kaufland ?? product?.pricing?.kaufland?.price ?? product?.details?.pricing?.sellPrice ?? product?.pricing?.sellPrice;

  if (kauflandUnitId && Number.isFinite(kauflandPrice) && kauflandPrice > 0) {
    try {
      const { updateUnit } = require('../lib/kaufland-api');
      const productWithPrice = {
        ...product,
        pricing: {
          ...(product.pricing || {}),
          sellPrice: kauflandPrice,
        },
      };
      const result = await updateUnit(kauflandUnitId, productWithPrice, { storefront: 'de' });
      results.push({ channel: 'kaufland', status: result?.updated ? 'success' : 'failed', pricePushed: kauflandPrice });
      console.log(`[price-sync] kaufland product=${productId} price=${kauflandPrice} status=success`);
    } catch (err) {
      results.push({ channel: 'kaufland', status: 'error', error: err?.message });
      console.warn(`[price-sync] kaufland FAILED product=${productId}:`, err?.message || err);
    }
  }

  // Log
  try {
    await firestore.collection(SYNC_LOG_COLLECTION).add({
      tenantId,
      productId,
      reason: 'price-sync',
      prices,
      results,
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[price-sync] log write failed:', logErr?.message);
  }

  return { results };
}

/**
 * Sync stock with automatic retry on failure.
 * Retries once after 30s for channels that failed on first attempt.
 */
async function syncStockWithRetry({
  tenantId = 'default',
  product,
  reason = 'manual',
  skipPersistentFailureQueue = false,
  onlyChannels = null,
}) {
  const first = await syncStockToAllChannels({ tenantId, product, reason, onlyChannels });
  const isFailedStatus = (s) => s === 'error' || s === 'failed';
  const failedChannels = first.results.filter((r) => isFailedStatus(r?.status));
  if (failedChannels.length === 0) return first;

  // If EVERY failure is a marketplace rate-limit (quota), an immediate 30s retry
  // is futile — it burns another quota-blocked call and piles Firestore
  // stock-lock contention (the 2026-06-12 sync-storm root cause). Hand straight
  // to the durable drain instead of hammering in-process.
  const isDrainRetry = String(reason || '').startsWith('drain:');
  const allRateLimited = failedChannels.length > 0 && failedChannels.every((r) => isRateLimited(r?.error));
  if (allRateLimited) {
    console.warn(`[stock-sync] ${failedChannels.length} channel(s) rate-limited for product=${product?.id}; deferring to drain (no immediate retry)`);
    if (!skipPersistentFailureQueue && !isDrainRetry) {
      await persistSyncFailureForDrain({ tenantId, product, reason, failedChannels }).catch(() => {});
    }
    return first;
  }

  // WP1 Task 4: durable path — no in-process setTimeout retry. Persist
  // synchronously to the drain queue (with classification + nextRetryAt) and
  // let the backoff-aware drain own the retry. Removes the fire-and-forget
  // setTimeout that could be lost on instance shutdown.
  if (durableDrainEnabled()) {
    if (!skipPersistentFailureQueue && !isDrainRetry) {
      await persistSyncFailureForDrain({ tenantId, product, reason, failedChannels }).catch(() => {});
    }
    console.log(`[stock-sync] ${failedChannels.length} channel(s) failed for product=${product?.id}; durable-drain ON → persisted for drain (no in-process retry)`);
    return first;
  }

  // Legacy path (flag OFF): schedule retry after 30s for failed channels.
  console.log(`[stock-sync] ${failedChannels.length} channel(s) failed, scheduling retry in 30s`);
  setTimeout(async () => {
    try {
      const retry = await syncStockToAllChannels({ tenantId, product, reason: `${reason}-retry` });
      const stillFailed = retry.results.filter((r) => isFailedStatus(r?.status));
      if (stillFailed.length > 0) {
        if (!skipPersistentFailureQueue && !isDrainRetry) {
          // Persist persistent failures for both monitoring and durable drain retries.
          await persistSyncFailureForDrain({ tenantId, product, reason, failedChannels: stillFailed });
        }
        console.warn(`[stock-sync] Retry still failed for product=${product?.id}: ${stillFailed.map((r) => `${r.channel}:${r.error}`).join(', ')}`);
      } else {
        console.log(`[stock-sync] Retry succeeded for product=${product?.id}`);
      }
    } catch (err) {
      console.error(`[stock-sync] Retry error for product=${product?.id}: ${err.message}`);
    }
  }, 30000);

  return first;
}

/**
 * Sync stock to all channels for all products in an order.
 * Reads product docs from order items' SKUs, then pushes stock to marketplaces.
 */
async function syncStockForOrderItems({ tenantId = 'default', orderId, reason = 'order' }) {
  try {
    // Read order to get items
    const orderDoc = await firestore.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return;
    const order = { id: orderDoc.id, ...orderDoc.data() };
    const items = order.items || [];
    if (items.length === 0) return;

    // Collect unique SKUs from order items
    const skus = [...new Set(items.map((i) => String(i.sku || '').trim()).filter(Boolean))];
    if (skus.length === 0) return;

    // Query products by SKU (in chunks of 10) — search both SKU fields
    for (let i = 0; i < skus.length; i += 10) {
      const chunk = skus.slice(i, i + 10);
      const products = await findProductsBySkuChunk(chunk);
      for (const product of products) {
        syncStockWithRetry({ tenantId, product, reason: `${reason}-${orderId}` })
          .catch((err) => console.warn(`[stock-sync] order item sync failed: ${err.message}`));
      }
    }
  } catch (err) {
    console.warn(`[stock-sync] syncStockForOrderItems failed for ${orderId}: ${err.message}`);
  }
}

module.exports = {
  syncStockToAllChannels,
  syncStockWithRetry,
  syncStockForOrderItems,
  syncPriceToAllChannels,
  findProductsBySkuChunk,
  computeAvailableQuantity,
  pickActiveListing,
  isRateLimited,
  writeZeroStockEndMarker,
  relistEndedEbayListing,
};
