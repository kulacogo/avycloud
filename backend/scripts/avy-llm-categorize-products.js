/* eslint-disable no-console */
/**
 * LLM-based categorization of AvyCloud products into the compact Avy taxonomy (255 paths).
 *
 * HARD RULES (no guessing / no invented categories):
 * - Model must return a category path that exists EXACTLY in backend/avy-taxonomy/avy-taxonomy.json
 * - If uncertain: choose the safest "Root > Sonstige" and set low confidence.
 * - We store audit metadata per product so you can review what was used.
 *
 * Writes:
 * - identification.category  (Avy path)
 * - ops.avy_category.*       (audit trail)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/avy-llm-categorize-products.js --dry-run --limit 20
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/avy-llm-categorize-products.js --apply --concurrency 2
 *
 * Options:
 *   --taxonomy <path>         (default: backend/avy-taxonomy/avy-taxonomy.json)
 *   --apply | --dry-run
 *   --limit <n>
 *   --concurrency <n>         (Gemini calls)
 *   --force                  (re-categorize even if already set to a valid Avy path)
 */
const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { Firestore } = require('@google-cloud/firestore');

const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function normalizeForCache(text = '') {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s>:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = {
    taxonomy: path.join(process.cwd(), 'backend', 'avy-taxonomy', 'avy-taxonomy.json'),
    dryRun: true,
    apply: false,
    limit: 0,
    concurrency: 2,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--taxonomy') args.taxonomy = String(argv[i + 1] || ''), i += 1;
    else if (t === '--apply') args.apply = true, args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true, args.apply = false;
    else if (t === '--limit') args.limit = Number(argv[i + 1]), i += 1;
    else if (t === '--concurrency') args.concurrency = Number(argv[i + 1]), i += 1;
    else if (t === '--force') args.force = true;
  }
  return args;
}

function loadTaxonomy(taxonomyPath) {
  const abs = path.isAbsolute(taxonomyPath) ? taxonomyPath : path.join(process.cwd(), taxonomyPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const json = JSON.parse(raw);
  const categories = Array.isArray(json?.categories) ? json.categories.map((x) => normalizeSpaces(x)).filter(Boolean) : [];
  const set = new Set(categories);
  const roots = Array.isArray(json?.roots) ? json.roots.map((x) => normalizeSpaces(x)).filter(Boolean) : [];
  return { abs, categories, set, roots };
}

function pickProductSignals(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const extra =
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object'
      ? product.details.attributes_extra
      : {};
  const ids = product?.details?.identifiers && typeof product.details.identifiers === 'object'
    ? product.details.identifiers
    : {};

  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes.slice(0, 6) : [];
  const images = Array.isArray(product?.details?.images) ? product.details.images.slice(0, 4) : [];

  const currentCategory = safeString(product?.identification?.category);
  const hints = [
    safeString(product?.details?.ebayCategoryPath),
    safeString(product?.details?.kauflandCategoryPath),
    safeString(attrs?.Kategorie),
    safeString(attrs?.category),
  ].filter(Boolean);

  const title = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const description = safeString(product?.details?.description || product?.details?.short_description);
  const mpn = safeString(ids?.mpn || attrs?.MPN || attrs?.Herstellernummer);

  const attrPairs = Object.entries(attrs)
    .slice(0, 70)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' | ');
  const extraPairs = Object.entries(extra)
    .slice(0, 30)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' | ');

  return {
    title,
    brand,
    description,
    mpn,
    barcodes,
    images,
    currentCategory,
    hintCategories: hints.slice(0, 4),
    attrsPreview: attrPairs,
    extraPreview: extraPairs,
  };
}

function buildPrompt(signals, allowedCategories) {
  // Keep it strict: must choose exact allowed path.
  return [
    'Du bist ein strenger Produkt-Kategorisierer für AvyCloud.',
    'Deine Aufgabe: Wähle GENAU EINEN passenden Kategoriepfad aus der Avy-Taxonomie (Whitelist).',
    '',
    'Harte Regeln:',
    '- Antworte NUR als JSON (kein Markdown, keine Erklärungen außerhalb JSON).',
    '- "path" MUSS exakt einem Eintrag aus ALLOWED_CATEGORIES entsprechen (identische Schreibweise).',
    '- Erfinde KEINE Kategorien und ändere KEINE Schreibweise.',
    '- Nutze NUR die Produktdaten unten (keine externen Quellen).',
    '- Wenn du nicht sicher bist: wähle den sichersten Pfad "Root > Sonstige" und setze confidence <= 0.50.',
    '',
    'JSON Schema:',
    '{ "path": string, "confidence": number, "used_fields": string[], "reason": string }',
    '',
    `Titel: ${signals.title || '–'}`,
    `Marke: ${signals.brand || '–'}`,
    `MPN/OEM: ${signals.mpn || '–'}`,
    `Barcodes: ${signals.barcodes.join(', ') || '–'}`,
    `Beschreibung: ${signals.description ? signals.description.slice(0, 1200) : '–'}`,
    `Hinweis-Kategorien (nur Hinweis, evtl. falsch): ${signals.hintCategories.join(' | ') || '–'}`,
    `Aktuelle Kategorie (falls vorhanden): ${signals.currentCategory || '–'}`,
    `Attribute: ${signals.attrsPreview || '–'}`,
    `Extra-Attribute: ${signals.extraPreview || '–'}`,
    `Bilder (URLs, Hinweis): ${signals.images.map((u) => String(u).slice(0, 160)).join(' | ') || '–'}`,
    '',
    'ALLOWED_CATEGORIES (du MUSST exakt einen davon zurückgeben):',
    allowedCategories.map((c) => `- ${c}`).join('\n'),
  ].join('\n');
}

