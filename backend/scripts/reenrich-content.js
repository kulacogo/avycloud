#!/usr/bin/env node
'use strict';

/**
 * reenrich-content.js — run the content re-enrichment bulk action from the CLI.
 *
 * DRY-RUN BY DEFAULT (reads + computes proposed changes, writes NOTHING).
 * Content only — never touches inventory / sku / storage, never publishes.
 *
 * Usage:
 *   node backend/scripts/reenrich-content.js                       # dry-run, HOMEDEMO+BelleMax
 *   node backend/scripts/reenrich-content.js --tenant trendocean   # pick tenant
 *   node backend/scripts/reenrich-content.js --brands HOMEDEMO,BelleMax --limit 5000
 *   node backend/scripts/reenrich-content.js --apply               # actually write (after reviewing dry-run)
 *
 * The dry-run still calls external price/research APIs (read-only) to compute
 * proposed sellPrice/title/etc., so credentials/quota are used but no data is saved.
 */

const { runBulkAction } = require('../services/admin-bulk-actions');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const apply = Boolean(arg('apply', false));
  const tenantId = (arg('tenant', process.env.TENANT_ID || '') || '') || null;
  const brands = String(arg('brands', 'HOMEDEMO,BelleMax'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Number(arg('limit', 5000)) || 5000;

  // --ids a,b,c  OR  --idsFile path  → target exact product IDs (most precise)
  const idsArg = arg('ids', '');
  const idsFile = arg('idsFile', '');
  let productIds = null;
  if (idsArg && idsArg !== true) {
    productIds = String(idsArg).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (idsFile && idsFile !== true) {
    productIds = require('fs').readFileSync(String(idsFile), 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }

  const target = productIds ? `${productIds.length} IDs` : `brands=${brands.join(', ')}`;
  console.log(`[reenrich] apply=${apply}  tenant=${tenantId || '(default)'}  ${target}  limit=${limit}`);
  if (!apply) console.log('[reenrich] DRY-RUN — nothing will be written.\n');

  const res = await runBulkAction('reenrich_content', {
    apply,
    tenantId,
    productIds,
    brands: productIds ? null : brands,
    limit,
  });

  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(res.summary, null, 2));

  console.log('\n=== SAMPLES (first 25) ===');
  for (const s of res.samples || []) {
    if (s.status === 'error') {
      console.log(`  ✖ ${s.sku}  ERROR: ${s.message}`);
      continue;
    }
    const mark = s.bucket === 'enriched' ? '✅' : s.bucket === 'unchanged' ? '➖' : '✖';
    console.log(`  ${mark} ${s.sku}  [${s.bucket}]  conf=${s.confidence ?? '?'}  geändert=${(s.changed || []).join(',') || '-'}${s.error ? '  ERROR: ' + s.error : ''}`);
  }

  console.log('\n=== BRAUCHT AUFMERKSAMKEIT (nicht angereichert) ===');
  for (const n of res.attention || []) {
    console.log(`  ${n.sku}  [${n.bucket}]${n.error ? '  ' + n.error : ''}`);
  }

  process.exit(0);
})().catch((e) => {
  console.error('[reenrich] FAILED:', (e && e.stack) || e);
  process.exit(1);
});
