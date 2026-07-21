'use strict';
/**
 * end-non-bereit-published.js — Korrektur des Policy-Verstoßes vom 2026-07-20:
 * das Repair-Script publizierte 63 Produkte mit Status "In Bearbeitung"
 * (ops.readiness != 'ready'). Haus-Policy: nur Bereit-Produkte werden gelistet.
 *
 * Beendet GENAU die gestern von uns publizierten Nicht-Bereit-Listings:
 *   - Quelle: der Publish-Report vom 20.07. (published[] mit sku+itemId)
 *   - Skip wenn das Produkt INZWISCHEN auf Bereit gesetzt wurde
 *   - GetItem-Verify: nur aktive Listings mit QuantitySold == 0
 *     (verkaufte → Report, niemals automatisch anfassen)
 *   - Ende-Grund 'OtherListingError'; ops.ebay bereinigt, Mirror inaktiv,
 *     KEIN zeroStockEnd-Marker (die Selbstheilung darf NICHT relisten)
 *
 * Dry-run default; Mutationen nur mit --apply.
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const APPLY = process.argv.includes('--apply');
const REPORT = '/tmp/repair-ended-listings-apply-2026-07-20T122233.json';
const READY_SKU_EXCEPTION = 'SKU-9014992269'; // war Bereit — bleibt gelistet

async function main() {
  console.log(`[end-non-bereit] Modus: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const report = JSON.parse(require('fs').readFileSync(REPORT, 'utf8'));
  const published = (report.published || []).filter((p) => p.sku !== READY_SKU_EXCEPTION);
  console.log(`[end-non-bereit] ${published.length} Kandidaten aus Publish-Report 20.07.`);

  const { getItemDetails, endFixedPriceItem } = require('../lib/ebay-trading-api');
  const out = { ended: [], keptNowReady: [], keptSold: [], keptNotActive: [], errors: [] };

  for (const { sku, itemId } of published) {
    try {
      // Produkt + aktueller Status
      let snap = await db.collection('products_v2').where('identification.sku', '==', sku).limit(1).get();
      if (snap.empty) snap = await db.collection('products_v2').where('details.identifiers.sku', '==', sku).limit(1).get();
      const doc = snap.empty ? null : snap.docs[0];
      const readiness = String(doc?.data()?.ops?.readiness || 'pending').toLowerCase();
      if (readiness === 'ready') {
        out.keptNowReady.push({ sku, itemId });
        console.log(`↷ [${sku}] inzwischen Bereit — Listing bleibt`);
        continue;
      }

      // Live-Verify
      const detail = await getItemDetails(itemId);
      const status = String(detail?.item?.listingStatus || '').toLowerCase();
      const sold = Number(detail?.item?.quantitySold ?? detail?.item?.soldQuantity ?? 0);
      if (status !== 'active') {
        out.keptNotActive.push({ sku, itemId, status });
        continue;
      }
      if (sold > 0) {
        out.keptSold.push({ sku, itemId, sold });
        console.warn(`⚠ [${sku}] ${itemId} hat ${sold} Verkauf(e) — NICHT beendet, bitte manuell entscheiden`);
        continue;
      }

      console.log(`✂ [${sku}] ${itemId} beenden (Status: ${readiness})${APPLY ? '' : ' (dry)'}`);
      if (APPLY) {
        await endFixedPriceItem(itemId, { reason: 'OtherListingError' });
        if (doc) {
          await doc.ref.update({
            'ops.ebay.itemId': null,
            'ops.ebay.itemIdCleared': new Date().toISOString(),
            'ops.ebay.itemIdClearReason': 'ended_non_bereit_policy',
            'listingStatus.ebay': 'inactive',
          });
        }
        await db.collection('ebayListingsLive').doc(String(itemId)).set(
          { active: false, endedDetectedAt: new Date().toISOString(), endedReason: 'non_bereit_policy' },
          { merge: true }
        );
        await new Promise((r) => setTimeout(r, 400));
      }
      out.ended.push({ sku, itemId });
    } catch (err) {
      out.errors.push({ sku, itemId, error: String(err.message).slice(0, 150) });
      console.error(`✖ [${sku}] ${err.message}`);
    }
  }

  console.log(`\n════ ERGEBNIS ════`);
  console.log(`beendet: ${out.ended.length} | inzwischen Bereit (bleiben): ${out.keptNowReady.length} | mit Verkäufen (manuell): ${out.keptSold.length} | nicht mehr aktiv: ${out.keptNotActive.length} | Fehler: ${out.errors.length}`);
  require('fs').writeFileSync(`/tmp/end-non-bereit-${APPLY ? 'apply' : 'dry'}.json`, JSON.stringify(out, null, 2));
  if (!APPLY) console.log('DRY-RUN — nichts geändert. Mit --apply ausführen.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
