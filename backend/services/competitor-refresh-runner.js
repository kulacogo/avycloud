/**
 * Competitor Refresh Runner
 *
 * Periodischer Runner der Konkurrenzpreise für alle Produkte mit EAN holt
 * und in details.pricing.competitorPrices[] in Firestore speichert.
 *
 * Gespeicherte Daten werden von:
 *   - Pricing Engine Tier 1 (_tier1EanMatch) genutzt
 *   - CompetitorPrices Frontend-Komponente sofort angezeigt (kein API-Call beim Laden)
 *
 * Feature-Flag: COMPETITOR_REFRESH_ENABLED=true (default: false)
 * Intervall: COMPETITOR_REFRESH_INTERVAL_MS (default: 72 Stunden)
 * Staleness: COMPETITOR_REFRESH_STALE_MS (default: 72 Stunden — skip wenn frischer)
 * Throttle: COMPETITOR_REFRESH_DELAY_MS zwischen Produkten (default: 2000ms)
 */
const { firestore } = require('../lib/firestore');
const { getCollection } = require('../lib/product-store');
const { getCompetitorPrices } = require('../lib/competitor-prices');
const { storeCompetitorPricesToProduct } = require('../lib/competitor-prices');

const ENABLED = process.env.COMPETITOR_REFRESH_ENABLED === 'true';
const INTERVAL_MS = parseInt(process.env.COMPETITOR_REFRESH_INTERVAL_MS || String(72 * 60 * 60 * 1000), 10);
const INITIAL_DELAY_MS = parseInt(process.env.COMPETITOR_REFRESH_INITIAL_DELAY_MS || String(15 * 60 * 1000), 10);
const STALE_MS = parseInt(process.env.COMPETITOR_REFRESH_STALE_MS || String(72 * 60 * 60 * 1000), 10);
const DELAY_BETWEEN_MS = parseInt(process.env.COMPETITOR_REFRESH_DELAY_MS || '2000', 10);

let runnerTimer = null;
let runInFlight = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeEan(value) {
  return value == null ? '' : String(value).replace(/\D+/g, '');
}

// ─── Cycle ────────────────────────────────────────────────────────────────────

async function runCompetitorRefreshCycle() {
  if (runInFlight) {
    console.log('[CompetitorRefreshRunner] Run already in flight, skipping.');
    return;
  }
  runInFlight = true;
  console.log('[CompetitorRefreshRunner] Starting competitor refresh cycle...');

  let processed = 0, updated = 0, skipped = 0, errors = 0;

  try {
    const collection = getCollection();
    const snap = await firestore.collection(collection).get();

    const now = Date.now();
    const cutoff = now - STALE_MS;

    for (const doc of snap.docs) {
      const data = doc.data();

      // Resolve EAN from multiple possible locations
      const ean = normalizeEan(
        data?.details?.identifiers?.ean
        || data?.identification?.barcodes?.[0]
        || data?.details?.identifiers?.gtin
        || ''
      );

      if (!ean || ean.length < 8) continue;

      // Skip if data is still fresh
      const lastCheck = data?.details?.pricing?.lastPriceCheck;
      if (lastCheck && new Date(lastCheck).getTime() > cutoff) {
        skipped++;
        continue;
      }

      processed++;
      try {
        const result = await getCompetitorPrices(ean);
        const totalListings = (result.ebay?.length || 0) + (result.kaufland?.length || 0);

        if (totalListings > 0) {
          await storeCompetitorPricesToProduct(doc.id, collection, result);
          updated++;
        } else {
          // Still update lastPriceCheck so we don't re-query soon
          await firestore.collection(collection).doc(doc.id).set(
            { details: { pricing: { lastPriceCheck: result.fetched_at } } },
            { merge: true }
          );
        }

        // Throttle to avoid hammering eBay/Kaufland APIs
        await sleep(DELAY_BETWEEN_MS);
      } catch (err) {
        console.warn(`[CompetitorRefreshRunner] Failed for ${doc.id}: ${err.message}`);
        errors++;
      }
    }

    console.log(
      `[CompetitorRefreshRunner] Cycle complete: processed=${processed}, updated=${updated}, skipped=${skipped}, errors=${errors}`
    );
  } catch (err) {
    console.error('[CompetitorRefreshRunner] Cycle failed:', err.message);
  } finally {
    runInFlight = false;
  }
}

function startCompetitorRefreshRunner() {
  if (!ENABLED) {
    console.log('[CompetitorRefreshRunner] Disabled. Set COMPETITOR_REFRESH_ENABLED=true to enable.');
    return;
  }
  console.log(
    `[CompetitorRefreshRunner] Starting — interval: ${INTERVAL_MS}ms, stale threshold: ${STALE_MS}ms, initial delay: ${INITIAL_DELAY_MS}ms`
  );
  setTimeout(() => runCompetitorRefreshCycle(), INITIAL_DELAY_MS);
  runnerTimer = setInterval(() => runCompetitorRefreshCycle(), INTERVAL_MS);
}

function stopCompetitorRefreshRunner() {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
}

module.exports = { startCompetitorRefreshRunner, stopCompetitorRefreshRunner };
