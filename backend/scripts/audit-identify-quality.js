/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Audit identify quality across all Firestore products, grouped by last_saved_source.
 *
 * Usage:
 *   node backend/scripts/audit-identify-quality.js
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const { evaluateEbayReady } = require('../lib/datasheet-quality');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'identify_audit', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const products = await getAllProductsForTenant(TENANT_ID);
  const rows = [];
  const summary = {};

  for (const p of products) {
    const src = String(p?.ops?.last_saved_source || 'unknown');
    const q = evaluateEbayReady(p, { force: true });
    summary[src] = summary[src] || { total: 0, ebay_ready: 0, not_ready: 0 };
    summary[src].total += 1;
    if (q.ok) summary[src].ebay_ready += 1;
    else summary[src].not_ready += 1;

    if (!q.ok) {
      rows.push({
        id: p.id,
        sku: p?.details?.identifiers?.sku || p?.identification?.sku || p.id,
        last_saved_source: src,
        issues: q.issues.join('|'),
        title_len: q.snapshot.title_len,
        desc_len: q.snapshot.desc_len,
        features: q.snapshot.features,
        attrs: q.snapshot.attrs,
        category: q.snapshot.category,
      });
    }
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ at_iso: new Date().toISOString(), summary }, null, 2), 'utf8');

  const headers = ['id','sku','last_saved_source','issues','title_len','desc_len','features','attrs','category'];
  const csv = [headers.join(',')].concat(
    rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))
  );
  fs.writeFileSync(path.join(outDir, 'not_ebay_ready.csv'), csv.join('\n'), 'utf8');

  console.log(`[audit-identify-quality] wrote ${rows.length} not-ready rows to ${outDir}`);
  const top = Object.entries(summary).sort((a,b)=>b[1].not_ready-a[1].not_ready).slice(0, 10);
  console.log('[audit-identify-quality] top sources by not_ready:', top);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

