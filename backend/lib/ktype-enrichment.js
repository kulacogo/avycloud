/* eslint-disable no-console */
/**
 * K-Typ enrichment (Auto/Motorradteile):
 * - Only for eBay categories that support vehicle fitment lists (per `vehicle-fitment-categories.json`)
 * - Only when we have a part number/MPN/OE
 * - Only when we can map evidence -> MVL K-Type IDs (no guessing)
 *
 * Evidence strategy (best-effort, fast):
 * - Use SerpAPI to get candidate pages
 * - Fetch pages (direct + unlocker) and require MPN to appear on the page
 * - Extract either:
 *   - HSN/TSN pairs (strict, labeled)
 *   - or (fallback) vehicle make + platform tokens that match MVL rows
 *
 * Output:
 * - Sets details.attributes["K-Typ"] (pipe-separated KType IDs) when confident.
 * - Stores full trace in ops.data_quality.ktype_enrich_v1
 */

const fs = require('fs');
const path = require('path');
const { callSerpApi } = require('./serpapi');
const { fetchPageText } = require('./web-search-html');
const { getVehicleFitmentMode } = require('./vehicle-fitment');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeNeedle(value = '') {
  return safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeHsnTsn(raw) {
  const s = safeString(raw);
  if (!s) return '';
  const m = s.match(/\b(\d{4})\b[^\p{L}\p{N}]+([a-z0-9]{3})\b/i);
  if (!m) return '';
  return `${m[1]}|${m[2].toUpperCase()}`;
}

function extractHsnTsnCandidates(text = '') {
  const s = String(text || '');
  const out = new Set();
  const re = /\bHSN\b[^0-9]{0,40}(\d{4}).{0,120}?\bTSN\b[^A-Z0-9]{0,40}([A-Z0-9]{3})\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const h = String(m[1] || '').trim();
    const t = String(m[2] || '').trim().toUpperCase();
    if (/^\d{4}$/.test(h) && /^[A-Z0-9]{3}$/.test(t)) {
      out.add(`${h}|${t}`);
    }
  }
  return Array.from(out);
}

function extractPlatformTokens(text = '') {
  const s = String(text || '');
  const out = new Set();
  const re = /\b[A-Z0-9]{2,6}(?:\/[0-9])?\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = String(m[0] || '').trim();
    if (!tok) continue;
    if (/^(EAN|OEM|HSN|TSN|ABS|ESP|SKU)$/i.test(tok)) continue;
    out.add(tok);
  }
  return Array.from(out);
}

let MVL_CACHE = null; // { atMs, parsed, byHsnTsn, makes:Set, byMakePlatform:Map }
const MVL_CACHE_TTL_MS = 10 * 60 * 1000;

function resolveMvlPath() {
  const env = safeString(process.env.MVL_JSONL_PATH || process.env.MVL_JSONL);
  if (env) return env;
  // Prefer a runtime-shipped path if present.
  const candidates = [
    path.join(process.cwd(), 'backend', 'ebay-data', 'DE_MVL_2025_10.compact.jsonl'),
    path.join(process.cwd(), 'exports', 'DE_MVL_2025_10.compact.jsonl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadMvlIndex() {
  const now = Date.now();
  if (MVL_CACHE && now - (MVL_CACHE.atMs || 0) < MVL_CACHE_TTL_MS) return MVL_CACHE;
  const jsonlPath = resolveMvlPath();
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    MVL_CACHE = { atMs: now, ok: false, reason: 'mvl_missing', jsonlPath: jsonlPath || null };
    return MVL_CACHE;
  }
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const byHsnTsn = new Map();
  const makes = new Set();
  const byMakePlatform = new Map();
  const lines = text.split('\n');
  let parsed = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    parsed += 1;
    const rec = JSON.parse(s);
    const k = Number(rec?.k);
    if (!Number.isFinite(k)) continue;
    const make = safeString(rec?.make);
    const makeLower = make ? make.toLowerCase() : '';
    if (makeLower) makes.add(makeLower);
    const platform = safeString(rec?.platform);
    if (makeLower && platform) {
      const key = `${makeLower}|${platform}`;
      const set = byMakePlatform.get(key) || new Set();
      set.add(k);
      byMakePlatform.set(key, set);
    }
    const raw = safeString(rec?.hsn_tsn);
    if (!raw) continue;
    const parts = raw.split('<>').map((p) => normalizeHsnTsn(p)).filter(Boolean);
    for (const h of parts) {
      const set = byHsnTsn.get(h) || new Set();
      set.add(k);
      byHsnTsn.set(h, set);
    }
  }
  MVL_CACHE = { atMs: now, ok: true, jsonlPath, parsed, byHsnTsn, makes, byMakePlatform };
  return MVL_CACHE;
}

