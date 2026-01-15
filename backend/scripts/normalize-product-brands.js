/* eslint-disable no-console */
/**
 * Normalize brand casing for consistency:
 * - identification.brand: "adidas" -> "Adidas"
 * - Keep stylized brands if already present (e.g. "eBay", "H&M", "ALKAR")
 * - Optionally re-coerce title to policy so the title prefix matches the normalized brand casing.
 *
 * Safety:
 * - Default is DRY_RUN (no writes).
 * - Use --apply with --expected-count guard.
 * - By default, skip UI-saved products (ops.last_saved_source === 'ui') unless --include-ui is set.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/normalize-product-brands.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/normalize-product-brands.js --apply --expected-count 531
 *
 * Optional:
 *   --include-ui   (also update UI-saved products; NOT recommended)
 *   --limit <n>    (for testing)
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { normalizeBrandDisplayCase } = require('../lib/brand-normalize');
const { coerceTitleToPolicy } = require('../lib/title-policy');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

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

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: 0, includeUi: false, limit: 0 };
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
    if (t === '--include-ui') {
      args.includeUi = true;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function findAttrKey(attrs, needleLower) {
  if (!attrs || typeof attrs !== 'object') return null;
  return Object.keys(attrs).find((k) => safeString(k).toLowerCase() === needleLower) || null;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'brand-normalize', stamp);
  ensureDir(outDir);

  console.log(`[brand-normalize] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[brand-normalize] preCount=${preCount}`);
  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[brand-normalize] ABORT: --apply requires --expected-count <number>');
    }
    if (preCount !== args.expectedCount) {
      throw new Error(`[brand-normalize] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
    }
  }

  const report = [];
  const summary = {
    preCount,
    total: preCount,
    considered: 0,
    skipped_ui: 0,
    update: 0,
    noop: 0,
    timestamp: new Date().toISOString(),
  };

  const docs = args.limit && args.limit > 0 ? snap.docs.slice(0, args.limit) : snap.docs;

  for (const doc of docs) {
    const data = doc.data() || {};
    const docId = doc.id;
    const lastSource = safeString(data?.ops?.last_saved_source) || 'unknown';
    if (!args.includeUi && lastSource === 'ui') {
      summary.skipped_ui += 1;
      continue;
    }

    summary.considered += 1;
    const currentTitle = safeString(data?.identification?.name);
    const currentBrand = safeString(data?.identification?.brand);
    if (!currentBrand) {
      summary.noop += 1;
      continue;
    }

    const normalizedBrand = normalizeBrandDisplayCase(currentBrand, { titleHint: currentTitle });
    const needsBrand = Boolean(normalizedBrand) && normalizedBrand !== currentBrand;

    if (!needsBrand) {
      summary.noop += 1;
      continue;
    }

    const candidate = {
      ...data,
      identification: { ...(data.identification || {}), brand: normalizedBrand },
    };
    const nextTitle = currentTitle
      ? coerceTitleToPolicy(candidate, currentTitle, { minLen: 65, maxLen: 80, softMaxLen: 75 })
      : '';
    const titleChanged = Boolean(nextTitle) && nextTitle !== currentTitle;

    const updates = {
      'identification.brand': normalizedBrand,
      'ops.last_saved_source': 'brand-normalize-v1',
      'ops.last_saved_iso': new Date().toISOString(),
      'ops.data_quality': {
        ...(data?.ops?.data_quality || {}),
        brand_case_v1: {
          iso: new Date().toISOString(),
          before: currentBrand,
          after: normalizedBrand,
          title_before: currentTitle || null,
          title_after: titleChanged ? nextTitle : currentTitle || null,
        },
      },
    };

    if (titleChanged) {
      updates['identification.name'] = nextTitle;
    }

    // Keep attributes "Marke"/"Hersteller" aligned (case-only) when they match the brand.
    const attrs =
      data?.details?.attributes && typeof data.details.attributes === 'object'
        ? data.details.attributes
        : null;
    if (attrs) {
      const markeKey = findAttrKey(attrs, 'marke');
      if (markeKey && typeof attrs[markeKey] === 'string') {
        const v = safeString(attrs[markeKey]);
        if (v && v.toLowerCase() === currentBrand.toLowerCase() && v !== normalizedBrand) {
          updates[`details.attributes.${markeKey}`] = normalizedBrand;
        }
      }
      const herstellerKey = findAttrKey(attrs, 'hersteller');
      if (herstellerKey && typeof attrs[herstellerKey] === 'string') {
        const v = safeString(attrs[herstellerKey]);
        if (v && v.toLowerCase() === currentBrand.toLowerCase() && v !== normalizedBrand) {
          updates[`details.attributes.${herstellerKey}`] = normalizedBrand;
        }
      }
    }

    summary.update += 1;
    report.push({
      docId,
      lastSource,
      brand_before: currentBrand,
      brand_after: normalizedBrand,
      title_before: currentTitle,
      title_after: titleChanged ? nextTitle : currentTitle,
    });

    if (args.apply) {
      // writes handled in the BulkWriter phase below
    }
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  const headers = ['docId', 'lastSource', 'brand_before', 'brand_after', 'title_before', 'title_after'];
  const lines = [headers.join(',')];
  for (const row of report) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'rows.csv'), lines.join('\n'), 'utf8');

  console.log(`[brand-normalize] considered=${summary.considered} skipped_ui=${summary.skipped_ui} update=${summary.update} noop=${summary.noop}`);
  console.log(`[brand-normalize] reportRows=${report.length}`);

  if (!args.apply) {
    console.log('[brand-normalize] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[brand-normalize] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 30, maxOpsPerSecond: 200 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[brand-normalize] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  // Re-run computation for apply to avoid persisting huge update payloads in report
  const applyDocs = docs;
  for (const doc of applyDocs) {
    const data = doc.data() || {};
    const docId = doc.id;
    const lastSource = safeString(data?.ops?.last_saved_source) || 'unknown';
    if (!args.includeUi && lastSource === 'ui') continue;

    const currentTitle = safeString(data?.identification?.name);
    const currentBrand = safeString(data?.identification?.brand);
    if (!currentBrand) continue;

    const normalizedBrand = normalizeBrandDisplayCase(currentBrand, { titleHint: currentTitle });
    if (!normalizedBrand || normalizedBrand === currentBrand) continue;

    const candidate = {
      ...data,
      identification: { ...(data.identification || {}), brand: normalizedBrand },
    };
    const nextTitle = currentTitle
      ? coerceTitleToPolicy(candidate, currentTitle, { minLen: 65, maxLen: 80, softMaxLen: 75 })
      : '';
    const titleChanged = Boolean(nextTitle) && nextTitle !== currentTitle;

    const updates = {
      'identification.brand': normalizedBrand,
      'ops.last_saved_source': 'brand-normalize-v1',
      'ops.last_saved_iso': new Date().toISOString(),
      'ops.data_quality': {
        ...(data?.ops?.data_quality || {}),
        brand_case_v1: {
          iso: new Date().toISOString(),
          before: currentBrand,
          after: normalizedBrand,
          title_before: currentTitle || null,
          title_after: titleChanged ? nextTitle : currentTitle || null,
        },
      },
    };
    if (titleChanged) {
      updates['identification.name'] = nextTitle;
    }

    const attrs =
      data?.details?.attributes && typeof data.details.attributes === 'object'
        ? data.details.attributes
        : null;
    if (attrs) {
      const markeKey = findAttrKey(attrs, 'marke');
      if (markeKey && typeof attrs[markeKey] === 'string') {
        const v = safeString(attrs[markeKey]);
        if (v && v.toLowerCase() === currentBrand.toLowerCase() && v !== normalizedBrand) {
          updates[`details.attributes.${markeKey}`] = normalizedBrand;
        }
      }
      const herstellerKey = findAttrKey(attrs, 'hersteller');
      if (herstellerKey && typeof attrs[herstellerKey] === 'string') {
        const v = safeString(attrs[herstellerKey]);
        if (v && v.toLowerCase() === currentBrand.toLowerCase() && v !== normalizedBrand) {
          updates[`details.attributes.${herstellerKey}`] = normalizedBrand;
        }
      }
    }

    const ref = firestore.collection('products').doc(docId);
    bulkWriter.update(ref, updates);
  }

  await bulkWriter.close();
  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[brand-normalize] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[brand-normalize] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[brand-normalize] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

