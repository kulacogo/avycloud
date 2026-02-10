/* eslint-disable no-console */
/**
 * Assign BaseLinker inventory categories (91387 + 91388) to AvyCloud products with qty >= 1.
 *
 * Writes:
 * - details.baselinkerCategories.{inventoryId} = "<breadcrumb path>"
 * - ops.data_quality.baselinker_category_assignment_v1.{inventoryId} = audit metadata
 * - ops.last_saved_source / ops.last_saved_iso / ops.revision++ / ops.sync_status='pending'
 *
 * HARD RULES:
 * - Categories are a strict whitelist per inventory (from bl_nventory_cat.xlsx).
 * - LLM must pick EXACTLY one path from a provided shortlist (no invention).
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/baselinker-assign-inventory-categories-llm-minqty.js --dry-run --limit 10
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/baselinker-assign-inventory-categories-llm-minqty.js --apply --concurrency 2
 *
 * Options:
 *   --apply | --dry-run
 *   --limit <n>
 *   --concurrency <n>         (Gemini calls)
 *   --force                  (re-categorize even if already set to a valid leaf path)
 *   --min-qty <n>            (default 1)
 *   --inventory-ids <csv>    (default "91387,91388")
 *   --candidates <n>         (default 60)
 */

const PQueue = require('p-queue').default || require('p-queue');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
const {
  getInventoryCategoryIndex,
} = require('../lib/baselinker-inventory-category-source');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeForToken(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s>:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'und',
  'oder',
  'fur',
  'für',
  'mit',
  'ohne',
  'the',
  'a',
  'an',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einer',
  'eines',
  'in',
  'im',
  'am',
  'zu',
  'vom',
  'von',
  'aus',
  'auf',
  'bei',
  'nach',
  'ist',
  'sind',
  'set',
  'für',
]);

function tokenize(text = '') {
  const t = normalizeForToken(text);
  if (!t) return [];
  const tokens = t.match(/[\p{L}\p{N}]{2,}/gu) || [];
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    const tok = raw.trim();
    if (!tok) continue;
    if (STOPWORDS.has(tok)) continue;
    if (tok.length < 2) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    limit: 0,
    concurrency: 2,
    force: false,
    minQty: 1,
    inventoryIds: ['91387', '91388'],
    candidates: 60,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') args.apply = true, args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true, args.apply = false;
    else if (t === '--limit') args.limit = Number(argv[i + 1] || 0), i += 1;
    else if (t === '--concurrency') args.concurrency = Number(argv[i + 1] || 2), i += 1;
    else if (t === '--force') args.force = true;
    else if (t === '--min-qty') args.minQty = Number(argv[i + 1] || 1), i += 1;
    else if (t === '--inventory-ids') {
      const raw = String(argv[i + 1] || '');
      args.inventoryIds = raw.split(',').map((x) => x.trim()).filter(Boolean);
      i += 1;
    } else if (t === '--candidates') args.candidates = Number(argv[i + 1] || 60), i += 1;
  }
  args.limit = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  args.concurrency = Number.isFinite(args.concurrency) ? Math.max(1, Math.floor(args.concurrency)) : 2;
  args.minQty = Number.isFinite(args.minQty) ? Math.max(0, Math.floor(args.minQty)) : 1;
  args.candidates = Number.isFinite(args.candidates) ? Math.max(10, Math.min(200, Math.floor(args.candidates))) : 60;
  args.inventoryIds = Array.from(new Set(args.inventoryIds.map((x) => String(x).trim()).filter(Boolean)));
  return args;
}

