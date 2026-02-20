const { callGeminiStructured } = require('../lib/gemini-structured');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const {
  getInventoryCategoryIndex,
  resolveInventoryCategoryIdByBreadcrumb,
  normalizeForSearch,
} = require('../lib/baselinker-inventory-category-index');

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
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'und',
  'oder',
  'mit',
  'ohne',
  'fur',
  'für',
  'von',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einer',
  'eines',
  'the',
  'and',
  'for',
  'with',
  'ohne',
  'set',
  'kit',
  'neu',
  'new',
  'gebraucht',
  'used',
]);

function tokenize(text = '') {
  const norm = normalizeForToken(text);
  if (!norm) return [];
  return norm
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function pickProductSignals(product) {
  const p = product && typeof product === 'object' ? product : {};
  const id = safeString(p?.id);
  const title = safeString(p?.identification?.name);
  const brand = safeString(p?.identification?.brand);
  const desc = safeString(p?.details?.short_description);
  const highlights = Array.isArray(p?.details?.key_features)
    ? p.details.key_features.map((x) => safeString(x)).filter(Boolean).slice(0, 8)
    : [];
  const attrs = p?.details?.attributes && typeof p.details.attributes === 'object' ? p.details.attributes : {};
  const attrLines = Object.entries(attrs)
    .slice(0, 30)
    .map(([k, v]) => `${safeString(k)}: ${safeString(v)}`)
    .filter(Boolean);
  const identifiers = p?.details?.identifiers || {};
  const ean = safeString(identifiers?.ean || identifiers?.gtin || identifiers?.upc);
  const mpn = safeString(identifiers?.mpn);
  const sku = safeString(p?.identification?.sku || identifiers?.sku);

  return {
    id,
    title,
    brand,
    desc,
    highlights,
    attrLines,
    ean,
    mpn,
    sku,
  };
}

function buildTokenIndex(rows = []) {
  // rows: { id, breadcrumb, name, depth, isLeaf }
  const tokenToIds = new Map(); // token -> Set<id>
  const byId = new Map(); // id -> row

  for (const r of rows) {
    const id = Number(r?.id || r?.category_id || 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    const breadcrumb = safeString(r?.breadcrumb);
    const name = safeString(r?.name);
    const depth = Number(r?.depth || 0) || 0;
    const isLeaf = Boolean(r?.isLeaf);
    const row = { id, breadcrumb, name, depth, isLeaf };
    byId.set(id, row);

    const tokens = new Set([...tokenize(breadcrumb), ...tokenize(name)]);
    for (const t of tokens) {
      if (!tokenToIds.has(t)) tokenToIds.set(t, new Set());
      tokenToIds.get(t).add(id);
    }
  }

  return { tokenToIds, byId };
}

function shortlistCandidates(index, signals, { limit = 60 } = {}) {
  const text = [
    signals?.title,
    signals?.brand,
    signals?.desc,
    Array.isArray(signals?.highlights) ? signals.highlights.join(' ') : '',
    Array.isArray(signals?.attrLines) ? signals.attrLines.join(' ') : '',
    signals?.ean,
    signals?.mpn,
  ]
    .filter(Boolean)
    .join(' ');

  const tokens = Array.from(new Set(tokenize(text))).slice(0, 80);
  const scores = new Map(); // id -> score

  for (const t of tokens) {
    const ids = index.tokenToIds.get(t);
    if (!ids) continue;
    for (const id of ids) {
      scores.set(id, (scores.get(id) || 0) + 1);
    }
  }

  const scored = Array.from(scores.entries())
    .map(([id, score]) => {
      const row = index.byId.get(id);
      return { id, score, depth: row?.depth || 0, breadcrumb: row?.breadcrumb || '', name: row?.name || '', isLeaf: row?.isLeaf };
    })
    .filter((x) => x.breadcrumb)
    .sort((a, b) => (b.score - a.score) || (b.depth - a.depth) || a.breadcrumb.localeCompare(b.breadcrumb, 'de-DE'));

  const top = scored.slice(0, Math.max(1, Math.min(limit, 120)));
  return top.map((x) => ({ id: String(x.id), breadcrumb: x.breadcrumb, name: x.name || '', depth: x.depth || 0 }));
}

function pickFallbackCandidate(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const preferred = candidates.find((c) => /\bsonstige\b/i.test(String(c?.breadcrumb || '')));
  return preferred || candidates[0];
}

async function assignBaselinkerCategoryBestEffort(product, { inventoryId = '78659', locale = 'de-DE' } = {}) {
  const inv = safeString(inventoryId || '78659') || '78659';

  // If already assigned, keep.
  const existingPath = safeString(product?.details?.baselinkerCategoryPath);
  const existingId = safeString(product?.details?.baselinkerCategoryId);
  if (existingPath && existingId) {
    return { ok: true, reason: 'already_assigned', category: { id: existingId, breadcrumb: existingPath } };
  }

  const idx = await getInventoryCategoryIndex(inv);
  const rows = Array.isArray(idx?.rows) ? idx.rows : [];
  const leafRows = rows.filter((r) => r?.isLeaf);
  if (!leafRows.length) {
    return { ok: false, reason: 'category_index_empty', inventoryId: inv };
  }

  // Build token index (in-memory, per call; fast enough for 11k rows, but can be cached later if needed).
  const tokenIndex = buildTokenIndex(leafRows);
  const signals = pickProductSignals(product);
  const candidates = shortlistCandidates(tokenIndex, signals, { limit: 60 });
  if (!candidates.length) {
    const fallback = pickFallbackCandidate(
      leafRows.slice(0, 60).map((r) => ({ id: String(r.id), breadcrumb: r.breadcrumb, name: r.name || '', depth: r.depth || 0 }))
    );
    if (!fallback) return { ok: false, reason: 'no_candidates', inventoryId: inv };
    product.details = product.details || {};
    product.details.baselinkerCategoryPath = fallback.breadcrumb;
    product.details.baselinkerCategoryId = String(fallback.id);
    return { ok: true, reason: 'fallback_no_candidates', category: { id: String(fallback.id), breadcrumb: fallback.breadcrumb } };
  }

  const policy = buildCommonPolicyText({ locale, allowWebEvidence: false });
  const prompt = [
    policy,
    '',
    'AUFGABE:',
    'Wähle GENAU EINE BaseLinker Kategorie aus der Kandidatenliste.',
    'Du MUSST exakt eine der IDs aus der Liste wählen (keine neue ID erfinden).',
    '',
    'PRODUKT:',
    `- ID: ${signals.id || '-'}`,
    `- Titel: ${signals.title || '-'}`,
    `- Marke: ${signals.brand || '-'}`,
    `- SKU: ${signals.sku || '-'}`,
    `- EAN/GTIN/UPC: ${signals.ean || '-'}`,
    `- MPN: ${signals.mpn || '-'}`,
    signals.desc ? `- Beschreibung: ${signals.desc.slice(0, 900)}` : null,
    signals.highlights?.length ? `- Highlights: ${signals.highlights.slice(0, 8).join(' | ')}` : null,
    signals.attrLines?.length ? `- Attribute (Auszug): ${signals.attrLines.slice(0, 18).join(' | ')}` : null,
    '',
    'KANDIDATEN (id | breadcrumb):',
    ...candidates.map((c, i) => `${i + 1}) ${c.id} | ${c.breadcrumb}`),
    '',
    'ANTWORTFORMAT: Gib NUR gültiges JSON zurück (keine Markdown-Fences). reason kurz halten.',
  ]
    .filter(Boolean)
    .join('\n');

  const schema = {
    type: 'object',
    required: ['category_id', 'breadcrumb', 'confidence', 'reason'],
    properties: {
      category_id: { type: 'string' },
      breadcrumb: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
  };

  let chosen = null;
  let parsed = null;
  try {
    const payload = await callGeminiStructured({
      parts: [{ text: prompt }],
      responseSchema: schema,
      temperature: 0.0,
      maxOutputTokens: 512,
    });
    parsed = JSON.parse(payload);
  } catch (e) {
    // ignore; fallback below
  }

  if (parsed && typeof parsed === 'object') {
    const pickedId = safeString(parsed.category_id);
    const pickedBreadcrumb = safeString(parsed.breadcrumb);
    if (pickedId && candidates.some((c) => c.id === pickedId)) {
      chosen = candidates.find((c) => c.id === pickedId);
    } else if (pickedBreadcrumb) {
      const normPicked = normalizeForSearch(pickedBreadcrumb);
      chosen = candidates.find((c) => normalizeForSearch(c.breadcrumb) === normPicked) || null;
    }
  }

  if (!chosen) {
    chosen = pickFallbackCandidate(candidates);
  }
  if (!chosen) {
    return { ok: false, reason: 'no_choice', inventoryId: inv };
  }

  // Ensure we store a valid category id for the target inventory (in case breadcrumb existed but ID mismatch).
  let resolvedId = Number(chosen.id || 0) || 0;
  if (!resolvedId && chosen.breadcrumb) {
    resolvedId = await resolveInventoryCategoryIdByBreadcrumb(inv, chosen.breadcrumb);
  }

  product.details = product.details || {};
  product.details.baselinkerCategoryPath = chosen.breadcrumb;
  if (resolvedId) {
    product.details.baselinkerCategoryId = String(resolvedId);
  } else {
    product.details.baselinkerCategoryId = String(chosen.id || '');
  }

  return {
    ok: true,
    reason: resolvedId ? 'llm' : 'llm_unverified_id',
    category: { id: String(product.details.baselinkerCategoryId || ''), breadcrumb: chosen.breadcrumb },
    debug: { candidates: candidates.slice(0, 12) },
  };
}

module.exports = {
  assignBaselinkerCategoryBestEffort,
};

