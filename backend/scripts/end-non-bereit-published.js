'use strict';
/**
 * end-non-bereit-published.js — Korrektur des Policy-Verstoßes vom 2026-07-20:
 * das Repair-Script publizierte 63 Produkte mit Status "In Bearbeitung"
 * (ops.readiness != 'ready'). Haus-Policy: nur Bereit-Produkte werden gelistet.
 *
 * Kandidaten-Ableitung OHNE Report-Datei (die /tmp-Datei überlebte den
 * Neustart nicht): alle Mirror-Listings mit startTime im Publish-Fenster
 * 2026-07-20T12:00–13:30Z — das sind exakt die 64 von uns publizierten
 * (Forensik: einziger Publish-Burst dieses Fensters; Internationalisierung
 * war 19.07., Alt-Listings früher).
 *
 * Guards pro Listing:
 *   - Produkt INZWISCHEN auf Bereit gesetzt → bleibt gelistet
 *   - GetItem-Verify: nur Status Active UND QuantitySold == 0
 *     (Verkäufe → NIE automatisch anfassen, Meldeliste)
 *   - Ende-Grund 'OtherListingError'; ops.ebay bereinigt, Mirror inaktiv,
 *     KEIN zeroStockEnd-Marker (Selbstheilung darf NICHT relisten)
 *
 * Dry-run default; Mutationen nur mit --apply.
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const APPLY = process.argv.includes('--apply');
const WINDOW_START = '2026-07-20T12:00:00';
const WINDOW_END = '2026-07-20T13:30:00';

function toIso(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.toDate) return v.toDate().toISOString();
  return String(v);
}

async function main() {
  console.log(`[end-non-bereit] Modus: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const snap = await db.collection('ebayListingsLive').get();
  const candidates = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const start = toIso(d.startTime);
    if (start >= WINDOW_START && start <= WINDOW_END) {
      candidates.push({ itemId: String(d.itemId || doc.id), sku: String(d.sku || ''), active: d.active, ref: doc.ref });
    }
  }
  console.log(`[end-non-bereit] ${candidates.length} Listings im Publish-Fenster 20.07. 12:00–13:30Z gefunden`);

  const { getItemDetails, endFixedPriceItem } = require('../lib/ebay-trading-api');
  const out = { ended: [], keptNowReady: [], keptSold: [], keptNotActive: [], errors: [] };

  for (const c of candidates) {
    try {
      let psnap = await db.collection('products_v2').where('identification.sku', '==', c.sku).limit(1).get();
      if (psnap.empty) psnap = await db.collection('products_v2').where('details.identifiers.sku', '==', c.sku).limit(1).get();
      const pdoc = psnap.empty ? null : psnap.docs[0];
      const readiness = String(pdoc?.data()?.ops?.readiness || 'pending').toLowerCase();
      if (readiness === 'ready') {
        out.keptNowReady.push({ sku: c.sku, itemId: c.itemId });
        console.log(`↷ [${c.sku}] inzwischen Bereit — Listing bleibt`);
        continue;
      }

      const detail = await getItemDetails(c.itemId);
      const status = String(detail?.item?.listingStatus || '').toLowerCase();
      const sold = Number(detail?.item?.quantitySold ?? detail?.item?.soldQuantity ?? 0);
      if (status !== 'active') {
        out.keptNotActive.push({ sku: c.sku, itemId: c.itemId, status });
        continue;
      }
      if (sold > 0) {
        out.keptSold.push({ sku: c.sku, itemId: c.itemId, sold });
        console.warn(`⚠ [${c.sku}] ${c.itemId} hat ${sold} Verkauf(e) — NICHT beendet, bitte manuell entscheiden`);
        continue;
      }

      console.log(`✂ [${c.sku}] ${c.itemId} beenden (Status: ${readiness})${APPLY ? '' : ' (dry)'}`);
      if (APPLY) {
        await endFixedPriceItem(c.itemId, { reason: 'OtherListingError' });
        if (pdoc) {
          await pdoc.ref.update({
            'ops.ebay.itemId': null,
            'ops.ebay.itemIdCleared': new Date().toISOString(),
            'ops.ebay.itemIdClearReason': 'ended_non_bereit_policy',
            'listingStatus.ebay': 'inactive',
          }).catch(() => {});
        }
        await c.ref.set(
          { active: false, endedDetectedAt: new Date().toISOString(), endedReason: 'non_bereit_policy' },
          { merge: true }
        );
        await new Promise((r) => setTimeout(r, 400));
      }
      out.ended.push({ sku: c.sku, itemId: c.itemId });
    } catch (err) {
      out.errors.push({ sku: c.sku, itemId: c.itemId, error: String(err.message).slice(0, 150) });
      console.error(`✖ [${c.sku}] ${err.message}`);
    }
  }

  console.log(`\n════ ERGEBNIS ════`);
  console.log(`beendet: ${out.ended.length} | inzwischen Bereit (bleiben): ${out.keptNowReady.length} | mit Verkäufen (manuell): ${out.keptSold.length} | nicht mehr aktiv: ${out.keptNotActive.length} | Fehler: ${out.errors.length}`);
  require('fs').writeFileSync(`/tmp/end-non-bereit-${APPLY ? 'apply' : 'dry'}.json`, JSON.stringify(out, null, 2));
  if (!APPLY) console.log('DRY-RUN — nichts geändert. Mit --apply ausführen.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