function pickTotalQuantity(product) {
  // Prefer explicit bin quantities if present
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  if (bins.length) {
    const sum = bins.reduce((acc, b) => acc + (Number(b?.quantity) || 0), 0);
    if (Number.isFinite(sum) && sum > 0) return sum;
  }
  const candidates = [
    product?.inventory?.quantity,
    product?.storage?.quantity,
    product?.details?.attributes?.stock,
    product?.details?.attributes?.quantity,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
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
  const ids =
    product?.details?.identifiers && typeof product.details.identifiers === 'object'
      ? product.details.identifiers
      : {};

  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes.slice(0, 6) : [];
  const title = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const description = safeString(product?.details?.description || product?.details?.short_description);
  const mpn = safeString(ids?.mpn || attrs?.MPN || attrs?.Herstellernummer);
  const hintCategories = [
    safeString(product?.identification?.category),
    safeString(product?.details?.ebayCategoryPath),
    safeString(product?.details?.kauflandCategoryPath),
  ].filter(Boolean);

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
    hintCategories: hintCategories.slice(0, 4),
    attrsPreview: attrPairs,
    extraPreview: extraPairs,
  };
}

function buildTokenIndex(leafPaths) {
  const tokenToIdxs = new Map(); // token -> number[]
  for (let i = 0; i < leafPaths.length; i += 1) {
    const p = leafPaths[i];
    const toks = tokenize(p);
    for (const tok of toks) {
      const arr = tokenToIdxs.get(tok);
      if (arr) arr.push(i);
      else tokenToIdxs.set(tok, [i]);
    }
  }
  return tokenToIdxs;
}

function pickFallbackFromShortlist(shortlist = [], inventoryInfo = null) {
  const items = Array.isArray(shortlist) ? shortlist.filter(Boolean) : [];
  // Prefer a safe "Sonstige" leaf if it exists in the shortlist.
  const sonstige = items.find((p) => /sonstig/i.test(String(p)));
  if (sonstige) return String(sonstige);
  if (items.length) return String(items[0]);
  // Last resort: inventory-wide fallback
  const invFallback = inventoryInfo?.fallbackLeaf || '';
  return invFallback ? String(invFallback) : '';
}

function canonicalizeLeafPath(rawPath, inventoryInfo) {
  const raw = safeString(rawPath);
  if (!raw) return '';
  const key = normalizeForToken(raw);
  const mapped = inventoryInfo?.leafKeyToPath?.get?.(key);
  return mapped || raw;
}

function shortlistCandidates({ leafPaths, tokenIndex, productText, max = 60 }) {
  const toks = tokenize(productText);
  const scores = new Map(); // idx -> score
  for (const tok of toks) {
    const idxs = tokenIndex.get(tok);
    if (!idxs) continue;
    for (const idx of idxs) {
      scores.set(idx, (scores.get(idx) || 0) + 1);
    }
  }
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(10, max))
    .map(([idx]) => leafPaths[idx])
    .filter(Boolean);
  return Array.from(new Set(ranked)).slice(0, max);
}

function buildPrompt({ inventoryId, signals, candidates }) {
  return [
    `Du bist ein strenger Produkt-Kategorisierer für BaseLinker Inventory ${inventoryId}.`,
    'Deine Aufgabe: Wähle GENAU EINEN passenden Kategoriepfad aus der Whitelist (ALLOWED_CATEGORIES).',
    '',
    'Harte Regeln:',
    '- Antworte NUR als JSON (kein Markdown).',
    '- "path" MUSS exakt einem Eintrag aus ALLOWED_CATEGORIES entsprechen (identische Schreibweise).',
    '- Erfinde KEINE Kategorien und ändere KEINE Schreibweise.',
    '- Nutze NUR die Produktdaten unten (keine externen Quellen).',
    '- Wenn du unsicher bist, wähle den sichersten Pfad aus der Whitelist und setze confidence <= 0.50.',
    '- Halte "reason" kurz (max. 1 Satz).',
    '',
    'JSON Schema:',
    '{ "path": string, "confidence": number, "reason": string }',
    '',
    `Titel: ${signals.title || '–'}`,
    `Marke: ${signals.brand || '–'}`,
    `MPN/OEM: ${signals.mpn || '–'}`,
    `Barcodes: ${signals.barcodes.join(', ') || '–'}`,
    `Beschreibung: ${signals.description ? signals.description.slice(0, 1200) : '–'}`,
    `Hinweis-Kategorien (nur Hinweis, evtl. falsch): ${signals.hintCategories.join(' | ') || '–'}`,
    `Attribute: ${signals.attrsPreview || '–'}`,
    `Extra-Attribute: ${signals.extraPreview || '–'}`,
    '',
    'ALLOWED_CATEGORIES (du MUSST exakt einen davon zurückgeben):',
    candidates.map((c) => `- ${c}`).join('\n'),
  ].join('\n');
}

