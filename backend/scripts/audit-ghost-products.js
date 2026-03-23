/* eslint-disable no-console */
/**
 * Audit & Cleanup Ghost Products in products_v2
 *
 * Findet und klassifiziert "Geister-Produkte" in 3 Kategorien:
 *   Typ 1: UUID als Titel/ID (z.B. 0060cdec-9193-411b-af64-4754ca0226bd)
 *   Typ 2: EAN/Barcode als Titel/ID (z.B. 00442039661193)
 *   Typ 3: Nur SKU, keine weiteren Daten (z.B. SKU-0698797502)
 *
 * Safety:
 *   - Dry-run by default (nur Report)
 *   - --apply → löscht Ghost-Produkte aus BEIDEN Collections
 *   - Produkte mit echten Bestellungen/Listings werden NICHT gelöscht
 *
 * Usage:
 *   node backend/scripts/audit-ghost-products.js
 *   node backend/scripts/audit-ghost-products.js --apply
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EAN_LIKE_REGEX = /^\d{8,14}$/;
const SKU_ONLY_REGEX = /^SKU-\d{10}$/;

function safeStr(v) {
  return v == null ? '' : String(v).trim();
}

function classifyGhost(docId, data) {
  const name = safeStr(data?.identification?.name);
  const brand = safeStr(data?.identification?.brand);
  const category = safeStr(data?.identification?.category);
  const sku = safeStr(data?.identification?.sku);
  const barcodes = Array.isArray(data?.identification?.barcodes) ? data.identification.barcodes.filter(Boolean) : [];
  const desc = safeStr(data?.details?.short_description);
  const images = Array.isArray(data?.details?.images) ? data.details.images.filter(Boolean) : [];
  const features = Array.isArray(data?.details?.key_features) ? data.details.key_features.filter(Boolean) : [];
  const categoryId = safeStr(data?.details?.categoryId);
  const price = data?.details?.pricing?.lowest_price?.amount || 0;
  const attrs = data?.details?.attributes;
  const attrCount = attrs && typeof attrs === 'object' ? Object.keys(attrs).length : 0;

  // Check if product has real marketplace activity (orders, listings)
  const hasEbayListing = Boolean(data?.ops?.ebay?.itemId || data?.ops?.ebay?.listingId);
  const hasKauflandListing = Boolean(data?.ops?.kaufland?.unitId);
  const hasOrders = (data?.ops?.order_count || 0) > 0;
  const hasSyncStatus = safeStr(data?.ops?.sync_status) === 'synced';

  // Never delete products with real activity
  if (hasOrders) return null;

  const result = {
    docId,
    name: name || docId,
    sku,
    brand,
    category,
    categoryId,
    barcodes,
    price,
    images: images.length,
    features: features.length,
    attrs: attrCount,
    descLen: desc.length,
    hasEbayListing,
    hasKauflandListing,
    hasSyncStatus,
    palette: safeStr(data?.ops?.sourcePalette),
    createdAt: safeStr(data?.ops?.last_saved_iso || data?.createdAt),
  };

  // Typ 1: UUID als Name/ID
  if (UUID_REGEX.test(docId) && (!name || name === 'Unbekanntes Produkt' || UUID_REGEX.test(name))) {
    return { ...result, type: 'uuid_ghost', reason: 'Document-ID ist UUID, kein echter Titel' };
  }

  // Typ 2: EAN/Barcode als Name/ID
  if (EAN_LIKE_REGEX.test(docId) && (!name || name === docId || EAN_LIKE_REGEX.test(name))) {
    return { ...result, type: 'ean_ghost', reason: 'EAN/Barcode als Titel, keine weiteren Daten' };
  }
  if (name && EAN_LIKE_REGEX.test(name) && !brand && !categoryId && desc.length < 10) {
    return { ...result, type: 'ean_ghost', reason: 'Titel ist nur eine Ziffernfolge' };
  }

  // Typ 3: Nur SKU, keine Daten (SKU im sku-Feld ODER als Name/Titel)
  const hasNoRealData = !name || name === 'Unbekanntes Produkt' || SKU_ONLY_REGEX.test(name);
  const hasNoContent = desc.length < 10 && features.length === 0 && images.length === 0 && attrCount < 2;
  const isSKUGhost = SKU_ONLY_REGEX.test(sku) || SKU_ONLY_REGEX.test(name) || SKU_ONLY_REGEX.test(docId);
  if (isSKUGhost && hasNoContent && !categoryId && !brand && price === 0) {
    return { ...result, type: 'sku_ghost', reason: 'Nur SKU generiert, keine Produktdaten' };
  }

  // Typ 4: Produkt mit "Unbekanntes Produkt" Name und keine Inhalte
  if (hasNoRealData && hasNoContent && !categoryId && price === 0) {
    return { ...result, type: 'empty_ghost', reason: 'Keine Identifikation, keine Inhalte, kein Preis' };
  }

  return null;
}

async function main() {
  console.log(`\n=== Ghost Product Audit (${APPLY ? 'APPLY MODE' : 'DRY-RUN'}) ===\n`);

  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  // Scan products_v2
  const v2Snap = await firestore.collection('products_v2').get();
  console.log(`products_v2: ${v2Snap.size} Dokumente gescannt`);

  const ghosts = [];
  const safe = [];

  const skuSurvivors = []; // Debug: SKU-pattern products that pass as "real"

  v2Snap.forEach((doc) => {
    const data = doc.data() || {};
    const ghost = classifyGhost(doc.id, data);
    if (ghost) {
      ghosts.push(ghost);
    } else {
      safe.push(doc.id);
      // Debug: why did SKU-pattern products survive?
      const name = safeStr(data?.identification?.name);
      if (SKU_ONLY_REGEX.test(name) || SKU_ONLY_REGEX.test(doc.id)) {
        const brand = safeStr(data?.identification?.brand);
        const cat = safeStr(data?.identification?.category);
        const catId = safeStr(data?.details?.categoryId);
        const desc = safeStr(data?.details?.short_description);
        const imgs = Array.isArray(data?.details?.images) ? data.details.images.filter(Boolean).length : 0;
        const feats = Array.isArray(data?.details?.key_features) ? data.details.key_features.filter(Boolean).length : 0;
        const attrs = data?.details?.attributes && typeof data.details.attributes === 'object' ? Object.keys(data.details.attributes).length : 0;
        const price = data?.details?.pricing?.lowest_price?.amount || 0;
        const orders = data?.ops?.order_count || 0;
        skuSurvivors.push({
          docId: doc.id, name, brand, catId, descLen: desc.length, imgs, feats, attrs, price, orders,
          ebayItemId: safeStr(data?.ops?.ebay?.itemId),
          kauflandUnitId: safeStr(data?.ops?.kaufland?.unitId),
        });
      }
    }
  });

  if (skuSurvivors.length) {
    console.log(`\n⚠️  DEBUG: ${skuSurvivors.length} SKU-Produkte als "echt" eingestuft:`);
    skuSurvivors.slice(0, 10).forEach((s) => {
      console.log(`    ${s.docId} | brand="${s.brand}" catId="${s.catId}" desc=${s.descLen} imgs=${s.imgs} feats=${s.feats} attrs=${s.attrs} price=${s.price} orders=${s.orders}`);
    });
    if (skuSurvivors.length > 10) console.log(`    ... und ${skuSurvivors.length - 10} weitere`);
  }

  // Group by type
  const byType = {};
  for (const g of ghosts) {
    byType[g.type] = byType[g.type] || [];
    byType[g.type].push(g);
  }

  console.log(`\n--- Ergebnis ---`);
  console.log(`Echte Produkte: ${safe.length}`);
  console.log(`Ghost-Produkte: ${ghosts.length}`);
  for (const [type, items] of Object.entries(byType)) {
    console.log(`  ${type}: ${items.length}`);
    // Show first 5 examples
    items.slice(0, 5).forEach((g) => {
      console.log(`    - ${g.docId} | Name: "${g.name}" | SKU: ${g.sku || '—'} | Palette: ${g.palette || '—'} | Reason: ${g.reason}`);
    });
    if (items.length > 5) console.log(`    ... und ${items.length - 5} weitere`);
  }

  // Warn about ghosts with marketplace listings
  const withListings = ghosts.filter((g) => g.hasEbayListing || g.hasKauflandListing || g.hasSyncStatus);
  if (withListings.length) {
    console.log(`\n⚠️  ${withListings.length} Ghost-Produkte haben Marketplace-Listings/Sync:`);
    withListings.forEach((g) => {
      console.log(`    - ${g.docId} | eBay: ${g.hasEbayListing} | Kaufland: ${g.hasKauflandListing} | Synced: ${g.hasSyncStatus}`);
    });
    console.log(`    → Diese werden NICHT gelöscht (manuelle Prüfung nötig)`);
  }

  const deletable = ghosts.filter((g) => !g.hasEbayListing && !g.hasKauflandListing && !g.hasSyncStatus);
  const notDeletable = ghosts.filter((g) => g.hasEbayListing || g.hasKauflandListing || g.hasSyncStatus);

  if (APPLY && deletable.length) {
    console.log(`\n🗑️  Lösche ${deletable.length} Ghost-Produkte...`);
    let deleted = 0;
    let errors = 0;

    for (const g of deletable) {
      try {
        // Delete from products_v2
        await firestore.collection('products_v2').doc(g.docId).delete();
        // Also delete from products (legacy) if exists
        const legacySnap = await firestore.collection('products').doc(g.docId).get();
        if (legacySnap.exists) {
          await firestore.collection('products').doc(g.docId).delete();
        }
        // Clean up sku_index if SKU exists
        if (g.sku) {
          const skuSnap = await firestore.collection('sku_index').doc(g.sku).get();
          if (skuSnap.exists && safeStr(skuSnap.data()?.productId) === g.docId) {
            await firestore.collection('sku_index').doc(g.sku).delete();
          }
        }
        deleted++;
      } catch (err) {
        console.error(`  ✗ Fehler bei ${g.docId}: ${err.message}`);
        errors++;
      }
    }
    console.log(`\n✓ ${deleted} gelöscht, ${errors} Fehler, ${notDeletable.length} übersprungen (haben Listings)`);
  } else if (!APPLY && deletable.length) {
    console.log(`\n→ ${deletable.length} Produkte würden gelöscht werden. Nutze --apply zum Ausführen.`);
  }

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    total_scanned: v2Snap.size,
    real_products: safe.length,
    ghosts_total: ghosts.length,
    ghosts_by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
    ghosts_with_listings: withListings.length,
    deletable: deletable.length,
    ghost_details: ghosts,
  };

  const outPath = path.join(outDir, 'ghost-products-audit.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${outPath}`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
