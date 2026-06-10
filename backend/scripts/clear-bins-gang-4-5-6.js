'use strict';

/**
 * OPS Script: Entfernt alle Produkt-BIN-Zuordnungen in Gang 4, 5, 6.
 * - BIN-Dokumente: products Array wird geleert, productCount auf 0
 * - Produkt-Dokumente (products Collection): storage → null, storageBins gefiltert
 * - inventory.quantity bleibt ERHALTEN (Umzug, nicht Entnahme)
 * - BIN-Strukturen bleiben bestehen
 *
 * Usage: node backend/scripts/clear-bins-gang-4-5-6.js
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { parseApplyArgs } = require('./_apply-guard');

const GANGS_TO_CLEAR = [4, 5, 6];

async function main() {
  const { apply } = parseApplyArgs();
  const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });
  const binsCollection = db.collection('warehouseBins');
  const productsCollection = db.collection('products');
  const eventsCollection = db.collection('warehouseEvents');

  console.log(`\n🔧 Entferne Produkt-Zuordnungen aus Gang ${GANGS_TO_CLEAR.join(', ')}...\n`);

  // 1. Alle BINs in Gang 4, 5, 6 laden
  const snap = await binsCollection.where('gang', 'in', GANGS_TO_CLEAR).get();
  console.log(`Gefunden: ${snap.size} BINs in Gang ${GANGS_TO_CLEAR.join(', ')}\n`);

  let totalProducts = 0;
  let binsWithProducts = 0;
  let cleared = 0;
  let errors = 0;

  for (const binDoc of snap.docs) {
    const data = binDoc.data();
    const products = Array.isArray(data.products) ? data.products : [];

    if (products.length === 0) continue;
    binsWithProducts++;
    totalProducts += products.length;

    const binCode = binDoc.id;
    const skus = products.map(p => p.sku || p.productId || '?');
    console.log(`BIN ${binCode} (Gang ${data.gang}): ${products.length} Produkte → ${skus.join(', ')}`);

    // 2. BIN-Dokument leeren
    try {
      if (!apply) {
        console.log(`  [DRY-RUN] would clear BIN ${binCode} and detach ${products.length} product(s)`);
      } else {
      await binDoc.ref.update({
        products: [],
        productCount: 0,
        lastStoredAt: Timestamp.now(),
      });

      // 3. Event schreiben
      await eventsCollection.add({
        type: 'bin_bulk_clear',
        binCode,
        gang: data.gang,
        zone: data.zone,
        etage: data.etage,
        removedProducts: products.length,
        removedSkus: skus,
        reason: 'Gang 4/5/6 Umzug — Neueinlagerung via Stow',
        createdAt: Timestamp.now(),
      });
      }

      // 4. Für jedes Produkt: storage + storageBins bereinigen (quantity bleibt!)
      for (const p of products) {
        const productId = p.productId;
        if (!productId) {
          console.warn(`  ⚠️  Produkt ohne productId in BIN ${binCode}, übersprungen`);
          continue;
        }

        try {
          const productRef = productsCollection.doc(productId);
          const productSnap = await productRef.get();

          if (!productSnap.exists) {
            console.warn(`  ⚠️  Produkt ${productId} nicht in products Collection`);
            continue;
          }

          const productData = productSnap.data();

          // storageBins: nur Einträge für diese BIN entfernen
          const currentBins = Array.isArray(productData.storageBins) ? productData.storageBins : [];
          const updatedBins = currentBins.filter(
            b => String(b.code || '').trim() !== String(binCode).trim()
          );

          // storage: auf null setzen wenn es diese BIN war
          const currentStorage = productData.storage || null;
          const shouldClearStorage = currentStorage?.binCode === binCode;

          // Neuen Primary wählen falls andere BINs übrig sind
          let newStorage = null;
          if (!shouldClearStorage) {
            newStorage = currentStorage;
          } else if (updatedBins.length > 0) {
            const best = updatedBins.sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
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

          if (apply) {
            await productRef.update({
              storage: newStorage,
              storageBins: updatedBins,
              // inventory.quantity bleibt UNVERÄNDERT
            });
            console.log(`  ✅ ${p.sku || productId} → BIN-Zuordnung entfernt`);
          } else {
            console.log(`  [DRY-RUN] ${p.sku || productId} → würde BIN-Zuordnung entfernen`);
          }
        } catch (err) {
          console.error(`  ❌ ${productId}: ${err.message}`);
          errors++;
        }
      }

      cleared++;
    } catch (err) {
      console.error(`❌ BIN ${binCode}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Zusammenfassung:`);
  console.log(`  BINs geprüft:        ${snap.size}`);
  console.log(`  BINs mit Produkten:   ${binsWithProducts}`);
  console.log(`  BINs geleert:         ${cleared}`);
  console.log(`  Produkt-Zuordnungen:  ${totalProducts} entfernt`);
  console.log(`  Fehler:               ${errors}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (errors > 0) {
    console.log('⚠️  Es gab Fehler — bitte Output prüfen.');
    process.exit(1);
  }

  console.log('✅ Fertig. Artikel erscheinen jetzt in der Stow-Queue für Neueinlagerung.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