function buildDualPrompt({ signals, candidates91387, candidates91388 }) {
  return [
    'Du bist ein strenger Produkt-Kategorisierer für BaseLinker.',
    'Deine Aufgabe: Wähle GENAU JE INVENTORY EINEN passenden Kategoriepfad aus der jeweiligen Whitelist.',
    '',
    'Harte Regeln:',
    '- Antworte NUR als JSON (kein Markdown).',
    '- Für inventory "91387": path MUSS exakt einem Eintrag aus ALLOWED_CATEGORIES_91387 entsprechen.',
    '- Für inventory "91388": path MUSS exakt einem Eintrag aus ALLOWED_CATEGORIES_91388 entsprechen.',
    '- Erfinde KEINE Kategorien und ändere KEINE Schreibweise.',
    '- Nutze NUR die Produktdaten unten (keine externen Quellen).',
    '- Wenn du unsicher bist, wähle jeweils den sichersten Pfad aus der jeweiligen Whitelist und setze confidence <= 0.50.',
    '- Halte "reason" kurz (max. 1 Satz).',
    '',
    'JSON Schema:',
    '{ "categories": { "91387": { "path": string, "confidence": number, "reason": string }, "91388": { "path": string, "confidence": number, "reason": string } } }',
    '',
    `Titel: ${signals.title || '–'}`,
    `Marke: ${signals.brand || '–'}`,
    `MPN/OEM: ${signals.mpn || '–'}`,
    `Barcodes: ${signals.barcodes.join(', ') || '–'}`,
    `Beschreibung: ${signals.description ? signals.description.slice(0, 1200) : '–'}`,
    `Hinweis-Kategorien (nur Hinweis, evtl. falsch): ${signals.hintCategories.join(' | ') || '–'}`,
    `Attribute: ${signals.attrsPreview || '–'}`,
    `Extra-Attribute: ${signals.extraPreview || '–'}`,
    '',
    'ALLOWED_CATEGORIES_91387 (nur daraus darfst du wählen):',
    candidates91387.map((c) => `- ${c}`).join('\n'),
    '',
    'ALLOWED_CATEGORIES_91388 (nur daraus darfst du wählen):',
    candidates91388.map((c) => `- ${c}`).join('\n'),
  ].join('\n');
}

async function resolveCategoryWithGemini({ prompt }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'BASELINKER_CATEGORY_MODEL', 'gemini-3-pro-preview');
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
        reason: { type: 'string' },
      },
      required: ['path', 'confidence'],
    },
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });

  // IMPORTANT:
  // @google/generative-ai can return multiple content parts. Some deployments have shown
  // response.text() not containing the full concatenation for structured JSON use-cases.
  // We therefore concatenate parts manually (without inserting separators).
  const resp = result?.response;
  const candidates = Array.isArray(resp?.candidates) ? resp.candidates : [];
  const partsResponse = candidates[0]?.content?.parts || [];
  const textParts = Array.isArray(partsResponse)
    ? partsResponse
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter((t) => t && t.trim().length > 0)
    : [];
  const textPayload = textParts.join('').trim();
  if (!textPayload) {
    throw new Error('Gemini returned empty payload for category selection.');
  }

  let json;
  try {
    json = JSON.parse(textPayload);
  } catch (e) {
    const preview = textPayload.slice(0, 800);
    throw new Error(`Invalid JSON from Gemini: ${(e && e.message) || e}. Preview: ${preview}`);
  }
  return {
    path: safeString(json?.path),
    confidence: typeof json?.confidence === 'number' ? json.confidence : Number(json?.confidence || 0),
    reason: safeString(json?.reason),
    model: modelName,
  };
}

