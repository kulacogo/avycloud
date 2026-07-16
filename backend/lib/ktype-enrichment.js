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
const os = require('os');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { search, fetchText } = require('./evidence-provider');
const { getVehicleFitmentMode } = require('./vehicle-fitment');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeBucketName(raw) {
  const s = safeString(raw);
  if (!s) return '';
  return s.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
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

let MOTO_CACHE = null; // { atMs, ok, jsonlPath, parsed, byMakeModelCcmYear, makes:Set, modelsByMake:Map }
const MOTO_CACHE_TTL_MS = 10 * 60 * 1000;

let GCS_CLIENT = null;
function getGcsClient() {
  if (GCS_CLIENT) return GCS_CLIENT;
  GCS_CLIENT = new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
  });
  return GCS_CLIENT;
}

function parseGsUri(uri = '') {
  const s = safeString(uri);
  if (!s) return null;
  const m = s.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return { bucket: m[1], object: m[2] };
}

function resolveMvlGcsUri() {
  const direct = safeString(process.env.MVL_JSONL_GCS_URI || process.env.MVL_GCS_URI || '');
  if (direct) return direct;
  const bucket = normalizeBucketName(process.env.MVL_GCS_BUCKET || process.env.STORAGE_BUCKET) || 'prodsandjobs';
  const object = safeString(process.env.MVL_GCS_OBJECT) || 'datasets/DE_MVL_2025_10.compact.jsonl';
  if (!bucket || !object) return '';
  return `gs://${bucket}/${object.replace(/^\/+/, '')}`;
}

let MVL_DOWNLOAD_INFLIGHT = null;
async function ensureMvlJsonlDownloaded({ uri, destinationPath }) {
  const dest = safeString(destinationPath);
  if (!dest) return { ok: false, reason: 'destination_missing', path: null };
  try {
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest);
      if (st.isFile() && st.size > 1024) {
        return { ok: true, via: 'cache', path: dest };
      }
    }
  } catch {
    // ignore and redownload
  }

  if (MVL_DOWNLOAD_INFLIGHT) return await MVL_DOWNLOAD_INFLIGHT;

  MVL_DOWNLOAD_INFLIGHT = (async () => {
    const gcsUri = safeString(uri);
    const parsed = parseGsUri(gcsUri);
    if (!parsed) {
      return { ok: false, reason: 'invalid_gcs_uri', uri: gcsUri || null, path: null };
    }

    try {
      // Ensure parent folder exists (Cloud Run FS is writable; local dev too).
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch {
      // ignore
    }

    try {
      const storage = getGcsClient();
      await storage.bucket(parsed.bucket).file(parsed.object).download({ destination: dest });
      const st = fs.statSync(dest);
      if (!st.isFile() || st.size < 1024) {
        return { ok: false, reason: 'downloaded_file_too_small', uri: gcsUri, path: dest };
      }
      return { ok: true, via: 'gcs', uri: gcsUri, path: dest, sizeBytes: st.size };
    } catch (e) {
      return { ok: false, reason: 'gcs_download_failed', uri: gcsUri, path: dest, error: safeString(e?.message || e) };
    }
  })().finally(() => {
    MVL_DOWNLOAD_INFLIGHT = null;
  });

  return await MVL_DOWNLOAD_INFLIGHT;
}