function scoreRoot(root, text) {
  const t = normalizeForCache(text);
  const r = normalizeForCache(root);
  if (!t || !r) return 0;
  let score = 0;
  // Direct root word overlap
  const rootTokens = new Set(r.split(/\s+/g).filter((w) => w.length >= 4));
  for (const tok of rootTokens) {
    if (t.includes(tok)) score += 2;
  }
  // Keyword hints per root (small, high-signal)
  const has = (re) => re.test(t);
  if (root === 'Auto & Motorrad') {
    if (has(/\b(kfz|motorrad|auto|fahrzeug|felge|bremse|kupplung|motor)\b/)) score += 6;
  } else if (root === 'Elektronik') {
    if (has(/\b(elektronik|hifi|audio|kopfhoerer|kopfhörer|tv|monitor|kamera|smartphone|telefon|laptop|pc)\b/)) score += 6;
  } else if (root === 'Mode & Accessoires') {
    if (has(/\b(bekleidung|kleidung|schuhe|hose|shirt|jacke|tasche|guertel|gürtel)\b/)) score += 6;
  } else if (root === 'Haushalt & Küche') {
    if (has(/\b(kueche|küche|topf|pfanne|besteck|geschirr|haushalt|reinigung)\b/)) score += 6;
  } else if (root === 'Heimwerker & Garten') {
    if (has(/\b(werkzeug|bohrer|schraube|akku|rasen|garten|säge|hammer)\b/)) score += 6;
  } else if (root === 'Sport & Outdoor') {
    if (has(/\b(sport|fitness|yoga|camping|outdoor|fahrrad|helm)\b/)) score += 6;
  } else if (root === 'Baby & Kind') {
    if (has(/\b(baby|kind|kinder|wickel|spielmatte|kinderwagen)\b/)) score += 6;
  } else if (root === 'Beauty & Gesundheit') {
    if (has(/\b(kosmetik|pflege|gesundheit|hygiene|creme|vitamin)\b/)) score += 6;
  } else if (root === 'Tierbedarf') {
    if (has(/\b(tier|hund|katze|futter|leckerli|leine)\b/)) score += 6;
  }
  return score;
}

function pickTopRoots(roots, signals) {
  const text = [
    signals.title,
    signals.brand,
    signals.mpn,
    signals.description,
    signals.currentCategory,
    signals.hintCategories.join(' '),
    signals.attrsPreview,
  ].join(' ');
  const ranked = roots
    .map((r) => ({ r, s: scoreRoot(r, text) }))
    .sort((a, b) => b.s - a.s || a.r.localeCompare(b.r, 'de-DE'));
  const top = ranked
    .filter((x) => x.s > 0)
    .slice(0, 2)
    .map((x) => x.r);
  if (top.length) return top;
  // fallback heuristic
  const fallback = rootSonstigeFallback(roots, text).split('>')[0].trim();
  return [fallback].filter(Boolean);
}

function pickAllowedSubset(allCategories, roots, signals, max = 70) {
  const topRoots = pickTopRoots(roots, signals);
  const subset = [];
  for (const root of topRoots) {
    const items = allCategories.filter((c) => c === root || c.startsWith(`${root} > `));
    subset.push(...items);
  }
  // Always ensure root>Sonstige exists for selected roots
  for (const root of topRoots) {
    const s = `${root} > Sonstige`;
    if (!subset.includes(s)) subset.push(s);
  }
  // Dedup + cap
  const deduped = Array.from(new Set(subset));
  // Prefer deeper paths first (helps specificity)
  deduped.sort((a, b) => {
    const da = a.split('>').filter(Boolean).length;
    const db = b.split('>').filter(Boolean).length;
    if (da !== db) return db - da;
    return a.localeCompare(b, 'de-DE');
  });
  return deduped.slice(0, Math.max(10, Math.floor(max)));
}

