/* eslint-disable no-console */
/**
 * Cleanup product barcodes/identifiers:
 * - Keep only valid GTIN/EAN/UPC (8/12/13/14 digits with valid checkdigit)
 * - Prefer filling details.identifiers.ean/gtin/upc from the valid set
 * - Remove invalid/nonstandard codes from identification.barcodes
 * - Remove EAN/GTIN/UPC keys from details.attributes (move to attributes_extra for forensics)
 *
 * Safety:
 * - Update-only with strict pre/post count guard (no creates/deletes)
 *
 * Usage:
 *   node backend/scripts/cleanup-product-barcodes.js --dry-run
 *   node backend/scripts/cleanup-product-barcodes.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { isValidGtin, normalizeDigits } = require('../lib/gtin');

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

function pickSku(product, docId) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(docId) ||
    ''
  );
}

function normalizeBarcode(value) {
  return normalizeDigits((value || '').toString());
}

function isValidCode(code) {
  const digits = normalizeBarcode(code);
  if (!digits) return false;
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  return isValidGtin(digits);
}

function summarizeCandidates(values = []) {
  const normalized = Array.from(new Set(values.map(normalizeBarcode).filter(Boolean)));
  const valid = normalized.filter(isValidCode);
  const invalid = normalized.filter((v) => !valid.includes(v));
  const nonstandard = normalized.filter((v) => ![8, 12, 13, 14].includes(v.length));

  const gtin14 = valid.find((v) => v.length === 14) || null;
  let ean13 = valid.find((v) => v.length === 13) || null;
  const upc12 = valid.find((v) => v.length === 12) || null;
  const ean8 = valid.find((v) => v.length === 8) || null;

  // If we only have GTIN14 starting with 0, derive EAN13 (safe equivalence)
  if (!ean13 && gtin14 && gtin14.startsWith('0')) {
    const derived = gtin14.slice(1);
    if (derived.length === 13 && isValidCode(derived)) {
      ean13 = derived;
    }
  }

  const ordered = [];
  [ean13, gtin14, upc12, ean8].forEach((v) => {
    if (v && !ordered.includes(v)) ordered.push(v);
  });
  valid.forEach((v) => {
    if (!ordered.includes(v)) ordered.push(v);
  });

  return { normalized, valid, invalid, nonstandard, ean13, gtin14, upc12, ean8, ordered };
}

function findAttrKeyInsensitive(attrs, targetLower) {
  if (!attrs || typeof attrs !== 'object') return null;
  return Object.keys(attrs).find((k) => String(k || '').trim().toLowerCase() === targetLower) || null;
}

function buildPatch(product) {
  const updates = {};
  const details = product?.details && typeof product.details === 'object' ? product.details : {};
  const ids = details?.identifiers && typeof details.identifiers === 'object' ? details.identifiers : {};
  const attrs = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const extra = details?.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [];

  const attrEanKey = findAttrKeyInsensitive(attrs, 'ean');
  const attrGtinKey = findAttrKeyInsensitive(attrs, 'gtin');
  const attrUpcKey = findAttrKeyInsensitive(attrs, 'upc');

  const candidates = [
    ...barcodes,
    ids.ean,
    ids.gtin,
    ids.upc,
    attrEanKey ? attrs[attrEanKey] : null,
    attrGtinKey ? attrs[attrGtinKey] : null,
    attrUpcKey ? attrs[attrUpcKey] : null,
  ].filter(Boolean);

  const summary = summarizeCandidates(candidates);

  // identification.barcodes: keep only valid ordered codes
  const nextBarcodes = summary.ordered;
  const currentBarcodesNormalized = Array.from(new Set(barcodes.map(normalizeBarcode).filter(Boolean)));
  const nextBarcodesNormalized = nextBarcodes;
  const barcodesChanged =
    JSON.stringify(currentBarcodesNormalized) !== JSON.stringify(nextBarcodesNormalized);
  if (barcodesChanged) {
    if (nextBarcodes.length) {
      updates['identification.barcodes'] = nextBarcodes;
    } else {
      updates['identification.barcodes'] = FieldValue.delete();
    }
  }

  // identifiers: set only if valid; else delete
  const curEan = normalizeBarcode(ids.ean);
  const curGtin = normalizeBarcode(ids.gtin);
  const curUpc = normalizeBarcode(ids.upc);
  if (summary.ean13) {
    if (curEan !== summary.ean13) updates['details.identifiers.ean'] = summary.ean13;
  } else if (ids.ean) {
    updates['details.identifiers.ean'] = FieldValue.delete();
  }
  if (summary.gtin14) {
    if (curGtin !== summary.gtin14) updates['details.identifiers.gtin'] = summary.gtin14;
  } else if (ids.gtin) {
    updates['details.identifiers.gtin'] = FieldValue.delete();
  }
  if (summary.upc12) {
    if (curUpc !== summary.upc12) updates['details.identifiers.upc'] = summary.upc12;
  } else if (ids.upc) {
    updates['details.identifiers.upc'] = FieldValue.delete();
  }

  // Move attribute EAN/GTIN/UPC to attributes_extra (avoid syncing as features / confusion)
  const moveAttr = (key) => {
    if (!key) return;
    const val = attrs[key];
    if (val === undefined) return;
    // preserve in extra under original key
    updates[`details.attributes_extra.${key}`] = val;
    updates[`details.attributes.${key}`] = FieldValue.delete();
  };
  moveAttr(attrEanKey);
  moveAttr(attrGtinKey);
  moveAttr(attrUpcKey);

  // Data quality note
  const hasChange = Object.keys(updates).length > 0;
  if (hasChange) {
    updates['ops.data_quality'] = {
      ...(product?.ops?.data_quality || {}),
      barcode_cleanup_v1: {
        iso: new Date().toISOString(),
        valid_count: summary.valid.length,
        invalid: summary.invalid.slice(0, 30),
        nonstandard: summary.nonstandard.slice(0, 30),
      },
    };
  }

  return { updates, summary, hasChange };
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: 420 };
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
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'barcode-cleanup', stamp);
  ensureDir(outDir);

  console.log(`[barcode-cleanup] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);
  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[leaky] Loaded products: ${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[barcode-cleanup] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const report = [];
  const summary = {
    preCount,
    touched: 0,
    invalid_codes_products: 0,
    missing_any_valid: 0,
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sku = pickSku(data, doc.id);
    const { updates, summary: s, hasChange } = buildPatch(data);
    if (s.invalid.length) summary.invalid_codes_products += 1;
    if (!s.valid.length) summary.missing_any_valid += 1;
    if (!hasChange) continue;
    summary.touched += 1;
    report.push({
      docId: doc.id,
      sku,
      valid: s.valid,
      invalid: s.invalid,
      nonstandard: s.nonstandard,
      updates: args.apply ? undefined : updates,
    });
  }

  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[barcode-cleanup] touched=${summary.touched} invalid_products=${summary.invalid_codes_products} missing_valid=${summary.missing_any_valid}`);

  if (!args.apply) {
    console.log('[barcode-cleanup] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[barcode-cleanup] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 40, maxOpsPerSecond: 250 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[barcode-cleanup] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    const ref = firestore.collection('products').doc(item.docId);
    const docData = snap.docs.find((d) => d.id === item.docId)?.data() || {};
    const { updates } = buildPatch(docData);
    if (!updates || Object.keys(updates).length === 0) continue;
    bulkWriter.update(ref, updates);
  }
  await bulkWriter.close();

  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[barcode-cleanup] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[barcode-cleanup] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[barcode-cleanup] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