function resolveMvlPath() {
  const env = safeString(process.env.MVL_JSONL_PATH || process.env.MVL_JSONL);
  if (env) return env;
  // Prefer a runtime-shipped path if present.
  const candidates = [
    path.join(process.cwd(), 'backend', 'ebay-data', 'DE_MVL_2025_10.compact.jsonl'),
    path.join(process.cwd(), 'exports', 'DE_MVL_2025_10.compact.jsonl'),
    // Cloud Run filesystem is writable but ephemeral; we may download the MVL here.
    path.join(os.tmpdir(), 'DE_MVL_2025_10.compact.jsonl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveMotoPath() {
  const env = safeString(process.env.MOTO_JSONL_PATH || process.env.MOTO_JSONL);
  if (env) return env;
  const candidates = [
    path.join(process.cwd(), 'backend', 'ebay-data', 'DE_Motorradliste_2025_06.compact.jsonl'),
    path.join(process.cwd(), 'exports', 'DE_Motorradliste_2025_06.compact.jsonl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function loadMvlIndex() {
  const now = Date.now();
  if (MVL_CACHE && now - (MVL_CACHE.atMs || 0) < MVL_CACHE_TTL_MS) return MVL_CACHE;
  const configuredPath = resolveMvlPath();
  let jsonlPath = configuredPath;
  let download = null;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    const uri = resolveMvlGcsUri();
    const dest = path.join(os.tmpdir(), 'DE_MVL_2025_10.compact.jsonl');
    download = await ensureMvlJsonlDownloaded({ uri, destinationPath: dest });
    if (download?.ok && download?.path && fs.existsSync(download.path)) {
      jsonlPath = download.path;
    }
  }
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    MVL_CACHE = {
      atMs: now,
      ok: false,
      reason: 'mvl_missing',
      jsonlPath: jsonlPath || null,
      configuredPath: configuredPath || null,
      download: download || null,
      gcsUri: resolveMvlGcsUri() || null,
    };
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
  MVL_CACHE = {
    atMs: now,
    ok: true,
    jsonlPath,
    configuredPath: configuredPath || null,
    download: download || null,
    gcsUri: resolveMvlGcsUri() || null,
    parsed,
    byHsnTsn,
    makes,
    byMakePlatform,
  };
  return MVL_CACHE;
}

function loadMotoIndex() {
  const now = Date.now();
  if (MOTO_CACHE && now - (MOTO_CACHE.atMs || 0) < MOTO_CACHE_TTL_MS) return MOTO_CACHE;

  const jsonlPath = resolveMotoPath();
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    MOTO_CACHE = { atMs: now, ok: false, reason: 'moto_missing', jsonlPath: jsonlPath || null };
    return MOTO_CACHE;
  }

  const text = fs.readFileSync(jsonlPath, 'utf8');
  const byMakeModelCcmYear = new Map(); // `${makeLower}|${model}|${ccm}|${year}` -> Set<epid>
  const makes = new Set(); // lower
  const modelsByMake = new Map(); // makeLower -> Set<MODEL>
  const lines = text.split('\n');
  let parsed = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    parsed += 1;
    const rec = JSON.parse(s);
    const epid = Number(rec?.epid);
    if (!Number.isFinite(epid)) continue;
    const make = safeString(rec?.make);
    const makeLower = make ? make.toLowerCase() : '';
    const model = safeString(rec?.model).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const ccm = Number(rec?.ccm);
    const year = Number(rec?.year);
    if (!makeLower || !model || !Number.isFinite(ccm) || !Number.isFinite(year)) continue;
    makes.add(makeLower);
    const setModels = modelsByMake.get(makeLower) || new Set();
    setModels.add(model);
    modelsByMake.set(makeLower, setModels);
    const key = `${makeLower}|${model}|${ccm}|${year}`;
    const set = byMakeModelCcmYear.get(key) || new Set();
    set.add(epid);
    byMakeModelCcmYear.set(key, set);
  }

  MOTO_CACHE = { atMs: now, ok: true, jsonlPath, parsed, byMakeModelCcmYear, makes, modelsByMake };
  return MOTO_CACHE;
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
    if (!(lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ')) return false;
    const raw = safeString(attrs[k]);
    if (!raw) return false;
    // K-Type/ePID values are ID-like lists. Ignore placeholders/empty shells ("", "|", "n/a").
    const parts = raw.split(/[|,;]+/).map((x) => safeString(x)).filter(Boolean);
    if (!parts.length) return false;
    return parts.some((p) => /^\d+$/.test(p));
  });
}

function collectLocalHsnTsnCandidates(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const extra =
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object'
      ? product.details.attributes_extra
      : {};
  const ids = product?.details?.identifiers || {};
  const out = new Set();

  const pushCandidate = (raw) => {
    const s = safeString(raw);
    if (!s) return;
    const n = normalizeHsnTsn(s);
    if (n) out.add(n);
    extractHsnTsnCandidates(s).forEach((pair) => out.add(pair));
  };

  const hsnTsnCombinedKeys = [
    'HSN/TSN',
    'HSN TSN',
    'HSN-TSN',
    'KBA',
    'KBA-Nummer',
    'KBA Nummer',
    'Schlüsselnummer',
    'Schlüsselnummern',
  ];
  pushCandidate(pickFromAttributes(attrs, hsnTsnCombinedKeys));
  pushCandidate(pickFromAttributes(extra, hsnTsnCombinedKeys));
  pushCandidate(ids?.hsn_tsn);
  pushCandidate(ids?.hsnTsn);
  pushCandidate(ids?.kba);

  const hsn =
    pickFromAttributes(attrs, ['HSN', 'HSN-Nr', 'HSN Nr', 'HSN Nummer']) ||
    pickFromAttributes(extra, ['HSN', 'HSN-Nr', 'HSN Nr', 'HSN Nummer']) ||
    safeString(ids?.hsn);
  const tsn =
    pickFromAttributes(attrs, ['TSN', 'TSN-Nr', 'TSN Nr', 'TSN Nummer']) ||
    pickFromAttributes(extra, ['TSN', 'TSN-Nr', 'TSN Nr', 'TSN Nummer']) ||
    safeString(ids?.tsn);
  if (/^\d{4}$/.test(hsn) && /^[A-Z0-9]{3}$/i.test(tsn)) {
    out.add(`${hsn}|${String(tsn).toUpperCase()}`);
  }

  const textBlob = [
    safeString(product?.identification?.name),
    safeString(product?.details?.short_description),
    safeString(product?.details?.description),
    JSON.stringify(attrs || {}),
    JSON.stringify(extra || {}),
  ]
    .filter(Boolean)
    .join('\n');
  extractHsnTsnCandidates(textBlob).forEach((pair) => out.add(pair));

  return Array.from(out);
}

function attachKTypeTrace(product, trace) {
  try {
    if (!product) return;
    product.ops = product.ops || {};
    product.ops.data_quality = {
      ...(product.ops.data_quality || {}),
      ktype_enrich_v1: {
        at_iso: new Date().toISOString(),
        ...(trace || {}),
      },
    };
  } catch {
    // ignore
  }
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

function clearKTypWarnings(product) {
  if (!(product?.notes?.warnings && Array.isArray(product.notes.warnings))) return;
  product.notes.warnings = product.notes.warnings.filter((w) => {
    const s = safeString(w);
    if (!s) return false;
    if (/^K-Typ nicht angereichert:/i.test(s)) return false;
    if (/^K-Typ konnte/i.test(s)) return false;
    if (/^K-Typ fehlt:/i.test(s)) return false;
    return true;
  });
}

async function resolveEvidenceUrls(query, { limit = 6 } = {}) {
  try {
    const web = await search(query, { limit, locale: 'de-DE' });
    const urls = Array.isArray(web?.results) ? web.results.map((r) => safeString(r?.url)).filter(Boolean) : [];
    if (urls.length) {
      return {
        engine: web.engine || 'web',
        urls: urls.slice(0, limit),
        results: (web.results || []).slice(0, limit).map((r) => ({ title: r?.title || '', link: r?.url || '' })),
      };
    }
  } catch {
    // ignore
  }
  return { engine: null, urls: [], results: [] };
}

function extractYearCandidates(text = '') {
  const s = String(text || '');
  const years = new Set();
  const single = s.match(/\b(19[5-9]\d|20[0-3]\d)\b/g) || [];
  for (const y of single) years.add(Number(y));
  // Ranges: 2010-2014, 2010 – 2014, 2010/2014
  const reRange = /\b(19[5-9]\d|20[0-3]\d)\b\s*(?:-|–|—|\/|bis|to)\s*\b(19[5-9]\d|20[0-3]\d)\b/gi;
  let m;
  while ((m = reRange.exec(s)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start > 20) continue; // avoid huge ranges
    for (let y = start; y <= end; y += 1) years.add(y);
  }
  return Array.from(years).filter((y) => Number.isFinite(y) && y >= 1950 && y <= 2035);
}

function extractCcmCandidates(text = '') {
  const s = String(text || '');
  const out = new Set();
  // Patterns like "950 ccm", "950cc", "ccm 950"
  const re = /\b(\d{2,4})\s*(?:ccm|cc)\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 50 && n <= 3000) out.add(n);
  }
  return Array.from(out);
}

