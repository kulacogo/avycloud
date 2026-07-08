'use strict';

/**
 * cleanup-ghost-products-2026-03.js — Bereinigt die 206+1 Geister-Produkte aus
 * dem Dual-Write-Incident vom 2026-03-23/24 (BUG-084/BUG-085).
 *
 * Signatur der Geister: identification.name === '' (oder Platzhalter),
 * frisch generierte SKU-<10 Ziffern>, Doc-ID = UUID / nackte EAN / SKU-…,
 * keine Bilder, kein Bestand, keine Listings, keine Orders.
 *
 * Drei Klassen:
 *  - RESTORE: Legacy-Doc `products/{id}` existiert mit echtem Namen → Inhalt
 *    (Whitelist) zurück in das v2-Doc schreiben. Round-trip über saveProductV2
 *    (CLAUDE.md Invariante 7). KEIN Restore von Bestand/Listing-Zeigern/
 *    BaseLinker-Feldern (BaseLinker ist TABU; Konten wurden 2026-07 getauscht).
 *  - DELETE: kein Legacy-Zwilling + nachweislich inert (kein Inhalt, kein
 *    Bestand, keine BINs, keine Listings, keine Orders) → Doc löschen.
 *  - SKIP: alles, was auch nur einen Inertness-Check nicht besteht.
 *
 * Sicherheit:
 *  - DRY-RUN ist Default; --apply zum Ausführen.
 *  - Vor JEDER Mutation wird das komplette Original-Doc nach
 *    `products_v2_ghost_backup_2026_07/{id}` gesichert (Undo-Pfad).
 *  - Restore läuft mit skipStockEvent:true (kein stock:changed, kein Ledger-
 *    Rauschen); Bestand bleibt unangetastet (saveProduct schreibt Warehouse-
 *    Felder für Bestands-Docs nie aus dem Payload).
 *
 * Aufruf:
 *   USE_PRODUCTS_V2=true node backend/scripts/cleanup-ghost-products-2026-03.js [--apply] [--tenant default]
 */

const GHOST_NAME_PLACEHOLDERS = new Set(['', 'unbekannt', 'unbekanntes produkt', 'unknown', 'n/a', 'na', '-', '—']);

/** Name ist leer oder Platzhalter? */
function hasGhostName(doc) {
  const name = String(doc?.identification?.name ?? '').trim().toLowerCase();
  return GHOST_NAME_PLACEHOLDERS.has(name);
}

/**
 * Inert = darf gefahrlos gelöscht werden: kein Inhalt, kein Bestand, keine
 * BINs, keine Listing-Zeiger, keine Orders/Sales, kein pending intake.
 * Bewusst konservativ: JEDES unerwartete Signal → nicht inert → SKIP.
 */
function isInertGhost(doc) {
  if (!doc || !hasGhostName(doc)) return false;
  const details = doc.details || {};
  const ops = doc.ops || {};

  const hasText = (v) => typeof v === 'string' && v.trim().length >= 3;
  if (hasText(doc.identification?.brand)) return false;
  if (hasText(details.description) || hasText(details.short_description) || hasText(details.long_description)) return false;
  if (Array.isArray(details.key_features) && details.key_features.some(hasText)) return false;
  if (Array.isArray(details.images) && details.images.length > 0) return false;

  const qty = Number(doc.inventory?.quantity ?? 0);
  if (qty !== 0) return false;
  if (Array.isArray(doc.storageBins) && doc.storageBins.length > 0) return false;
  if (doc.storage) return false;
  if (Number(ops.pending_intake_quantity ?? 0) !== 0) return false;

  if (ops.ebay?.itemId || ops.kaufland?.unitId) return false;
  if (ops.listingStatus?.ebay || ops.listingStatus?.kaufland) return false;
  if (doc.marketplace?.ebay?.itemId || doc.marketplace?.kaufland?.unitId) return false;
  if (Number(ops.order_count ?? 0) > 0 || Number(ops.salesCount ?? 0) > 0) return false;

  return true;
}

/** Legacy-Doc hat einen brauchbaren Namen? */
function legacyHasContent(legacy) {
  const name = String(legacy?.identification?.name ?? legacy?.name ?? '').trim();
  return name.length >= 3 && !GHOST_NAME_PLACEHOLDERS.has(name.toLowerCase());
}

/**
 * Restore-Payload: Inhalt (Whitelist) aus dem Legacy-Doc in das bestehende
 * v2-Doc gemerged. NIEMALS kopiert: BaseLinker-Felder, marketplace/ops
 * (Listing-Zeiger des ALTEN Kontos), inventory/storage/storageBins.
 */