async function resolveDualCategoriesWithGemini({ prompt }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'BASELINKER_CATEGORY_MODEL', 'gemini-3-pro-preview');
  const model = client.getGenerativeModel({ model: modelName });

  const generationConfig = {
    temperature: 0.1,
    topP: 0.95,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'object',
          properties: {
            '91387': {
              type: 'object',
              properties: {
                path: { type: 'string' },
                confidence: { type: 'number' },
                reason: { type: 'string' },
              },
              required: ['path', 'confidence'],
            },
            '91388': {
              type: 'object',
              properties: {
                path: { type: 'string' },
                confidence: { type: 'number' },
                reason: { type: 'string' },
              },
              required: ['path', 'confidence'],
            },
          },
          required: ['91387', '91388'],
        },
      },
      required: ['categories'],
    },
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });

  const resp = result?.response;
  const candidates = Array.isArray(resp?.candidates) ? resp.candidates : [];
  const partsResponse = candidates[0]?.content?.parts || [];
  const textParts = Array.isArray(partsResponse)
    ? partsResponse
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter((t) => t && t.trim().length > 0)
    : [];
  const textPayload = textParts.join('').trim();
  if (!textPayload) {
    throw new Error('Gemini returned empty payload for dual category selection.');
  }

  let json;
  try {
    json = JSON.parse(textPayload);
  } catch (e) {
    const preview = textPayload.slice(0, 800);
    throw new Error(`Invalid JSON from Gemini (dual): ${(e && e.message) || e}. Preview: ${preview}`);
  }

  const c = json?.categories || {};
  return {
    categories: {
      '91387': {
        path: safeString(c?.['91387']?.path),
        confidence:
          typeof c?.['91387']?.confidence === 'number'
            ? c['91387'].confidence
            : Number(c?.['91387']?.confidence || 0),
        reason: safeString(c?.['91387']?.reason),
      },
      '91388': {
        path: safeString(c?.['91388']?.path),
        confidence:
          typeof c?.['91388']?.confidence === 'number'
            ? c['91388'].confidence
            : Number(c?.['91388']?.confidence || 0),
        reason: safeString(c?.['91388']?.reason),
      },
    },
    model: modelName,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const invIds = args.inventoryIds;
  if (!invIds.length) {
    throw new Error('No --inventory-ids provided');
  }

  const inventories = {};
  for (const inv of invIds) {
    const idx = getInventoryCategoryIndex(inv);
    const leaves = Array.isArray(idx?.leaves) ? idx.leaves : [];
    if (!leaves.length) {
      throw new Error(`No leaf categories found for inventory ${inv} (check bl_nventory_cat.xlsx)`);
    }
    const leafKeyToPath = new Map();
    for (const p of leaves) {
      const k = normalizeForToken(p);
      if (k && !leafKeyToPath.has(k)) leafKeyToPath.set(k, p);
    }
    const fallbackLeaf = leaves.find((p) => /sonstig/i.test(String(p))) || leaves[0] || '';
    inventories[inv] = {
      inv,
      leaves,
      leafSet: new Set(leaves),
      leafKeyToPath,
      fallbackLeaf,
      tokenIndex: buildTokenIndex(leaves),
      meta: { maxDepth: idx?.maxDepth || 0, leavesCount: leaves.length, nodesCount: (idx?.nodes || []).length },
    };
  }

  console.log(
    JSON.stringify(
      {
        action: 'baselinker-assign-inventory-categories-llm-minqty',
        project: PROJECT_ID,
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        minQty: args.minQty,
        inventories: Object.fromEntries(
          Object.values(inventories).map((v) => [v.inv, v.meta])
        ),
        limit: args.limit || 0,
        concurrency: args.concurrency,
        force: Boolean(args.force),
        candidates: args.candidates,
      },
      null,
      2
    )
  );

  const snap = await firestore.collection('products').get();
  const docs = args.limit && args.limit > 0 ? snap.docs.slice(0, Math.floor(args.limit)) : snap.docs;
  console.log(`[bl-categories] products_total=${snap.size} processing=${docs.length}`);

  const queue = new PQueue({ concurrency: Math.max(1, Math.floor(args.concurrency || 2)) });
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const runOne = async (doc) => {
    const product = doc.data() || {};
    const qty = pickTotalQuantity(product);
    if (!Number.isFinite(qty) || qty < args.minQty) {
      return { status: 'skip', reason: 'qty_lt_min', qty };
    }

    const signals = pickProductSignals(product);
    const updates = {};
    const audit = {};
    const nowIso = new Date().toISOString();

    const currentMap =
      product?.details?.baselinkerCategories && typeof product.details.baselinkerCategories === 'object'
        ? product.details.baselinkerCategories
        : {};

    const productText = [
      signals.title,
      signals.brand,
      signals.mpn,
      signals.description,
      signals.hintCategories.join(' '),
      signals.attrsPreview,
      signals.extraPreview,
    ].join(' ');

    const needs = [];
    const shortlists = {};
    for (const inv of invIds) {
      const invInfo = inventories[inv];
      const current = safeString(currentMap?.[inv]);
      const alreadyValid = current && invInfo.leafSet.has(current);
      if (alreadyValid && !args.force) {
        audit[inv] = { status: 'skip', reason: 'already_valid', path: current };
        continue;
      }

      const shortlist = shortlistCandidates({
        leafPaths: invInfo.leaves,
        tokenIndex: invInfo.tokenIndex,
        productText,
        max: args.candidates,
      });
      if (!shortlist.length) {
        audit[inv] = { status: 'failed', reason: 'no_candidates' };
        throw new Error(`No candidates for inventory ${inv}`);
      }
      needs.push(inv);
      shortlists[inv] = shortlist;
    }

    // Preferred path: resolve both inventories in ONE Gemini call (cuts cost/time in half).
    if (needs.length === 2 && needs.includes('91387') && needs.includes('91388')) {
      const basePrompt = buildDualPrompt({
        signals,
        candidates91387: shortlists['91387'],
        candidates91388: shortlists['91388'],
      });
      let out = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt =
          attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nWICHTIG: Du hast zuvor einen ungültigen Pfad geliefert. Antworte erneut und kopiere die Pfade exakt aus den jeweiligen Listen. Keine Zwischenknoten, nur erlaubte Leaf-Pfade.`;
        try {
          out = await resolveDualCategoriesWithGemini({ prompt });
          lastError = null;
        } catch (e) {
          out = null;
          lastError = e;
          continue;
        }

        // Validate (leaf paths only). If any invalid, retry once.
        let allValid = true;
        for (const inv of needs) {
          const invInfo = inventories[inv];
          const raw = safeString(out?.categories?.[inv]?.path);
          const canonical = canonicalizeLeafPath(raw, invInfo);
          if (!canonical || !invInfo.leafSet.has(canonical)) {
            allValid = false;
            break;
          }
        }
        if (allValid) break;
        out = null;
      }

      for (const inv of needs) {
        const invInfo = inventories[inv];
        const shortlist = shortlists[inv] || [];
        const raw = safeString(out?.categories?.[inv]?.path);
        const canonical = canonicalizeLeafPath(raw, invInfo);
        const confidence = out?.categories?.[inv]?.confidence || 0;
        const reason = safeString(out?.categories?.[inv]?.reason);

        const validChosen = canonical && invInfo.leafSet.has(canonical);
        const chosen = validChosen ? canonical : pickFallbackFromShortlist(shortlist, invInfo);
        const finalIsFallback = !validChosen;

        if (!chosen || !invInfo.leafSet.has(chosen)) {
          // This should never happen; keep a hard fail to avoid writing invalid data.
          audit[inv] = {
            status: 'failed',
            reason: 'no_valid_choice_even_after_fallback',
            chosen: safeString(chosen),
            raw,
            model: out?.model || null,
            error: safeString(lastError?.message || lastError),
          };
          throw new Error(`No valid category could be assigned for inventory ${inv}`);
        }

        updates[`details.baselinkerCategories.${inv}`] = chosen;
        audit[inv] = {
          status: finalIsFallback ? 'fallback' : 'updated',
          path: chosen,
          confidence: finalIsFallback ? Math.min(0.35, Number(confidence || 0) || 0) : confidence,
          reason: finalIsFallback ? (reason || 'fallback_from_shortlist') : (reason || ''),
          model: out?.model || null,
          assigned_at_iso: nowIso,
        };
      }
    } else {
      // Fallback: resolve inventories one-by-one (supports custom --inventory-ids).
      for (const inv of needs) {
        const invInfo = inventories[inv];
        const shortlist = shortlists[inv] || [];
        const basePrompt = buildPrompt({ inventoryId: inv, signals, candidates: shortlist });
        let out = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const prompt =
            attempt === 0
              ? basePrompt
              : `${basePrompt}\n\nWICHTIG: Du hast zuvor einen ungültigen Pfad geliefert. Antworte erneut und kopiere den Pfad exakt aus der Liste. Nur Leaf-Pfade.`;
          try {
            out = await resolveCategoryWithGemini({ prompt });
            break;
          } catch (e) {
            out = null;
          }
        }

        const raw = safeString(out?.path);
        const canonical = canonicalizeLeafPath(raw, invInfo);
        const validChosen = canonical && invInfo.leafSet.has(canonical);
        const chosen = validChosen ? canonical : pickFallbackFromShortlist(shortlist, invInfo);
        const finalIsFallback = !validChosen;

        if (!chosen || !invInfo.leafSet.has(chosen)) {
          audit[inv] = {
            status: 'failed',
            reason: 'no_valid_choice_even_after_fallback',
            raw,
            chosen: safeString(chosen),
            model: out?.model || null,
          };
          throw new Error(`No valid category could be assigned for inventory ${inv}`);
        }

        updates[`details.baselinkerCategories.${inv}`] = chosen;
        audit[inv] = {
          status: finalIsFallback ? 'fallback' : 'updated',
          path: chosen,
          confidence: finalIsFallback ? Math.min(0.35, Number(out?.confidence || 0) || 0) : (out?.confidence || 0),
          reason: finalIsFallback ? (out?.reason || 'fallback_from_shortlist') : (out?.reason || ''),
          model: out?.model || null,
          assigned_at_iso: nowIso,
        };
      }
    }

    const hasAnyUpdate = Object.keys(updates).length > 0;
    if (!hasAnyUpdate) {
      return { status: 'skip', reason: 'no_changes', qty };
    }

    // common ops updates
    updates['ops.last_saved_source'] = 'baselinker-category-llm';
    updates['ops.last_saved_iso'] = nowIso;
    updates['ops.revision'] = FieldValue.increment(1);
    updates['ops.sync_status'] = 'pending';
    for (const inv of Object.keys(audit)) {
      updates[`ops.data_quality.baselinker_category_assignment_v1.${inv}`] = audit[inv];
    }

    if (args.apply) {
      await firestore.collection('products').doc(doc.id).update(updates);
    }

    return { status: args.apply ? 'updated' : 'dry_run_update', qty, updates: Object.keys(updates) };
  };

  const tasks = docs.map((doc) =>
    queue.add(async () => {
      try {
        const res = await runOne(doc);
        processed += 1;
        if (res.status === 'updated' || res.status === 'dry_run_update') updated += 1;
        if (res.status === 'skip') skipped += 1;
        if (processed % 25 === 0) {
          console.log(JSON.stringify({ processed, updated, skipped, failed }, null, 2));
        }
      } catch (e) {
        processed += 1;
        failed += 1;
        console.warn(`[bl-categories] failed doc=${doc.id}:`, e?.message || e);
      }
    })
  );

  await Promise.all(tasks);
  await queue.onIdle();

  console.log(JSON.stringify({ done: true, processed, updated, skipped, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