function extractVehicleMakes(text, makeSet) {
  const lower = String(text || '').toLowerCase();
  const found = new Set();
  for (const make of makeSet) {
    if (!make || make.length < 3) continue;
    const re = new RegExp(`\\b${make.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    if (re.test(lower)) found.add(make);
    if (found.size >= 3) break;
  }
  return Array.from(found);
}

function normalizeKeyForMatch(key = '') {
  return safeString(key).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pickFromAttributes(attrs, candidateKeys = []) {
  if (!attrs || typeof attrs !== 'object') return '';
  const byNorm = new Map();
  for (const k of Object.keys(attrs)) {
    byNorm.set(normalizeKeyForMatch(k), k);
  }
  for (const candidate of candidateKeys) {
    const norm = normalizeKeyForMatch(candidate);
    const actual = byNorm.get(norm);
    if (!actual) continue;
    const value = safeString(attrs[actual]);
    if (value) return value;
  }
  return '';
}

function pickCategoryId(product) {
  const details = product?.details || {};
  const attrs = details?.attributes || {};
  const extra = details?.attributes_extra || {};

  const raw =
    safeString(details.categoryId) ||
    safeString(details.ebayCategoryId) ||
    // common legacy/meta keys stored either in attributes or attributes_extra
    pickFromAttributes(attrs, ['ebay_category_id', 'ebayCategoryId', 'category_id', 'categoryId', 'Kategorie-ID', 'Kategorie ID']) ||
    pickFromAttributes(extra, ['ebay_category_id', 'ebayCategoryId', 'category_id', 'categoryId', 'Kategorie-ID', 'Kategorie ID']) ||
    '';

  if (!raw) return '';
  // eBay category IDs are numeric; keep digits when possible.
  const digits = raw.replace(/\D+/g, '').trim();
  return digits || raw;
}

function pickPartNumber(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  const extra = product?.details?.attributes_extra || {};
  const mpnFromAttrs =
    pickFromAttributes(attrs, [
      'mpn',
      'Herstellernummer',
      'Hersteller-Teilenummer',
      'Hersteller Teilenummer',
      'Herstellerteilenummer',
      'Teilenummer',
      'Teile Nummer',
      'Referenznummer(n) OEM',
      'OEM',
      'OE',
    ]) ||
    pickFromAttributes(extra, [
      'mpn',
      'Herstellernummer',
      'Hersteller-Teilenummer',
      'Hersteller Teilenummer',
      'Herstellerteilenummer',
      'Teilenummer',
      'Teile Nummer',
      'Referenznummer(n) OEM',
      'OEM',
      'OE',
    ]) ||
    '';
  return (
    safeString(ids.mpn) ||
    mpnFromAttrs ||
    safeString(ids.oem) ||
    ''
  );
}

function hasKTyp(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  return Object.keys(attrs).some((k) => {
    const lower = safeString(k).toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
}

function formatKTyp(ids = [], { maxLen = 0 } = {}) {
  const parts = ids.map((id) => String(id).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const tentative = out.length ? `${out.join('|')}|${p}` : p;
    if (maxLen > 0 && tentative.length > maxLen) break;
    out.push(p);
  }
  return out.join('|');
}

async function resolveEvidenceUrls(query, { limit = 6 } = {}) {
  const engines = ['google', 'bing', 'duckduckgo'];
  for (const engine of engines) {
    try {
      const data = await callSerpApi(engine, { q: query, num: limit });
      const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
      const urls = organic.map((r) => safeString(r?.link)).filter(Boolean);
      if (urls.length) {
        return {
          engine,
          urls: urls.slice(0, limit),
          results: organic.slice(0, limit).map((r) => ({ title: r?.title || '', link: r?.link || '' })),
        };
      }
    } catch {
      // try next engine
    }
  }
  return { engine: null, urls: [], results: [] };
}

async function enrichKTypIfPossible(product, { reason = 'identify', maxKTypes = 60 } = {}) {
  // Preconditions
  const catId = pickCategoryId(product);
  const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
  if (!fitmentMode) return { ok: false, reason: 'not_fitment_category' };
  if (hasKTyp(product)) return { ok: false, reason: 'already_has_ktype' };
  const mpn = pickPartNumber(product);
  if (!mpn) return { ok: false, reason: 'missing_part_number' };

  const mvl = loadMvlIndex();
  if (!mvl.ok) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(new Set([...(product.notes.warnings || []), 'K-Typ nicht angereichert: MVL Datensatz fehlt am Runtime.' ]));
    return { ok: false, reason: 'mvl_missing' };
  }

  const brand = safeString(product?.identification?.brand) || safeString(product?.details?.attributes?.Marke) || '';
  const typeHint = safeString(product?.details?.attributes?.Produktart) || safeString(product?.details?.attributes?.Bauteil) || '';
  const q = [brand, mpn, typeHint].filter(Boolean).join(' ').trim();
  const q2 = [brand, mpn, typeHint, 'HSN', 'TSN'].filter(Boolean).join(' ').trim();
  const queries = Array.from(new Set([q, q2].filter(Boolean))).slice(0, 2);

  const mpnNeedle = normalizeNeedle(mpn);
  const hsnTsnFound = new Set();
  const platformHits = new Set();
  const sources = [];

  for (const query of queries) {
    const serp = await resolveEvidenceUrls(query, { limit: 6 });
    for (const url of serp.urls) {
      const fetched = await fetchPageText(url, { timeoutMs: 20_000 });
      if (!fetched?.ok || !fetched?.text) continue;
      const text = String(fetched.text);
      if (mpnNeedle && !normalizeNeedle(text).includes(mpnNeedle)) continue;

      extractHsnTsnCandidates(text).forEach((p) => hsnTsnFound.add(p));
      const makes = extractVehicleMakes(text, mvl.makes);
      const platforms = extractPlatformTokens(text);
      for (const make of makes) {
        for (const pTok of platforms) {
          const key = `${make}|${pTok}`;
          const set = mvl.byMakePlatform.get(key);
          if (!set) continue;
          for (const id of set.values()) platformHits.add(id);
        }
      }

      sources.push({ url, via: fetched.via || 'fetch' });
      if (sources.length >= 6) break;
    }
    if (sources.length >= 6) break;
  }

  const mapped = new Set();
  for (const pair of hsnTsnFound.values()) {
    const set = mvl.byHsnTsn.get(pair);
    if (!set) continue;
    for (const id of set.values()) mapped.add(id);
  }
  if (mapped.size === 0) {
    for (const id of platformHits.values()) mapped.add(id);
  }

  const ids = Array.from(mapped).sort((a, b) => a - b).slice(0, maxKTypes);
  if (!ids.length) {
    // Keep as warning (no guessing)
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), `K-Typ nicht angereichert: keine MVL-Matches aus Web-Evidence (${reason}).`])
    );
    return { ok: false, reason: 'no_matches', fitmentMode, queries };
  }

  product.details = product.details || {};
  product.details.attributes = product.details.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  // Store full K-Type list (no truncation) to satisfy downstream sync + UI requirements.
  // If a downstream system cannot accept long values, that system must be adjusted (field type) rather than truncating here.
  product.details.attributes['K-Typ'] = formatKTyp(ids, { maxLen: 0 });
  product.ops = product.ops || {};
  product.ops.data_quality = {
    ...(product.ops.data_quality || {}),
    ktype_enrich_v1: {
      at_iso: new Date().toISOString(),
      reason,
      fitment_mode: fitmentMode,
      mpn,
      queries,
      hsn_tsn: Array.from(hsnTsnFound),
      ktypes: ids,
      sources,
      mvl_path: mvl.jsonlPath,
    },
  };
  return { ok: true, fitmentMode, ids };
}

module.exports = {
  enrichKTypIfPossible,
  loadMvlIndex,
  resolveMvlPath,
};