function buildRestorePayload(ghostDoc, legacy) {
  const lIdent = legacy.identification || {};
  const lDetails = legacy.details || {};

  const identifiers = {};
  for (const k of ['ean', 'gtin', 'upc', 'mpn', 'sku']) {
    if (lDetails.identifiers?.[k]) identifiers[k] = String(lDetails.identifiers[k]);
  }

  const details = {
    ...(ghostDoc.details || {}),
    description: lDetails.description || ghostDoc.details?.description || '',
    short_description: lDetails.short_description || ghostDoc.details?.short_description || '',
    key_features: Array.isArray(lDetails.key_features) ? lDetails.key_features : [],
    attributes: (lDetails.attributes && typeof lDetails.attributes === 'object') ? lDetails.attributes : {},
    images: Array.isArray(lDetails.images) ? lDetails.images : [],
    identifiers: { ...(ghostDoc.details?.identifiers || {}), ...identifiers },
  };
  if (lDetails.gpsr && typeof lDetails.gpsr === 'object') details.gpsr = lDetails.gpsr;
  if (lDetails.pricing && typeof lDetails.pricing === 'object') details.pricing = lDetails.pricing;
  if (lDetails.weight != null) details.weight = lDetails.weight;
  if (lDetails.categoryId) details.categoryId = String(lDetails.categoryId);
  // BaseLinker-Reste explizit NIE übernehmen (TABU) — auch nicht via Spread aus dem Ghost.
  for (const k of Object.keys(details)) {
    if (/baselinker/i.test(k)) delete details[k];
  }

  return {
    ...ghostDoc,
    id: ghostDoc.id,
    tenantId: ghostDoc.tenantId || legacy.tenantId || 'default',
    identification: {
      ...(ghostDoc.identification || {}),
      name: String(lIdent.name || legacy.name || '').trim(),
      brand: lIdent.brand ? String(lIdent.brand) : (ghostDoc.identification?.brand || ''),
      category: lIdent.category ? String(lIdent.category) : (ghostDoc.identification?.category || ''),
      method: lIdent.method || ghostDoc.identification?.method || 'barcode',
      barcodes: Array.isArray(lIdent.barcodes) ? lIdent.barcodes.filter(Boolean).map(String) : [],
      confidence: typeof lIdent.confidence === 'number' ? lIdent.confidence : 0.5,
      // Echte (Legacy-)SKU gewinnt über die im März frisch generierte Zufalls-SKU.
      sku: identifiers.sku || lIdent.sku || ghostDoc.identification?.sku,
    },
    details,
  };
}

/** Klassifiziert einen Geist. legacy = null wenn kein Legacy-Doc existiert. */
function classifyGhost(ghostDoc, legacy) {
  if (!isInertGhost(ghostDoc)) return 'skip';
  if (legacy && legacyHasContent(legacy)) return 'restore';
  return 'delete';
}

function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return { apply: argv.includes('--apply'), tenant: val('--tenant') || 'default' };
}

module.exports = { hasGhostName, isInertGhost, legacyHasContent, buildRestorePayload, classifyGhost, parseArgs };

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (process.env.USE_PRODUCTS_V2 !== 'true') {
      console.error('❌ USE_PRODUCTS_V2=true erforderlich. Abbruch.');
      process.exit(1);
    }
    const { firestore } = require('../lib/firestore');
    const { saveProductV2 } = require('../lib/product-store');

    const BACKUP_COLLECTION = 'products_v2_ghost_backup_2026_07';
    console.log(`[ghost-cleanup] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);

    // Kandidaten: leerer Name + bekannte Platzhalter-Namen.
    const candidates = new Map();
    for (const name of ['', 'Unbekanntes Produkt', 'Unbekannt', 'Unknown']) {
      const snap = await firestore.collection('products_v2')
        .where('identification.name', '==', name).get();
      for (const d of snap.docs) candidates.set(d.id, { id: d.id, ...d.data() });
    }
    console.log(`  Kandidaten: ${candidates.size}`);

    const stats = { restore: 0, delete: 0, skip: 0 };
    const skipped = [];
    for (const [id, ghost] of candidates) {
      if ((ghost.tenantId || 'default') !== args.tenant) { stats.skip++; skipped.push(`${id} (tenant)`); continue; }

      const legacySnap = await firestore.collection('products').doc(id).get();
      const legacy = legacySnap.exists ? { id, ...legacySnap.data() } : null;
      const action = classifyGhost(ghost, legacy);
      stats[action]++;

      if (action === 'skip') { skipped.push(id); continue; }
      console.log(`  ${args.apply ? '' : '[dry-run] '}${action.toUpperCase()} ${id}${action === 'restore' ? ` ← products/${id} ("${String(legacy?.identification?.name || legacy?.name || '').slice(0, 60)}")` : ''}`);
      if (!args.apply) continue;

      // 1) Backup des Original-Zustands (Undo-Pfad)
      await firestore.collection(BACKUP_COLLECTION).doc(id).set({
        backedUpAt: new Date().toISOString(),
        action,
        incident: 'ghost-products-2026-03-23',
        data: ghost,
      });

      // 2) Mutation
      if (action === 'restore') {
        const payload = buildRestorePayload(ghost, legacy);
        await saveProductV2(payload, { skipStockEvent: true, source: 'ghost-cleanup-2026-03' });
      } else {
        await firestore.collection('products_v2').doc(id).delete();
      }
    }

    console.log(`\n  restore: ${stats.restore}, delete: ${stats.delete}, skip: ${stats.skip}`);
    if (skipped.length) console.log(`  übersprungen: ${skipped.join(', ')}`);
    console.log(args.apply
      ? `\n✅ Fertig. Backups in ${BACKUP_COLLECTION}.`
      : '\nDRY-RUN — nichts verändert. Mit --apply ausführen.');
    process.exit(0);
  })().catch((err) => {
    console.error(`[ghost-cleanup] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
