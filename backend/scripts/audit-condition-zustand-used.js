/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Audit (and optionally fix) products where details.attributes.Zustand indicates USED/Gebraucht.
 *
 * Why:
 * - Improve/LLM pipelines must not create Zustand=Gebraucht. We now enforce this in saveProduct() for non-UI saves.
 * - This script helps find existing products that already have Zustand set to used, so we can review/cleanup.
 *
 * Output:
 * - exports/condition_audit/<stamp>/zustand_used.csv
 * - exports/condition_audit/<stamp>/zustand_used.json
 *
 * Usage:
 *   node backend/scripts/audit-condition-zustand-used.js                # dry-run (default)
 *   node backend/scripts/audit-condition-zustand-used.js --apply        # normalize Zustand->NEU + clear condition_locked
 *
 * Notes:
 * - We ONLY touch Zustand + ops.condition_locked (and add a dq marker) when --apply is used.
 * - We use saveProduct() to keep invariants intact; this may also re-coerce titles for non-UI saves.
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant, saveProduct } = require('../lib/firestore');


// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const USED_CONDITION_RE =
  /\b(gebraucht|used|pre[-\s]?owned|second hand|secondhand|b-ware|refurb(?:ished)?|renewed|open box|openbox)\b/i;

function findZustandKey(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
  return Object.keys(attrs).find((k) => String(k || '').trim().toLowerCase() === 'zustand') || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');

  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'condition_audit', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const products = await getAllProductsForTenant(TENANT_ID);
  const hits = [];

  for (const p of products) {
    const attrs = p?.details?.attributes || {};
    const zKey = findZustandKey(attrs);
    if (!zKey) continue;
    const val = safeString(attrs[zKey]);
    if (!val) continue;
    if (!USED_CONDITION_RE.test(val)) continue;

    hits.push({
      id: p.id,
      sku: safeString(p?.details?.identifiers?.sku || p?.identification?.sku || p.id),
      title: safeString(p?.identification?.name),
      brand: safeString(p?.identification?.brand),
      category: safeString(p?.identification?.category),
      zustand: val,
      condition_locked: Boolean(p?.ops?.condition_locked),
      last_saved_source: safeString(p?.ops?.last_saved_source),
    });
  }

  const jsonPath = path.join(outDir, 'zustand_used.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ at_iso: new Date().toISOString(), count: hits.length, hits }, null, 2), 'utf8');

  const headers = [
    'id',
    'sku',
    'zustand',
    'condition_locked',
    'last_saved_source',
    'brand',
    'title',
    'category',
  ];
  const csvLines = [headers.join(',')].concat(
    hits.map((row) => headers.map((h) => csvEscape(row[h])).join(','))
  );
  fs.writeFileSync(path.join(outDir, 'zustand_used.csv'), csvLines.join('\n'), 'utf8');

  console.log(`[audit-condition-zustand-used] found ${hits.length} products with Zustand~used`);
  console.log(`[audit-condition-zustand-used] wrote ${outDir}`);

  if (!APPLY || hits.length === 0) return;

  console.log('[audit-condition-zustand-used] APPLY: normalizing Zustand -> NEU and clearing condition_locked...');

  let updated = 0;
  for (const row of hits) {
    const p = products.find((x) => x.id === row.id);
    if (!p) continue;
    const next = JSON.parse(JSON.stringify(p));
    if (!next.details) next.details = {};
    if (!next.details.attributes || typeof next.details.attributes !== 'object') next.details.attributes = {};
    const zKey = findZustandKey(next.details.attributes) || 'Zustand';
    next.details.attributes[zKey] = 'NEU';
    next.ops = next.ops || {};
    next.ops.condition_locked = false;
    next.ops.data_quality = next.ops.data_quality || {};
    next.ops.data_quality.condition_bulk_normalized_neu_v1 = {
      at_iso: new Date().toISOString(),
      previous: row.zustand,
    };
    await saveProduct(next, {
      source: 'script-condition-normalize',
      overwriteTextFields: false,
      replaceAttributes: true,
      allowCategoryChange: false,
      allowWarehouseFields: false,
      syncIdentifiersFromBarcodes: false,
    });
    updated += 1;
  }

  console.log(`[audit-condition-zustand-used] APPLY done. Updated ${updated} products.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

