/**
 * Migration: products → products_v2
 *
 * Liest alle Produkte aus der alten Collection,
 * normalisiert sie und schreibt sie in products_v2.
 * Duplikate (gleiche kanonische ID) werden intelligent gemerged.
 *
 * Usage:
 *   DRY_RUN=true node scripts/migrate-products-v2.js   # Nur Analyse, kein Schreiben
 *   node scripts/migrate-products-v2.js                 # Tatsächliche Migration
 */
const { firestore } = require('../lib/firestore');
const { normalizeProduct, validateCanonical } = require('../lib/product-canonical');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 100; // Firestore batch limit ~10MB — 100 docs is safe for large products

/**
 * Berechnet einen Daten-Qualitätsscore für ein normalisiertes Produkt.
 * Höherer Score = mehr/bessere Daten.
 */
function scoreProduct(product) {
  let score = 0;

  // Identification fields
  if (product.identification?.name) score += 3;
  if (product.identification?.brand) score += 2;
  if (product.identification?.category) score += 1;
  if (product.identification?.sku) score += 1;
  score += (product.identification?.barcodes || []).filter(Boolean).length;
  score += (product.identification?.confidence || 0) * 5; // 0-5 Punkte

  // Details
  if (product.details?.short_description) score += 2;
  score += (product.details?.key_features || []).filter(Boolean).length;
  score += (product.details?.images || []).length * 2; // Bilder stark gewichten
  score += Object.keys(product.details?.attributes || {}).length;
  score += Object.keys(product.details?.identifiers || {}).filter(k => product.details.identifiers[k]).length;

  // Pricing
  if (product.details?.pricing?.buyPrice) score += 1;
  if (product.details?.pricing?.sellPrice) score += 1;

  // Ops
  if (product.ops?.totalStock > 0) score += 1;

  return score;
}

/**
 * Mergt zwei normalisierte Produkte: base gewinnt, donor füllt Lücken.
 * Gibt das gemergte Produkt zurück.
 */
function mergeProducts(base, donor) {
  const merged = structuredClone(base);

  // ── identification: fehlende Felder ergänzen ──
  for (const field of ['name', 'brand', 'category', 'sku', 'method']) {
    if (!merged.identification?.[field] && donor.identification?.[field]) {
      merged.identification[field] = donor.identification[field];
    }
  }

  // Barcodes zusammenführen (dedupliziert)
  const allBarcodes = [...new Set([
    ...(merged.identification?.barcodes || []),
    ...(donor.identification?.barcodes || []),
  ])].filter(Boolean);
  merged.identification.barcodes = allBarcodes;

  // Confidence: höheren Wert nehmen
  if ((donor.identification?.confidence || 0) > (merged.identification?.confidence || 0)) {
    merged.identification.confidence = donor.identification.confidence;
  }

  // ── details: fehlende Felder ergänzen ──
  if (!merged.details.short_description && donor.details?.short_description) {
    merged.details.short_description = donor.details.short_description;
  }

  // Key features: zusammenführen wenn base leer
  if ((merged.details.key_features || []).length === 0 && (donor.details?.key_features || []).length > 0) {
    merged.details.key_features = donor.details.key_features;
  }

  // Bilder zusammenführen (dedupliziert)
  const allImages = [...new Set([
    ...(merged.details?.images || []),
    ...(donor.details?.images || []),
  ])].filter(Boolean);
  merged.details.images = allImages;

  // Attributes: fehlende Keys ergänzen (base gewinnt bei Konflikten)
  const donorAttrs = donor.details?.attributes || {};
  for (const [key, value] of Object.entries(donorAttrs)) {
    if (merged.details.attributes[key] === undefined && value !== undefined) {
      merged.details.attributes[key] = value;
    }
  }

  // Identifiers: fehlende Keys ergänzen
  const donorIds = donor.details?.identifiers || {};
  for (const [key, value] of Object.entries(donorIds)) {
    if (!merged.details.identifiers[key] && value) {
      merged.details.identifiers[key] = value;
    }
  }

  // Pricing: fehlende Felder ergänzen
  const donorPricing = donor.details?.pricing || {};
  for (const [key, value] of Object.entries(donorPricing)) {
    if (!merged.details.pricing[key] && value) {
      merged.details.pricing[key] = value;
    }
  }

  // CategoryId: ergänzen wenn fehlend
  if (!merged.details.categoryId && donor.details?.categoryId) {
    merged.details.categoryId = donor.details.categoryId;
  }

  // Marketplace: zusammenführen
  const donorMarketplace = donor.details?.marketplace || {};
  for (const [key, value] of Object.entries(donorMarketplace)) {
    if (!merged.details.marketplace?.[key] && value) {
      if (!merged.details.marketplace) merged.details.marketplace = {};
      merged.details.marketplace[key] = value;
    }
  }

  return merged;
}