async function withTimeout(promise, ms, label = 'timeout') {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function rootSonstigeFallback(roots, text) {
  const t = normalizeForCache(text || '');
  const has = (re) => re.test(t);
  const pick = (root) => (roots.includes(root) ? root : roots[0] || 'Mode & Accessoires');
  if (has(/\b(auto|motorrad|kfz|fahrzeug)\b/)) return `${pick('Auto & Motorrad')} > Sonstige`;
  if (has(/\b(baby|kind|kinder)\b/)) return `${pick('Baby & Kind')} > Sonstige`;
  if (has(/\b(beauty|kosmetik|pflege|gesundheit|hygiene)\b/)) return `${pick('Beauty & Gesundheit')} > Sonstige`;
  if (has(/\b(industrie|gewerbe|business)\b/)) return `${pick('Business & Industrie')} > Sonstige`;
  if (has(/\b(elektronik|computer|hifi|audio|tv|kamera|smartphone|telefon)\b/)) return `${pick('Elektronik')} > Sonstige`;
  if (has(/\b(kueche|küche|haushalt|kochen)\b/)) return `${pick('Haushalt & Küche')} > Sonstige`;
  if (has(/\b(heimwerker|garten|baumarkt|werkzeug)\b/)) return `${pick('Heimwerker & Garten')} > Sonstige`;
  if (has(/\b(mode|bekleidung|kleidung|schuhe|tasche|accessoire)\b/)) return `${pick('Mode & Accessoires')} > Sonstige`;
  if (has(/\b(mobel|möbel|wohnen)\b/)) return `${pick('Möbel & Wohnen')} > Sonstige`;
  if (has(/\b(musik|instrument)\b/)) return `${pick('Musik & Instrumente')} > Sonstige`;
  if (has(/\b(sport|outdoor|fitness|camping)\b/)) return `${pick('Sport & Outdoor')} > Sonstige`;
  if (has(/\b(spielzeug|spielwaren)\b/)) return `${pick('Spielwaren')} > Sonstige`;
  if (has(/\b(antiquitat|antiquität|sammeln|kunst|munzen|münzen)\b/)) return `${pick('Sammeln & Kunst')} > Sonstige`;
  if (has(/\b(buro|büro|schreibwaren)\b/)) return `${pick('Büro & Schreibwaren')} > Sonstige`;
  if (has(/\b(buch|bücher|dvd|blu-ray|film)\b/)) return `${pick('Bücher & Medien')} > Sonstige`;
  if (has(/\b(tier|haustier)\b/)) return `${pick('Tierbedarf')} > Sonstige`;
  if (has(/\b(reise|koffer|gepack|gepäck)\b/)) return `${pick('Reisen & Gepäck')} > Sonstige`;
  return `${pick(roots[0])} > Sonstige`;
}

async function resolveAvyCategoryWithGemini({ prompt }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'AVY_CATEGORY_MODEL', 'gemini-2.5-flash');
  const model = client.getGenerativeModel({ model: modelName });

  const generationConfig = {
    temperature: 0.1,
    topP: 0.95,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        confidence: { type: 'number' },
        used_fields: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['path', 'confidence'],
    },
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });

  const json = JSON.parse(result.response.text());
  return {
    path: safeString(json?.path),
    confidence: typeof json?.confidence === 'number' ? json.confidence : Number(json?.confidence || 0),
    used_fields: Array.isArray(json?.used_fields) ? json.used_fields.map((x) => safeString(x)).filter(Boolean) : [],
    reason: safeString(json?.reason),
    model: modelName,
  };
}