function extractMotoModels(text = '', modelSet) {
  // Moto models can be short (even 1 char). We therefore tokenize more permissively
  // but still intersect with the known modelSet for the detected make.
  const tokens = (String(text || '').match(/\b[A-Za-z0-9]{1,6}\b/g) || []).map((t) =>
    String(t).toUpperCase().replace(/[^A-Z0-9]+/g, '')
  );
  const out = new Set();
  for (const tok of tokens) {
    if (tok && modelSet?.has(tok)) out.add(tok);
  }
  return Array.from(out);
}

function extractCcmNearModel(text = '', models = []) {
  const s = String(text || '');
  const out = new Set();
  for (const model of models) {
    const mTok = String(model || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
    if (!mTok) continue;
    // Common pattern: "XVS 950", "R 1200", "SM 125"
    const re = new RegExp(`\\b${mTok}\\b\\D{0,10}\\b(\\d{2,4})\\b`, 'g');
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 50 && n <= 3000) out.add(n);
    }
  }
  return Array.from(out);
}

// Negativ-Cache NUR für den Chat-Pfad: Chat persistiert das Produkt nie, d.h.
// ohne Cache wiederholt JEDER Chat-Turn auf demselben K-Typ-losen Fitment-Produkt
// den kompletten SerpAPI+Fetch-Wasserfall. Identify/Improve bleiben ungecacht.
const CHAT_NEGATIVE_CACHE = new Map(); // productId -> { atMs, failReason }
const CHAT_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

