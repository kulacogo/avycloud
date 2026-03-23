'use strict';

/**
 * FIX Script: Bereinigt storage/storageBins auf Produkt-Dokumenten die
 * vom clear-zone-x-bins.js Script NICHT erreicht wurden.
 *
 * Problem: clear-zone-x-bins.js hat nur in `products` Collection gesucht.
 * Viele Produkt-IDs in den BIN-Einträgen zeigen aber auf `products_v2`.
 * Außerdem haben manche Produkte in `products` noch alte storage-Felder
 * die auf Zone-X BINs verweisen — obwohl die BINs schon leer sind.
 *
 * Dieser Fix:
 * 1. Findet ALLE Produkte in `products` UND `products_v2` deren
 *    storage.binCode mit "X" beginnt (Zone X)
 * 2. Setzt storage auf null und filtert storageBins
 * 3. inventory.quantity bleibt ERHALTEN
 *
 * Usage: node backend/scripts/fix-zone-x-product-storage.js
 */

const { Firestore } = require('@google-cloud/firestore');

const ZONE_PREFIX = 'X';

async function clearZoneXStorageInCollection(db, collectionName) {
  const collection = db.collection(collectionName);
  const snapshot = await collection.get();

  let checked = 0;
  let cleared = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    checked++;

    const storage = data.storage || null;
    const storageBins = Array.isArray(data.storageBins) ? data.storageBins : [];

    // Prüfe ob storage auf Zone X zeigt
    const storageIsZoneX = storage?.binCode && String(storage.binCode).startsWith(ZONE_PREFIX);
    const storageZoneField = storage?.zone === ZONE_PREFIX || storage?.zone === 'X';

    // Prüfe ob storageBins Zone-X Einträge hat
    const hasZoneXBins = storageBins.some(
      b => String(b.code || '').startsWith(ZONE_PREFIX) || b.zone === ZONE_PREFIX
    );

    if (!storageIsZoneX && !storageZoneField && !hasZoneXBins) continue;

    try {
      // storageBins: Zone-X Einträge entfernen
      const cleanedBins = storageBins.filter(
        b => !String(b.code || '').startsWith(ZONE_PREFIX) && b.zone !== ZONE_PREFIX
      );

      // storage: null setzen wenn es Zone X war, sonst aus verbleibenden Bins wählen
      let newStorage = null;
      if (storageIsZoneX || storageZoneField) {
        if (cleanedBins.length > 0) {
          const best = [...cleanedBins].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
          newStorage = {
            binCode: best.code,
            zone: best.zone || null,
            etage: best.etage || null,
            gang: best.gang || null,
            regal: best.regal || null,
            ebene: best.ebene || null,
            quantity: best.quantity || 0,
            assigned_at: best.firstStoredAt || new Date().toISOString(),
          };
        }
      } else {
        newStorage = storage;
      }

      await doc.ref.update({
        storage: newStorage,
        storageBins: cleanedBins,
      });

      const productName = data.identification?.name || data.details?.short_description || doc.id;
      const sku = data.identification?.sku || data.details?.identifiers?.sku || '?';
      console.log(`  ✅ [${collectionName}] ${sku} (${productName.slice(0, 50)}) → Zone-X storage entfernt`);
      cleared++;
    } catch (err) {
      console.error(`  ❌ [${collectionName}] ${doc.id}: ${err.message}`);
      errors++;
    }
  }

  return { checked, cleared, errors };
}

async function main() {
  const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });

  console.log('\n🔧 Fix: Entferne verwaiste Zone-X storage-Referenzen aus Produkt-Dokumenten...\n');

  // products Collection
  console.log('=== products Collection ===');
  const r1 = await clearZoneXStorageInCollection(db, 'products');

  // products_v2 Collection
  console.log('\n=== products_v2 Collection ===');
  const r2 = await clearZoneXStorageInCollection(db, 'products_v2');

  console.log(`\n${'═'.repeat(60)}`);
  console.log('Zusammenfassung:');
  console.log(`  products:    ${r1.checked} geprüft, ${r1.cleared} bereinigt, ${r1.errors} Fehler`);
  console.log(`  products_v2: ${r2.checked} geprüft, ${r2.cleared} bereinigt, ${r2.errors} Fehler`);
  console.log(`  Gesamt:      ${r1.cleared + r2.cleared} Produkte bereinigt`);
  console.log(`${'═'.repeat(60)}\n`);

  if (r1.errors + r2.errors > 0) {
    console.log('⚠️  Es gab Fehler — bitte Output prüfen.');
    process.exit(1);
  }

  console.log('✅ Fertig. Inventar-Ansicht sollte jetzt keine Zone-X BINs mehr anzeigen.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
