'use strict';
/**
 * run-corrections-when-quota-free.js — wartet auf eBay-Quota-Reset (Mitternacht
 * PT = 09:00 Berlin), führt dann die beiden Korrekturen vom 2026-07-21 aus:
 *
 *   A) end-non-bereit-published --apply  (63 Policy-Verstoß-Listings beenden;
 *      pro Item abgesichert: skip wenn inzwischen Bereit / verkauft / inaktiv)
 *   B) ATE-Listing 800323719797: Revise mit neuem identify-only-Code →
 *      GetItem-Verify ItemCompatibilityList. Falls die Katalog-Adoption sticky
 *      ist UND das Listing 0 Verkäufe hat: End + Republish über den regulären
 *      Publish-Pfad (Produkt ist Bereit; K-Typen gehen dann als identify-only mit).
 *
 * Läuft im Vordergrund bis Quota frei ist (Probe alle 20 min via GetItem).
 */

const { execSync } = require('child_process');

const PROBE_ITEM = '800376552541'; // bekanntes Live-Listing (Markise)
const ATE_ITEM = '800323719797';
const ATE_SKU = 'SKU-4561422647';

async function probeOnce() {
  try {
    const { getItemDetails } = require('../lib/ebay-trading-api');
    await getItemDetails(PROBE_ITEM, { timeoutMs: 20000 });
    return true;
  } catch (err) {
    const msg = String(err?.message || '');
    if (/usage limit|quota/i.test(msg)) return false;
    return true;
  }
}

// Einzelne Calls rutschen auch bei erschöpfter Tages-Quota durch (beobachtet
// 2026-07-21: Probe ok, alle Folge-Calls limitiert) → ZWEI Erfolge im Abstand
// von 30 s nötig, bevor die Korrekturen starten.
async function quotaFree() {
  if (!(await probeOnce())) return false;
  await new Promise((r) => setTimeout(r, 30 * 1000));
  return probeOnce();
}

// eBay Trading-Tages-Quota resettet um Mitternacht Pacific Time = 09:00
// Europe/Berlin (Sommerzeit). Vorher gar nicht erst proben.
function msUntilQuotaReset() {
  const now = new Date();
  const berlinHour = Number(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(now));
  if (berlinHour >= 9 && berlinHour < 24) return 0; // Reset heute schon durch
  // Minuten bis 09:05 Berlin
  const berlinNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const target = new Date(berlinNow);
  target.setHours(9, 5, 0, 0);
  if (target <= berlinNow) target.setDate(target.getDate() + 1);
  return target.getTime() - berlinNow.getTime();
}

async function main() {
  const waitMs = msUntilQuotaReset();
  if (waitMs > 0) {
    console.log(`[corrections] Warte ${Math.round(waitMs / 60000)} min bis zum Quota-Reset (09:05 Berlin) …`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  console.log(`[corrections] Starte Proben (2× GetItem im 30-s-Abstand, alle 20 min) …`);
  for (;;) {
    if (await quotaFree()) break;
    console.log(`[corrections] ${new Date().toISOString()} Quota noch zu — nächste Probe in 20 min`);
    await new Promise((r) => setTimeout(r, 20 * 60 * 1000));
  }
  console.log(`[corrections] ${new Date().toISOString()} Quota FREI — starte Korrekturen`);

  // ── A) Nicht-Bereit-Listings beenden ──────────────────────────────────────
  console.log('\n═══ A) end-non-bereit-published --apply ═══');
  try {
    execSync('node scripts/end-non-bereit-published.js --apply', { cwd: __dirname + '/..', stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } catch (err) {
    console.error(`[corrections] end-non-bereit fehlgeschlagen: ${err.message}`);
  }

  // ── B) ATE K-Typ-Reparatur ────────────────────────────────────────────────
  console.log('\n═══ B) ATE-Listing K-Typ-Reparatur ═══');
  const { getItemDetails } = require('../lib/ebay-trading-api');
  const { bulkReviseListingsFromProducts, publishProduct } = require('../lib/ebay-direct');
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore();

  try {
    const rev = await bulkReviseListingsFromProducts({ itemIds: [ATE_ITEM], actor: 'ktype-repair-script' });
    console.log(`[corrections] Revise-Result: ${JSON.stringify(rev?.summary || rev).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 5000));

    const check = await getItemDetails(ATE_ITEM);
    const item = check?.item || {};
    const compat = item.itemCompatibilityList;
    const compatCount = Array.isArray(compat) ? compat.length : Number(item.itemCompatibilityCount || 0);
    const sold = Number(item.quantitySold ?? item.soldQuantity ?? 0);
    console.log(`[corrections] Verify: status=${item.listingStatus} compatCount=${compatCount} sold=${sold}`);

    if (compatCount > 0) {
      console.log('✔ Kompatibilität ist jetzt LIVE — Revise hat gereicht.');
    } else if (sold > 0) {
      console.warn('⚠ Adoption sticky, aber Listing hat Verkäufe — KEIN End/Republish, manuell entscheiden.');
    } else {
      console.log('↻ Adoption sticky → End + Republish über Publish-Pfad (identify-only) …');
      const { endFixedPriceItem } = require('../lib/ebay-trading-api');
      await endFixedPriceItem(ATE_ITEM, { reason: 'OtherListingError' });
      await db.collection('ebayListingsLive').doc(ATE_ITEM).set(
        { active: false, endedDetectedAt: new Date().toISOString(), endedReason: 'ktype_republish' },
        { merge: true }
      );
      // Produkt-Verweis lösen, damit publishProduct nicht "bereits gelistet" blockt
      let snap = await db.collection('products_v2').where('identification.sku', '==', ATE_SKU).limit(1).get();
      if (snap.empty) snap = await db.collection('products_v2').where('details.identifiers.sku', '==', ATE_SKU).limit(1).get();
      const doc = snap.docs[0];
      await doc.ref.update({ 'ops.ebay.itemId': null, 'ops.ebay.itemIdClearReason': 'ktype_republish' });
      await new Promise((r) => setTimeout(r, 3000));
      const pub = await publishProduct(doc.id, {}, { actor: 'ktype-repair-script' });
      if (pub?.ok) {
        console.log(`✔ Republished als ${pub.itemId || pub.listingId} — verifiziere Kompatibilität …`);
        await new Promise((r) => setTimeout(r, 8000));
        const check2 = await getItemDetails(String(pub.itemId || pub.listingId));
        const c2 = check2?.item?.itemCompatibilityList;
        const n2 = Array.isArray(c2) ? c2.length : Number(check2?.item?.itemCompatibilityCount || 0);
        console.log(`[corrections] Final: compatCount=${n2} ${n2 > 0 ? '✔ K-TYPEN LIVE' : '✖ IMMER NOCH LEER — eskalieren'}`);
      } else {
        console.error(`✖ Republish geblockt: ${(pub?.blockers || []).join(' | ')}`);
      }
    }
  } catch (err) {
    console.error(`[corrections] ATE-Reparatur-Fehler: ${err.message}`);
  }

  console.log('\n[corrections] FERTIG');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