function markChatNegative(product, reason, failReason) {
  if (reason === 'chat' && product?.id) {
    CHAT_NEGATIVE_CACHE.set(product.id, { atMs: Date.now(), failReason: failReason || 'unknown' });
  }
}

async function enrichKTypIfPossible(product, { reason = 'identify', maxKTypes = 60 } = {}) {
  // Preconditions
  const catId = pickCategoryId(product);
  const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
  if (!fitmentMode) {
    attachKTypeTrace(product, { ok: false, reason: 'not_fitment_category', catId: catId || null });
    return { ok: false, reason: 'not_fitment_category' };
  }
  if (hasKTyp(product)) {
    attachKTypeTrace(product, { ok: false, reason: 'already_has_ktype', fitment_mode: fitmentMode, catId: catId || null });
    return { ok: false, reason: 'already_has_ktype' };
  }
  if (reason === 'chat' && product?.id) {
    const neg = CHAT_NEGATIVE_CACHE.get(product.id);
    if (neg) {
      const expired = Date.now() - neg.atMs >= CHAT_NEGATIVE_CACHE_TTL_MS;
      // missing_part_number invalidiert sich selbst, sobald das Produkt
      // inzwischen eine MPN hat (z. B. gerade per Chat-Card übernommen).
      const mpnNowPresent = neg.failReason === 'missing_part_number' && Boolean(pickPartNumber(product));
      if (expired || mpnNowPresent) {
        CHAT_NEGATIVE_CACHE.delete(product.id);
      } else {
        return { ok: false, reason: 'chat_negative_cached' };
      }
    }
  }
  const mpn = pickPartNumber(product);
  const mvl = fitmentMode === 'auto' ? await loadMvlIndex() : null;
  const moto = fitmentMode === 'moto' ? loadMotoIndex() : null;
  if (fitmentMode === 'auto' && mvl && !mvl.ok) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), 'K-Typ nicht angereichert: MVL Datensatz fehlt am Runtime.'])
    );
    attachKTypeTrace(product, {
      ok: false,
      reason: 'mvl_missing',
      fitment_mode: fitmentMode,
      catId: catId || null,
      mpn,
      mvl_path: mvl.jsonlPath || null,
      mvl_configured_path: mvl.configuredPath || null,
      mvl_gcs_uri: mvl.gcsUri || null,
      mvl_download: mvl.download || null,
    });
    markChatNegative(product, reason, 'mvl_missing');
    return { ok: false, reason: 'mvl_missing' };
  }
  if (fitmentMode === 'moto' && moto && !moto.ok) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), 'K-Typ nicht angereichert: Motorrad ePID Datensatz fehlt am Runtime.'])
    );
    attachKTypeTrace(product, {
      ok: false,
      reason: 'moto_missing',
      fitment_mode: fitmentMode,
      catId: catId || null,
      mpn,
      moto_path: moto.jsonlPath || null,
    });
    markChatNegative(product, reason, 'moto_missing');
    return { ok: false, reason: 'moto_missing' };
  }

  // Deterministic fast-path: if HSN/TSN is already present in product data, map it directly via MVL.
  // This avoids flaky web-dependency and works even without MPN.
  const localHsnTsn = fitmentMode === 'auto' ? collectLocalHsnTsnCandidates(product) : [];
  if (fitmentMode === 'auto' && mvl?.ok && localHsnTsn.length) {
    const mappedLocal = new Set();
    for (const pair of localHsnTsn) {
      const set = mvl.byHsnTsn.get(pair);
      if (!set) continue;
      for (const id of set.values()) mappedLocal.add(id);
    }
    const idsLocal = Array.from(mappedLocal).sort((a, b) => a - b).slice(0, maxKTypes);
    if (idsLocal.length) {
      product.details = product.details || {};
      product.details.attributes =
        product.details.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
      product.details.attributes['K-Typ'] = formatKTyp(idsLocal, { maxLen: 0 });
      attachKTypeTrace(product, {
        ok: true,
        reason,
        source: 'local_hsn_tsn',
        fitment_mode: fitmentMode,
        catId: catId || null,
        mpn: mpn || null,
        hsn_tsn: localHsnTsn,
        ktypes: idsLocal,
        mvl_path: mvl?.jsonlPath || null,
      });
      clearKTypWarnings(product);
      if (process.env.DEBUG_KTYPE) {
        console.log('[ktype] enriched', {
          productId: product?.id || null,
          fitmentMode,
          source: 'local_hsn_tsn',
          count: idsLocal.length,
          mpn: mpn || null,
          mvl: mvl.jsonlPath,
        });
      }
      return { ok: true, fitmentMode, ids: idsLocal };
    }
  }

  if (!mpn) {
    attachKTypeTrace(product, {
      ok: false,
      reason: 'missing_part_number',
      fitment_mode: fitmentMode,
      catId: catId || null,
      hsn_tsn: localHsnTsn,
      mvl_path: mvl?.jsonlPath || null,
      moto_path: moto?.jsonlPath || null,
    });
    markChatNegative(product, reason, 'missing_part_number');
    return { ok: false, reason: 'missing_part_number' };
  }

  const brand = safeString(product?.identification?.brand) || safeString(product?.details?.attributes?.Marke) || '';
  const typeHint = safeString(product?.details?.attributes?.Produktart) || safeString(product?.details?.attributes?.Bauteil) || '';
  const q = [brand, mpn, typeHint].filter(Boolean).join(' ').trim();
  const q2 =
    fitmentMode === 'auto'
      ? [brand, mpn, typeHint, 'HSN', 'TSN'].filter(Boolean).join(' ').trim()
      : [brand, mpn, typeHint, 'Motorrad', 'ePID'].filter(Boolean).join(' ').trim();
  const queries = Array.from(new Set([q, q2].filter(Boolean))).slice(0, 2);

  const mpnNeedle = normalizeNeedle(mpn);
  const hsnTsnFound = new Set();
  const platformHits = new Set();
  const motoHits = new Set();
  const sources = [];

  for (const query of queries) {
    const serp = await resolveEvidenceUrls(query, { limit: 6 });
    for (const url of serp.urls) {
      const fetched = await fetchText(url, { timeoutMs: 20_000 });
      if (!fetched?.ok || !fetched?.text) continue;
      const text = String(fetched.text);
      if (mpnNeedle && !normalizeNeedle(text).includes(mpnNeedle)) continue;

      if (fitmentMode === 'auto' && mvl?.ok) {
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
      }

      if (fitmentMode === 'moto' && moto?.ok) {
        const makes = extractVehicleMakes(text, moto.makes);
        const years = extractYearCandidates(text);
        for (const make of makes) {
          const modelSet = moto.modelsByMake.get(make) || new Set();
          const models = extractMotoModels(text, modelSet);
          const ccms = Array.from(
            new Set([...(extractCcmCandidates(text) || []), ...(extractCcmNearModel(text, models) || [])])
          );
          for (const model of models) {
            for (const ccm of ccms) {
              for (const year of years) {
                const key = `${make}|${model}|${ccm}|${year}`;
                const set = moto.byMakeModelCcmYear.get(key);
                if (!set) continue;
                for (const id of set.values()) motoHits.add(id);
              }
            }
          }
        }
      }

      sources.push({ url, via: fetched.via || 'fetch' });
      if (sources.length >= 6) break;
    }
    if (sources.length >= 6) break;
  }

  const mapped = new Set();
  if (fitmentMode === 'auto' && mvl?.ok) {
    for (const pair of hsnTsnFound.values()) {
      const set = mvl.byHsnTsn.get(pair);
      if (!set) continue;
      for (const id of set.values()) mapped.add(id);
    }
    if (mapped.size === 0) {
      for (const id of platformHits.values()) mapped.add(id);
    }
  } else if (fitmentMode === 'moto') {
    for (const id of motoHits.values()) mapped.add(id);
  }

  const ids = Array.from(mapped).sort((a, b) => a - b).slice(0, maxKTypes);
  if (!ids.length) {
    // Keep as warning (no guessing)
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), `K-Typ nicht angereichert: keine MVL-Matches aus Web-Evidence (${reason}).`])
    );
    attachKTypeTrace(product, {
      ok: false,
      reason: 'no_matches',
      fitment_mode: fitmentMode,
      catId: catId || null,
      mpn,
      queries,
      hsn_tsn: Array.from(hsnTsnFound),
      epids: Array.from(motoHits),
      sources,
      mvl_path: mvl?.jsonlPath || null,
      moto_path: moto?.jsonlPath || null,
    });
    markChatNegative(product, reason, 'no_matches');
    return { ok: false, reason: 'no_matches', fitmentMode, queries };
  }

  product.details = product.details || {};
  product.details.attributes = product.details.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  // Store full K-Type list (no truncation) to satisfy downstream sync + UI requirements.
  // If a downstream system cannot accept long values, that system must be adjusted (field type) rather than truncating here.
  product.details.attributes['K-Typ'] = formatKTyp(ids, { maxLen: 0 });
  attachKTypeTrace(product, {
    ok: true,
    reason,
    source: 'web_evidence',
    fitment_mode: fitmentMode,
    catId: catId || null,
    mpn,
    queries,
    hsn_tsn: Array.from(hsnTsnFound),
    epids: Array.from(motoHits),
    ktypes: ids,
    sources,
    mvl_path: mvl?.jsonlPath || null,
    moto_path: moto?.jsonlPath || null,
  });
  clearKTypWarnings(product);

  if (process.env.DEBUG_KTYPE) {
    console.log('[ktype] enriched', {
      productId: product?.id || null,
      fitmentMode,
      count: ids.length,
      mpn,
      mvl: mvl.jsonlPath,
    });
  }

  return { ok: true, fitmentMode, ids };
}

