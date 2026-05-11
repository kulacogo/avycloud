/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Bulk "pro level" datasheet rewrite for ALL inventory products:
 * - Pro-level highlights (5-7, benefit–spec)
 * - Pro-level SEO description (HTML allowed: <p>, <ul>, <li>, <strong>)
 *
 * Implementation:
 * - Uses the existing review pipeline: runDatasheetReview() (Gemini) + saveProduct().
 * - Does NOT touch warehouse/stock/bin fields.
 *
 * Safety:
 * - Default is DRY-RUN (no Firestore writes).
 * - Use --apply with --expected-count guard.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/bulk-prolevel-datasheets.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/bulk-prolevel-datasheets.js --apply --expected-count 420
 *
 * Options:
 *   --min-qty <n>        default 0 (include all)
 *   --require-bin true   default false
 *   --limit <n>
 *   --offset <n>
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
const { runDatasheetReview } = require('../services/enrichment');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseBool(v, def) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  return def;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    expectedCount: 0,
    limit: 0,
    offset: 0,
    minQty: 0,
    requireBin: false,
    locale: 'de-DE',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--offset') {
      args.offset = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--min-qty') {
      args.minQty = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--require-bin') {
      args.requireBin = parseBool(argv[i + 1], true);
      i += 1;
    }
    if (t === '--locale') {
      args.locale = String(argv[i + 1] || 'de-DE');
      i += 1;
    }
  }
  return args;
}

function pickSku(product) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(product?.id) || '';
}

function sumBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function pickQuantity(product) {
  const candidates = [product?.inventory?.quantity, product?.storage?.quantity, sumBins(product)];
  for (const v of candidates) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickBinCode(product) {
  const direct = safeString(product?.storage?.binCode);
  if (direct) return direct;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  for (const b of bins) {
    const code = safeString(b?.code || b?.binCode);
    if (code) return code;
  }
  return '';
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'bulk-prolevel', stamp);
  ensureDir(outDir);

  console.log(`[bulk-prolevel] mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);
  const productsAll = await getAllProductsForTenant(TENANT_ID);
  const preCount = productsAll.length;
  console.log(`[bulk-prolevel] loaded products=${preCount}`);

  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[bulk-prolevel] ABORT: --apply requires --expected-count <n>');
    }
    if (preCount !== args.expectedCount) {
      throw new Error(`[bulk-prolevel] ABORT: expected=${args.expectedCount} got=${preCount}`);
    }
  }

  const eligible = productsAll.filter((p) => {
    const qty = pickQuantity(p);
    const bin = pickBinCode(p);
    if (Number(qty) < Number(args.minQty || 0)) return false;
    if (args.requireBin && !bin) return false;
    return true;
  });

  eligible.sort((a, b) => pickSku(a).localeCompare(pickSku(b), 'de', { sensitivity: 'base' }));

  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  let selected = offset ? eligible.slice(offset) : eligible;
  if (Number.isFinite(args.limit) && args.limit > 0) {
    selected = selected.slice(0, Math.max(0, Math.floor(args.limit)));
  }

  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        locale: args.locale,
        minQty: args.minQty,
        requireBin: args.requireBin,
        counts: { total: preCount, eligible: eligible.length, selected: selected.length },
        started_at_iso: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`[bulk-prolevel] eligible=${eligible.length} selected=${selected.length}`);
  if (!args.apply) {
    console.log('[bulk-prolevel] DRY_RUN complete. No Firestore writes were made.');
    return;
  }

  const progressPath = path.join(outDir, 'progress.json');
  const resultsJsonlPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsJsonlPath, '', { encoding: 'utf8', flag: 'w' });

  const progress = {
    total: selected.length,
    done: 0,
    success: 0,
    failed: 0,
    started_at_iso: new Date().toISOString(),
    updated_at_iso: new Date().toISOString(),
    last: null,
  };
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');

  for (let i = 0; i < selected.length; i += 1) {
    const p = selected[i];
    const sku = pickSku(p);
    const before = {
      desc_len: safeString(p?.details?.short_description || p?.details?.description).length,
      highlights: Array.isArray(p?.details?.key_features) ? p.details.key_features.filter(Boolean).length : 0,
    };
    try {
      await runDatasheetReview([p], {
        locale: args.locale,
        marketplaceEvidence: true,
        llmScopeId: 'bulk.prolevel',
      });

      await saveProduct(p, {
        source: 'script:bulk-prolevel',
        overwriteTextFields: true,
        // Do not touch warehouse/inventory fields; keep defaults.
      });

      const after = {
        desc_len: safeString(p?.details?.short_description || p?.details?.description).length,
        highlights: Array.isArray(p?.details?.key_features) ? p.details.key_features.filter(Boolean).length : 0,
      };
      progress.done += 1;
      progress.success += 1;
      progress.updated_at_iso = new Date().toISOString();
      progress.last = { sku, ok: true, before, after };
      fs.appendFileSync(resultsJsonlPath, `${JSON.stringify({ i, sku, ok: true, before, after })}\n`, 'utf8');
    } catch (e) {
      progress.done += 1;
      progress.failed += 1;
      progress.updated_at_iso = new Date().toISOString();
      progress.last = { sku, ok: false, error: e?.message || String(e), before };
      fs.appendFileSync(resultsJsonlPath, `${JSON.stringify({ i, sku, ok: false, error: e?.message || String(e), before })}\n`, 'utf8');
    }
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
    if ((i + 1) % 10 === 0) {
      console.log(`[bulk-prolevel] progress ${i + 1}/${selected.length} ok=${progress.success} failed=${progress.failed}`);
    }
  }

  console.log(`[bulk-prolevel] DONE ok=${progress.success} failed=${progress.failed}`);
}

main().catch((err) => {
  console.error('bulk-prolevel failed:', err?.stack || err?.message || err);
  process.exit(1);
});