async function migrate() {
  console.log(`=== Products v2 Migration (DRY_RUN=${DRY_RUN}) ===`);

  const snapshot = await firestore.collection('products').get();
  console.log(`Found ${snapshot.size} products to migrate.`);

  let migrated = 0, errors = 0, skipped = 0;
  const issues = { attributeArray: 0, legacyCategory: 0, placeholders: 0, marketplaceInAttrs: 0, idRewritten: 0, duplicatesMerged: 0 };

  // ── Phase 1: Alle Produkte normalisieren + nach targetId gruppieren ──
  const targetMap = new Map(); // targetId → [{ originalId, normalized, score }]

  for (const doc of snapshot.docs) {
    try {
      const raw = { id: doc.id, ...doc.data() };
      const normalized = normalizeProduct(raw);
      const validation = validateCanonical(normalized);

      // Statistik sammeln
      if (Array.isArray(doc.data().details?.attributes)) issues.attributeArray++;
      if (doc.data().details?.ebayCategoryId || doc.data().details?.ebay_category_id) issues.legacyCategory++;
      if (!validation.valid) {
        validation.errors.forEach(e => {
          if (e.includes('Placeholder')) issues.placeholders++;
          if (e.includes('Marketplace key')) issues.marketplaceInAttrs++;
        });
      }

      if (normalized.id !== doc.id) issues.idRewritten++;

      const targetId = normalized.id || doc.id;
      const entry = { originalId: doc.id, normalized, score: scoreProduct(normalized) };

      if (targetMap.has(targetId)) {
        targetMap.get(targetId).push(entry);
      } else {
        targetMap.set(targetId, [entry]);
      }
    } catch (err) {
      console.error(`Error normalizing ${doc.id}: ${err.message}`);
      errors++;
    }
  }

  // ── Phase 2: Duplikate mergen + in Batches schreiben ──
  let batch = firestore.batch();
  let batchCount = 0;

  for (const [targetId, entries] of targetMap) {
    try {
      let finalProduct;

      if (entries.length === 1) {
        // Kein Duplikat — direkt übernehmen
        finalProduct = entries[0].normalized;
      } else {
        // Duplikat-Merge: Sortiere nach Score (höchster zuerst = Basis)
        entries.sort((a, b) => b.score - a.score);
        const base = entries[0];
        const originalIds = entries.map(e => e.originalId);

        console.log(`  MERGED: ${originalIds.join(' + ')} → ${targetId} (scores: ${entries.map(e => e.score).join(', ')})`);

        // Schrittweise mergen: base ← donor1 ← donor2 ...
        finalProduct = base.normalized;
        for (let i = 1; i < entries.length; i++) {
          finalProduct = mergeProducts(finalProduct, entries[i].normalized);
        }

        // Merge-Metadaten
        finalProduct.ops._mergedFrom = originalIds;
        finalProduct.ops._mergedAt = new Date().toISOString();
        issues.duplicatesMerged++;
      }

      if (!DRY_RUN) {
        batch.set(firestore.collection('products_v2').doc(targetId), finalProduct);
        batchCount++;
        if (batchCount >= BATCH_SIZE) {
          await batch.commit();
          migrated += batchCount;
          console.log(`  ...committed ${migrated} products`);
          batch = firestore.batch();
          batchCount = 0;
        }
      } else {
        migrated++;
      }
    } catch (err) {
      console.error(`Error writing ${targetId}: ${err.message}`);
      errors++;
      if (!DRY_RUN) {
        batch = firestore.batch();
        batchCount = 0;
      }
    }
  }

  // Commit remaining docs in the last partial batch
  if (!DRY_RUN && batchCount > 0) {
    await batch.commit();
    migrated += batchCount;
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Source documents: ${snapshot.size}`);
  console.log(`Target documents: ${migrated} (${snapshot.size - migrated} merged away)`);
  console.log(`Errors: ${errors}, Skipped: ${skipped}`);
  console.log(`\nIssues found & fixed:`);
  console.log(`  Attributes as Array: ${issues.attributeArray}`);
  console.log(`  Legacy category fields: ${issues.legacyCategory}`);
  console.log(`  Placeholder values: ${issues.placeholders}`);
  console.log(`  Marketplace keys in attributes: ${issues.marketplaceInAttrs}`);
  console.log(`  IDs rewritten to barcode: ${issues.idRewritten}`);
  console.log(`  Duplicates merged: ${issues.duplicatesMerged}`);

  if (DRY_RUN) {
    console.log(`\nDRY RUN — No data was written. Run with DRY_RUN=false to execute.`);
  }
}

migrate().catch(console.error);