/**
 * Build a chat datasheet change card for a K-Typ value that enrichKTypIfPossible()
 * just added to the in-memory product. Chat pipelines never persist the product
 * directly — changes only reach Firestore via the "Übernehmen" change-card flow.
 * Returns null when there is nothing new to propose.
 */
function buildKTypDatasheetChange(product, { beforeValue = '' } = {}) {
  const attrs = product?.details?.attributes;
  const nowValue = attrs && typeof attrs === 'object' ? safeString(attrs['K-Typ']) : '';
  if (!nowValue || nowValue === safeString(beforeValue)) return null;
  const trace = product?.ops?.data_quality?.ktype_enrich_v1 || {};
  const count = nowValue.split('|').filter(Boolean).length;
  const via = trace.source === 'local_hsn_tsn' ? 'HSN/TSN' : 'Web-Beleg + MVL';
  return {
    summary: `K-Typ (Fahrzeugverwendungsliste) automatisch ermittelt: ${count} Fahrzeug${count === 1 ? '' : 'e'} via ${via}.`,
    confidence: 0.95,
    // FE-Contract (types.ts DatasheetChange.attributes) ist eine Map, KEIN Array —
    // ProductSheet.applyAssistantChange iteriert Object.entries(); ein Array
    // erzeugte dort details.attributes['0'] = {key,value}-Müll (Review 2026-07-16).
    attributes: { 'K-Typ': nowValue },
  };
}

module.exports = {
  enrichKTypIfPossible,
  buildKTypDatasheetChange,
  loadMvlIndex,
  resolveMvlPath,
  loadMotoIndex,
  resolveMotoPath,
};