function isValidAvyPath(candidate, taxonomySet) {
  const c = normalizeSpaces(candidate);
  return c && taxonomySet.has(c);
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'avy-category-llm', stamp);
  ensureDir(outDir);

  const { abs: taxonomyFile, categories, set: taxonomySet, roots } = loadTaxonomy(args.taxonomy);
  const allAllowed = categories; // already normalized

  console.log(
    JSON.stringify(
      {
        action: 'avy-llm-categorize-products',
        project: PROJECT_ID,
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        taxonomyFile,
        allowedCategories: categories.length,
        limit: args.limit || 0,
        concurrency: Math.max(1, args.concurrency || 2),
        force: Boolean(args.force),
        outDir,
      },
      null,
      2
    )
  );

  const snap = await firestore.collection('products').get();
  const docs = args.limit && args.limit > 0 ? snap.docs.slice(0, Math.floor(args.limit)) : snap.docs;
  console.log(`[avy-llm] products_total=${snap.size} processing=${docs.length}`);

  const cache = new Map(); // key -> {path,confidence,...}
  const report = [];

  const queue = new PQueue({ concurrency: Math.max(1, Math.floor(args.concurrency || 2)) });

  const runOne = async (doc) => {
    const product = doc.data() || {};
    const current = normalizeSpaces(product?.identification?.category);
    const alreadyValid = current && taxonomySet.has(current);
    if (alreadyValid && !args.force) {
      return {
        docId: doc.id,
        status: 'skip',
        reason: 'already_valid_avy_category',
        category_before: current,
        category_after: current,
      };
    }

    const signals = pickProductSignals(product);
    const cacheKey = normalizeForCache(
      [
        signals.title,
        signals.brand,
        signals.mpn,
        signals.barcodes.join(','),
        signals.hintCategories.join('|'),
      ].join('||')
    );

    if (cacheKey && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      return {
        docId: doc.id,
        status: 'update',
        via: 'cache',
        category_before: current || null,
        category_after: cached.path,
        confidence: cached.confidence,
        model: cached.model,
        used_fields: cached.used_fields,
        reasonText: cached.reason,
      };
    }

    const allowedSubset = pickAllowedSubset(allAllowed, roots, signals, 70);
    const prompt = buildPrompt(signals, allowedSubset);

    let resolved = null;
    let attempts = 0;
    let lastError = '';
    while (attempts < 2) {
      attempts += 1;
      try {
        const res = await withTimeout(resolveAvyCategoryWithGemini({ prompt }), 45_000, 'gemini_timeout');
        resolved = res;
        break;
      } catch (e) {
        lastError = e?.message || String(e);
      }
    }

    let chosen = normalizeSpaces(resolved?.path || '');
    const conf = Number.isFinite(resolved?.confidence) ? Math.max(0, Math.min(1, resolved.confidence)) : 0;
    const reasonText = safeString(resolved?.reason);
    const model = safeString(resolved?.model);

    if (!isValidAvyPath(chosen, taxonomySet)) {
      // Absolute safety fallback: root > Sonstige
      const fallback = rootSonstigeFallback(roots, `${signals.title} ${signals.brand} ${signals.description} ${signals.hintCategories.join(' ')}`);
      chosen = isValidAvyPath(fallback, taxonomySet) ? fallback : `${roots[0] || 'Mode & Accessoires'} > Sonstige`;
      return {
        docId: doc.id,
        status: 'update',
        via: 'fallback',
        reason: 'invalid_llm_path_not_in_taxonomy',
        error: lastError || null,
        category_before: current || null,
        category_after: chosen,
        confidence: Math.min(conf || 0.25, 0.5),
        model,
        used_fields: resolved?.used_fields || [],
        reasonText: reasonText || 'LLM returned an invalid path; fallback applied.',
      };
    }

    const out = {
      docId: doc.id,
      status: 'update',
      via: 'llm',
      category_before: current || null,
      category_after: chosen,
      confidence: conf,
      model,
      used_fields: resolved?.used_fields || [],
      reasonText,
    };
    if (cacheKey) cache.set(cacheKey, out);
    return out;
  };

  for (const doc of docs) {
    queue.add(async () => {
      const res = await runOne(doc);
      report.push(res);
      if (report.length % 25 === 0) {
        const updates = report.filter((r) => r.status === 'update').length;
        const skips = report.filter((r) => r.status === 'skip').length;
        console.log(`[avy-llm] progress=${report.length}/${docs.length} update=${updates} skip=${skips}`);
      }
    });
  }

  await queue.onIdle();

  const summary = {
    total: docs.length,
    update: report.filter((r) => r.status === 'update').length,
    skip: report.filter((r) => r.status === 'skip').length,
    via: {
      llm: report.filter((r) => r.via === 'llm').length,
      cache: report.filter((r) => r.via === 'cache').length,
      fallback: report.filter((r) => r.via === 'fallback').length,
    },
    avgConfidence:
      report.filter((r) => r.status === 'update' && Number.isFinite(r.confidence)).reduce((a, r) => a + r.confidence, 0) /
      Math.max(1, report.filter((r) => r.status === 'update' && Number.isFinite(r.confidence)).length),
  };

  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('[avy-llm] summary', JSON.stringify(summary, null, 2));

  if (!args.apply) {
    console.log('[avy-llm] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[avy-llm] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 10, maxOpsPerSecond: 50 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[avy-llm] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  const nowIso = new Date().toISOString();
  let applied = 0;
  for (const item of report) {
    if (item.status !== 'update') continue;
    const updates = {
      'identification.category': item.category_after,
      'ops.avy_category': {
        by: item.via === 'llm' ? 'gemini' : item.via,
        model: item.model || null,
        confidence: Number.isFinite(item.confidence) ? item.confidence : null,
        reason: item.reasonText || null,
        used_fields: Array.isArray(item.used_fields) ? item.used_fields.slice(0, 20) : [],
        updated_iso: nowIso,
        previous: item.category_before || null,
      },
    };
    bulkWriter.update(firestore.collection('products').doc(item.docId), updates);
    applied += 1;
  }
  await bulkWriter.close();
  console.log(`[avy-llm] applied=${applied}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

