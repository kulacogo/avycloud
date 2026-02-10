/* eslint-disable no-console */
/**
 * Refine eBay categories to full breadcrumb paths using Gemini + canonical taxonomy validation.
 *
 * Why:
 * - Many products currently have leaf-only or top-level categories (no '>') which is inconsistent and too broad.
 * - We want a consistent category tree path for BaseLinker / exports / UI.
 *
 * Safety:
 * - We only apply if:
 *   - Gemini returns a breadcrumb-like path (contains '>')
 *   - that path maps to a VALID eBay category id via MarketplaceLookup
 *   - and the canonical breadcrumb for that id (from ebay-data/categories.json) also contains '>'
 * - No document create/delete; update-only with pre/post count guard.
 *
 * Usage:
 *   node backend/scripts/refine-ebay-categories-with-gemini.js --dry-run
 *   node backend/scripts/refine-ebay-categories-with-gemini.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { Firestore } = require('@google-cloud/firestore');

const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
// NOTE: We intentionally do NOT rely on exact-path matching here.
// We map Gemini's breadcrumb-like output to the closest canonical eBay category using the local categories.json.

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const EBAY_CATEGORIES = JSON.parse(fs.readFileSync(EBAY_CATEGORIES_JSON, 'utf8'));

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

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isBreadcrumb(pathStr) {
  const t = safeString(pathStr);
  return t.includes('>') && t.split('>').map((s) => s.trim()).filter(Boolean).length >= 2;
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

function pickMeaningfulLeafSegment(pathStr = '') {
  const segs = safeString(pathStr)
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  // From end: skip brand/device filter segments like "Für Apple" / "Für iPhone"
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

function tokenOverlapCount(aTokens, bTokens) {
  const setB = new Set(bTokens);
  let count = 0;
  for (const t of aTokens) {
    if (setB.has(t)) {
      count += 1;
      continue;
    }
    // singular/plural / compounding tolerance
    for (const u of setB) {
      if (t.length >= 5 && (u.includes(t) || t.includes(u))) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function strictLeafOverlapCount(leafTokens, nameTokens) {
  const setName = new Set(nameTokens);
  let count = 0;
  for (const t of leafTokens) {
    if (setName.has(t)) {
      count += 1;
      continue;
    }
    // Allow very close prefix matches (bremsscheibe vs bremsscheiben), but avoid generic substrings (scheiben).
    for (const u of setName) {
      const a = t;
      const b = u;
      const minLen = Math.min(a.length, b.length);
      const maxLen = Math.max(a.length, b.length);
      if (minLen < 8) continue;
      if (maxLen - minLen > 3) continue;
      if (a.startsWith(b) || b.startsWith(a)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function matchCanonicalEbayCategory(proposedPath, product) {
  const text = safeString(proposedPath);
  if (!text) return null;
  const segs = text.split('>').map((s) => s.trim()).filter(Boolean);
  const rootSeg = segs[0] || '';
  const rootKey = normalizeText(rootSeg);
  const candidates = (rootKey && EBAY_ROOT_INDEX.get(rootKey)) ? EBAY_ROOT_INDEX.get(rootKey) : EBAY_CATEGORY_LIST;

  const leafSeg = pickMeaningfulLeafSegment(text);
  const leafTokens = tokenize(leafSeg);
  // Exclude the root segment from tokens to avoid biasing toward "Motorrad" due to the top-level label.
  const proposedBody = segs.slice(1).join(' ');
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const signalText = [
    product?.identification?.name,
    attrs?.Produktart,
    attrs?.Produkttyp,
    attrs?.['Produkttyp (Produktart)'],
    // NOTE: do NOT include existing category label here (it often contains the word "Motorrad" due to the top-level root)
  ].join(' ');
  const evidenceText = `${signalText} ${safeString(product?.identification?.category)}`;
  const allTokens = tokenize(`${proposedBody} ${evidenceText}`);
  if (!leafTokens.length) return null;

  const normSignals = normalizeText(signalText);
  const wantsMotorcycle = /\bmotorrad\b/.test(normSignals);
  const wantsBicycle = /\bfahrrad\b/.test(normSignals) || /\bradsport\b/.test(normSignals);
  const wantsSportTuning = /\bsport\b/.test(normSignals) || /\btuning\b/.test(normSignals);

  let best = null;
  let bestScore = -1;
  let secondScore = -1;

  for (const c of candidates) {
    // We only accept real breadcrumbs (at least 2 levels)
    if (!c.breadcrumb.includes('>')) continue;
    const nameTokens = tokenize(c.name || (c.breadcrumb.split('>').pop() || ''));
    const leafOverlap = strictLeafOverlapCount(leafTokens, nameTokens);
    if (leafOverlap <= 0) continue;
    const bcTokens = tokenize(c.breadcrumb);
    const allOverlap = tokenOverlapCount(allTokens, bcTokens);
    const depth = c.breadcrumb.split('>').map((s) => s.trim()).filter(Boolean).length;
    const bcSegs = c.breadcrumb.split('>').map((s) => s.trim()).filter(Boolean);
    const normBcBody = normalizeText(bcSegs.slice(1).join(' '));
    let bonus = 0;
    // Avoid service/install categories unless explicitly asked for.
    if (/\bmit einbau\b/.test(normBcBody) || /\bkfz services\b/.test(normBcBody) || /\breparaturen\b/.test(normBcBody)) bonus -= 25;
    // Avoid tuning/sport branches unless product signals it.
    if (!wantsSportTuning && (/\btuning\b/.test(normBcBody) || /\bsport\b/.test(normBcBody))) bonus -= 18;
    if (wantsMotorcycle) {
      if (/\bmotorrad\b/.test(normBcBody)) bonus += 25;
      if (/\bautoteile\b/.test(normBcBody)) bonus -= 10;
    } else if (wantsBicycle) {
      if (/\bfahrrad\b/.test(normBcBody) || /\bradsport\b/.test(normBcBody)) bonus += 25;
      if (/\bautoteile\b/.test(normBcBody) || /\bmotorrad\b/.test(normBcBody)) bonus -= 20;
    } else {
      // Default: favor car parts over motorcycle/quad branches when not explicitly motorcycle/bicycle.
      if (/\bmotorrad\b/.test(normBcBody) || /\bquad\b/.test(normBcBody)) bonus -= 20;
    }

    const score = leafOverlap * 120 + allOverlap * 12 + depth + bonus;

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = { ...c, score, leafOverlap, allOverlap, depth };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best) return null;
  const margin = bestScore - (secondScore >= 0 ? secondScore : 0);
  // Conservative acceptance thresholds.
  if (best.leafOverlap < 1) return null;
  if (bestScore < 120) return null;
  // Some leaf categories exist in multiple branches (auto vs motorcycle vs bicycle). We rely on token overlap to break ties,
  // so the margin can be small even when the match is correct.
  if (margin < 5) return null;
  return { id: best.id, breadcrumb: best.breadcrumb, score: bestScore, margin, meta: best };
}

function normalizeLeafForCompare(text = '') {
  const t = normalizeText(text);
  // cheap plural normalization
  return t
    .replace(/\b(\p{L}{5,})e\b/gu, '$1') // scheibe/scheiben
    .replace(/\b(\p{L}{5,})en\b/gu, '$1')
    .replace(/\b(\p{L}{5,})n\b/gu, '$1');
}

function leafCompatible(proposedPath, canonical) {
  const proposedLeaf = normalizeLeafForCompare(pickMeaningfulLeafSegment(proposedPath));
  const canonLeaf = normalizeLeafForCompare(String(canonical || '').split('>').pop() || '');
  if (!proposedLeaf || !canonLeaf) return false;
  // Require a fairly specific overlap (avoid generic token like "maus").
  if (proposedLeaf.length < 6 || canonLeaf.length < 6) return false;
  return canonLeaf.includes(proposedLeaf) || proposedLeaf.includes(canonLeaf);
}

function hasEvidenceForBreadcrumb(product, breadcrumb) {
  const leaf = safeString(String(breadcrumb || '').split('>').pop() || '');
  const leafTokens = new Set(tokenize(leaf));
  if (!leafTokens.size) return false;

  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const evidenceText = [
    product?.identification?.name,
    product?.details?.attributes?.Produktart,
    product?.details?.attributes?.Produkttyp,
    product?.details?.attributes?.['Produkttyp (Produktart)'],
    product?.identification?.category,
    Object.entries(attrs)
      .slice(0, 40)
      .map(([k, v]) => `${k} ${v}`)
      .join(' '),
  ].join(' ');

  const evidenceTokens = new Set(tokenize(evidenceText));
  for (const t of leafTokens) {
    if (evidenceTokens.has(t)) return true;
    // allow substring match for singular/plural (bremsscheibe vs bremsscheiben)
    for (const e of evidenceTokens) {
      if (e.length >= 5 && (e.includes(t) || t.includes(e))) return true;
    }
  }
  return false;
}

function canonicalBreadcrumb(id) {
  const entry = EBAY_CATEGORIES[String(id).trim()];
  const b = entry?.breadcrumb ? String(entry.breadcrumb).trim() : '';
  return b;
}

function pickSku(product, docId) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(docId);
}

function shouldRefine(product) {
  const cat = safeString(product?.identification?.category);
  const catId = safeString(product?.details?.categoryId);
  if (!catId) return true; // missing id
  const b = canonicalBreadcrumb(catId);
  if (!b) return true;
  if (!b.includes('>')) return true; // too broad / top-level
  if (!cat.includes('>')) return true; // leaf-only text still stored
  return false;
}

function buildPrompt(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const attrPairs = Object.entries(attrs)
    .slice(0, 60)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join(' | ');
  const title = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const currentCat = safeString(product?.identification?.category);
  const mpn = safeString(product?.details?.identifiers?.mpn);
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes.slice(0, 5) : [];

  return [
    'Du bist ein eBay.de Kategorie-Assistent. Wähle die BESTE und MÖGLICHST SPEZIFISCHE Kategorie als Breadcrumb-Pfad.',
    'WICHTIG:',
    '- Gib NUR JSON zurück: { "path": "A > B > C" }',
    '- Der Pfad MUSS mindestens 2 Ebenen haben (muss ">" enthalten).',
    '- Verwende nach Möglichkeit exakte Bezeichnungen aus dem eBay Kategoriebaum (deutsch).',
    '- Keine IDs, keine erfundenen Kategorien, keine Erklärungen.',
    '- Nutze nur die folgenden Produktdaten (keine externen Quellen).',
    '',
    `Titel: ${title || '–'}`,
    `Marke: ${brand || '–'}`,
    `MPN/OEM: ${mpn || '–'}`,
    `Barcode: ${barcodes.join(', ') || '–'}`,
    `Aktuelle Kategorie (falls vorhanden): ${currentCat || '–'}`,
    `Attribute: ${attrPairs || '–'}`,
  ].join('\n');
}

async function resolveWithGemini(product) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'CATEGORY_MODEL', 'gemini-3-pro-preview');
  const model = client.getGenerativeModel({ model: modelName });

  const generationConfig = {
    temperature: 0.2,
    topP: 0.95,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  };

  const prompt = buildPrompt(product);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });
  const json = JSON.parse(result.response.text());
  const pathStr = safeString(json?.path);
  return pathStr;
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: 420, limit: 0, concurrency: 2 };
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
    if (t === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'category-refine', stamp);
  ensureDir(outDir);

  console.log(`[category-refine] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[category-refine] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[category-refine] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const targets = snap.docs
    .map((doc) => ({ doc, data: doc.data() || {} }))
    .filter(({ data }) => shouldRefine(data));

  const limitedTargets = args.limit > 0 ? targets.slice(0, args.limit) : targets;
  console.log(`[category-refine] targets=${targets.length} (processing=${limitedTargets.length})`);

  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency || 2) });
  const report = [];

  const runOne = async ({ doc, data }) => {
    const sku = pickSku(data, doc.id);
    const currentId = safeString(data?.details?.categoryId);
    const currentBreadcrumb = currentId ? canonicalBreadcrumb(currentId) : '';
    const currentCatText = safeString(data?.identification?.category);
    try {
      const proposedPath = await resolveWithGemini(data);
      if (!isBreadcrumb(proposedPath)) {
        return { docId: doc.id, sku, status: 'skip', reason: 'gemini_path_not_breadcrumb', proposedPath };
      }
      const resolved = matchCanonicalEbayCategory(proposedPath, data);
      if (!resolved?.id) {
        return { docId: doc.id, sku, status: 'skip', reason: 'path_not_in_taxonomy', proposedPath };
      }
      const canon = canonicalBreadcrumb(resolved.id) || safeString(resolved.breadcrumb) || '';
      if (!isBreadcrumb(canon)) {
        return { docId: doc.id, sku, status: 'skip', reason: 'canonical_breadcrumb_too_broad', proposedPath, resolvedId: String(resolved.id), canonical: canon };
      }
      if (!leafCompatible(proposedPath, canon)) {
        return { docId: doc.id, sku, status: 'skip', reason: 'leaf_mismatch', proposedPath, resolvedId: String(resolved.id), canonical: canon };
      }
      // Extra safety: require that the chosen leaf category is supported by product text/attributes.
      if (!hasEvidenceForBreadcrumb(data, canon)) {
        return { docId: doc.id, sku, status: 'skip', reason: 'no_product_evidence_for_leaf', proposedPath, resolvedId: String(resolved.id), canonical: canon };
      }
      // If no change, skip
      if (String(resolved.id) === currentId && currentBreadcrumb === canon && currentCatText.includes('>')) {
        return { docId: doc.id, sku, status: 'noop', resolvedId: String(resolved.id), canonical: canon };
      }
      const updates = {
        'details.categoryId': String(resolved.id),
        'identification.category': canon,
        'ops.data_quality': {
          ...(data?.ops?.data_quality || {}),
          category_refined_by: 'gemini',
          category_refined_iso: new Date().toISOString(),
          category_refined_from: currentBreadcrumb || currentCatText || null,
          category_refined_to: canon,
        },
      };
      return { docId: doc.id, sku, status: 'update', proposedPath, resolvedId: String(resolved.id), canonical: canon, updates };
    } catch (err) {
      return { docId: doc.id, sku, status: 'error', reason: err?.message || String(err) };
    }
  };

  for (const target of limitedTargets) {
    queue.add(async () => {
      const res = await runOne(target);
      report.push(res);
    });
  }
  await queue.onIdle();

  const summary = {
    preCount,
    targets: targets.length,
    processed: limitedTargets.length,
    update: report.filter((r) => r.status === 'update').length,
    noop: report.filter((r) => r.status === 'noop').length,
    skip: report.filter((r) => r.status === 'skip').length,
    error: report.filter((r) => r.status === 'error').length,
    skipReasons: {},
  };
  report
    .filter((r) => r.status === 'skip')
    .forEach((r) => {
      summary.skipReasons[r.reason] = (summary.skipReasons[r.reason] || 0) + 1;
    });

  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[category-refine] summary update=${summary.update} noop=${summary.noop} skip=${summary.skip} error=${summary.error}`);

  if (!args.apply) {
    console.log('[category-refine] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[category-refine] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 10, maxOpsPerSecond: 50 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[category-refine] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    if (item.status !== 'update' || !item.updates) continue;
    const ref = firestore.collection('products').doc(item.docId);
    bulkWriter.update(ref, item.updates);
  }
  await bulkWriter.close();

  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[category-refine] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[category-refine] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[category-refine] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


