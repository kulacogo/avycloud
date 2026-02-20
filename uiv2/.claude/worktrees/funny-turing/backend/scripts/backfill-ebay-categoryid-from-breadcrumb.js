/* eslint-disable no-console */
/**
 * Backfill `details.categoryId` from existing `identification.category` breadcrumb text.
 *
 * This fixes the inconsistent state where the UI/CSV shows a category tree,
 * but we don't have the canonical eBay category id stored on the product.
 *
 * Safety:
 * - Only operates when identification.category contains '>' (breadcrumb-like).
 * - Uses canonical eBay taxonomy (backend/ebay-data/categories.json) with conservative matching.
 * - Update-only with strict pre/post count guard.
 *
 * Usage:
 *   node backend/scripts/backfill-ebay-categoryid-from-breadcrumb.js --dry-run
 *   node backend/scripts/backfill-ebay-categoryid-from-breadcrumb.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const EBAY_CATEGORIES = JSON.parse(fs.readFileSync(EBAY_CATEGORIES_JSON, 'utf8'));

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

const EBAY_CATEGORY_LIST = Object.values(EBAY_CATEGORIES || {})
  .map((c) => ({
    id: c?.id != null ? String(c.id) : '',
    name: safeString(c?.name),
    breadcrumb: safeString(c?.breadcrumb),
  }))
  .filter((c) => c.id && c.breadcrumb);

const EBAY_ROOT_INDEX = (() => {
  const map = new Map();
  for (const entry of EBAY_CATEGORY_LIST) {
    const root = safeString(entry.breadcrumb.split('>')[0] || '');
    const key = normalizeText(root);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return map;
})();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeText(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  const t = normalizeText(text);
  if (!t) return [];
  return t
    .split(/\s+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && w !== 'auto' && w !== 'teile');
}

function strictLeafOverlapCount(leafTokens, nameTokens) {
  const setName = new Set(nameTokens);
  let count = 0;
  for (const t of leafTokens) {
    if (setName.has(t)) {
      count += 1;
      continue;
    }
    for (const u of setName) {
      const minLen = Math.min(t.length, u.length);
      const maxLen = Math.max(t.length, u.length);
      if (minLen < 8) continue;
      if (maxLen - minLen > 3) continue;
      if (t.startsWith(u) || u.startsWith(t)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function tokenOverlapCount(aTokens, bTokens) {
  const setB = new Set(bTokens);
  let count = 0;
  for (const t of aTokens) {
    if (setB.has(t)) {
      count += 1;
      continue;
    }
    for (const u of setB) {
      if (t.length >= 5 && (u.includes(t) || t.includes(u))) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function isBreadcrumb(pathStr) {
  const t = safeString(pathStr);
  return t.includes('>') && t.split('>').map((s) => s.trim()).filter(Boolean).length >= 2;
}

function canonicalBreadcrumb(id) {
  const entry = EBAY_CATEGORIES[String(id).trim()];
  const b = entry?.breadcrumb ? String(entry.breadcrumb).trim() : '';
  return b;
}

function pickSku(product, docId) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(docId);
}

function pickMeaningfulLeafSegment(pathStr = '') {
  const segs = safeString(pathStr).split('>').map((s) => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const s = segs[i];
    const n = normalizeText(s);
    if (!n) continue;
    if (n.startsWith('fur ')) continue;
    if (n === 'fur apple' || n === 'fur iphone' || n === 'fur samsung') continue;
    return s;
  }
  return segs[segs.length - 1] || '';
}

function normalizeLeafForCompare(text = '') {
  const t = normalizeText(text);
  return t
    .replace(/\b(\p{L}{5,})e\b/gu, '$1')
    .replace(/\b(\p{L}{5,})en\b/gu, '$1')
    .replace(/\b(\p{L}{5,})n\b/gu, '$1');
}

function leafCompatible(proposedPath, canonical) {
  const proposedLeaf = normalizeLeafForCompare(pickMeaningfulLeafSegment(proposedPath));
  const canonLeaf = normalizeLeafForCompare(String(canonical || '').split('>').pop() || '');
  if (!proposedLeaf || !canonLeaf) return false;
  if (proposedLeaf.length < 6 || canonLeaf.length < 6) return false;
  return canonLeaf.includes(proposedLeaf) || proposedLeaf.includes(canonLeaf);
}

function matchFromBreadcrumb(breadcrumbText, product) {
  const text = safeString(breadcrumbText);
  if (!isBreadcrumb(text)) return null;
  const segs = text.split('>').map((s) => s.trim()).filter(Boolean);
  const rootKey = normalizeText(segs[0] || '');
  const candidates = EBAY_ROOT_INDEX.get(rootKey) || null;
  if (!candidates) return null; // root doesn't exist in eBay taxonomy

  const leafSeg = pickMeaningfulLeafSegment(text);
  const leafTokens = tokenize(leafSeg);
  if (!leafTokens.length) return null;

  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const signalText = [
    product?.identification?.name,
    attrs?.Produktart,
    attrs?.Produkttyp,
    attrs?.['Produkttyp (Produktart)'],
  ].join(' ');
  const evidenceTokens = tokenize(signalText);

  const normSignals = normalizeText(signalText);
  const wantsMotorcycle = /\bmotorrad\b/.test(normSignals);
  const wantsBicycle = /\bfahrrad\b/.test(normSignals) || /\bradsport\b/.test(normSignals);
  const wantsSportTuning = /\bsport\b/.test(normSignals) || /\btuning\b/.test(normSignals);

  let best = null;
  let bestScore = -1;
  let secondScore = -1;

  for (const c of candidates) {
    if (!c.breadcrumb.includes('>')) continue;
    const nameTokens = tokenize(c.name || (c.breadcrumb.split('>').pop() || ''));
    const leafOverlap = strictLeafOverlapCount(leafTokens, nameTokens);
    if (leafOverlap <= 0) continue;
    const bcTokens = tokenize(c.breadcrumb);
    const overlap = tokenOverlapCount([...tokenize(text), ...evidenceTokens], bcTokens);
    const depth = c.breadcrumb.split('>').map((s) => s.trim()).filter(Boolean).length;

    const bcSegs = c.breadcrumb.split('>').map((s) => s.trim()).filter(Boolean);
    const normBcBody = normalizeText(bcSegs.slice(1).join(' '));
    let bonus = 0;
    if (/\bmit einbau\b/.test(normBcBody) || /\bkfz services\b/.test(normBcBody) || /\breparaturen\b/.test(normBcBody)) bonus -= 25;
    if (!wantsSportTuning && (/\btuning\b/.test(normBcBody) || /\bsport\b/.test(normBcBody))) bonus -= 18;
    if (wantsMotorcycle) {
      if (/\bmotorrad\b/.test(normBcBody)) bonus += 25;
      if (/\bautoteile\b/.test(normBcBody)) bonus -= 10;
    } else if (wantsBicycle) {
      if (/\bfahrrad\b/.test(normBcBody) || /\bradsport\b/.test(normBcBody)) bonus += 25;
      if (/\bautoteile\b/.test(normBcBody) || /\bmotorrad\b/.test(normBcBody)) bonus -= 20;
    } else {
      if (/\bmotorrad\b/.test(normBcBody) || /\bquad\b/.test(normBcBody)) bonus -= 20;
    }

    const score = leafOverlap * 120 + overlap * 10 + depth + bonus;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = { ...c, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best) return null;
  const margin = bestScore - (secondScore >= 0 ? secondScore : 0);
  if (bestScore < 120) return null;
  if (margin < 5) return null;
  const canon = canonicalBreadcrumb(best.id) || best.breadcrumb;
  if (!isBreadcrumb(canon)) return null;
  if (!leafCompatible(text, canon)) return null;
  return { id: String(best.id), breadcrumb: canon, score: bestScore, margin };
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
  const outDir = path.join(process.cwd(), 'exports', 'category-backfill', stamp);
  ensureDir(outDir);

  console.log(`[category-backfill] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);
  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[category-backfill] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[category-backfill] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const report = [];
  const summary = { preCount, targets: 0, update: 0, skip: 0, skipReasons: {} };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const catText = safeString(data?.identification?.category);
    if (!isBreadcrumb(catText)) continue;
    const currentId = safeString(data?.details?.categoryId);
    if (currentId) continue;
    summary.targets += 1;

    const match = matchFromBreadcrumb(catText, data);
    if (!match?.id) {
      summary.skip += 1;
      summary.skipReasons.no_match = (summary.skipReasons.no_match || 0) + 1;
      report.push({ docId: doc.id, sku: pickSku(data, doc.id), status: 'skip', reason: 'no_match', catText });
      continue;
    }

    const updates = {
      'details.categoryId': String(match.id),
      'identification.category': match.breadcrumb,
      'ops.data_quality': {
        ...(data?.ops?.data_quality || {}),
        category_backfilled_by: 'breadcrumb',
        category_backfilled_iso: new Date().toISOString(),
        category_backfilled_from: catText,
        category_backfilled_to: match.breadcrumb,
      },
    };
    summary.update += 1;
    report.push({ docId: doc.id, sku: pickSku(data, doc.id), status: 'update', catText, match, updates: args.apply ? undefined : updates });
  }

  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[category-backfill] summary update=${summary.update} skip=${summary.skip} targets=${summary.targets}`);

  if (!args.apply) {
    console.log('[category-backfill] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[category-backfill] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 250 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[category-backfill] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    if (item.status !== 'update') continue;
    const ref = firestore.collection('products').doc(item.docId);
    const docData = snap.docs.find((d) => d.id === item.docId)?.data() || {};
    const catText = safeString(docData?.identification?.category);
    if (!isBreadcrumb(catText)) continue;
    if (safeString(docData?.details?.categoryId)) continue;
    const match = matchFromBreadcrumb(catText, docData);
    if (!match?.id) continue;
    const updates = {
      'details.categoryId': String(match.id),
      'identification.category': match.breadcrumb,
      'ops.data_quality': {
        ...(docData?.ops?.data_quality || {}),
        category_backfilled_by: 'breadcrumb',
        category_backfilled_iso: new Date().toISOString(),
        category_backfilled_from: catText,
        category_backfilled_to: match.breadcrumb,
      },
    };
    bulkWriter.update(ref, updates);
  }
  await bulkWriter.close();

  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[category-backfill] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[category-backfill] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[category-backfill] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


