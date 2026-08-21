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

/**
 * Schlüsselnummern aus RECHERCHE-TEXT lesen (Chat-Antwort, Web-Auszug).
 *
 * Warum getrennt von extractHsnTsnCandidates(): der obige Leser verlangt die
 * Wörter "HSN" UND "TSN" um die Ziffern herum. Menschen und Webseiten schreiben
 * aber "0588/BDM" — genau die Form, in der der Chat am 17.08.2026 drei korrekte
 * Schlüsselnummern lieferte, die niemand las.
 *
 * Die lose Form "1234/ABC" ist zugleich die Form vieler Teilenummern. Deshalb
 * gilt hier zweifach Kontextpflicht:
 *  - es muss ein Schlüsselnummern-Stichwort in der Nähe stehen (HSN/TSN/KBA/
 *    Schlüsselnummer/Typschlüssel), und
 *  - direkt davor darf kein Teilenummern-Etikett stehen (Vergleichsnummer, OE,
 *    Artikelnummer …).
 *
 * Ein Fehlgriff bleibt trotzdem folgenlos: nachgeschlagen wird ausschließlich in
 * der MVL. Was dort nicht steht, erzeugt keinen K-Typ.
 */
const HSN_TSN_CONTEXT_RE = /\b(HSN|TSN|KBA|Schl(?:ü|ue)sselnummern?|Typschl(?:ü|ue)ssel)\b/gi;
// "nummern?" — der Plural ("Vergleichsnummern:") matchte vorher NIE (Review 2026-08-21).
const PART_NUMBER_LABEL_RE = /(vergleichs|artikel|teile|ersatzteil|referenz|bestell|oe[m]?[-\s]?)\s*(nummern?|nr\.?)?\s*[:=]?\s*$/i;
const EVIDENCE_WINDOW_CHARS = 200;

function extractHsnTsnFromEvidenceText(text = '') {
  const s = String(text || '');
  if (!s) return [];
  const out = new Set();

  // Alle Kandidaten im GANZEN Text finden (Index-sortiert) …
  const candidates = [];
  {
    // "0588/BDM", "0588-BDM"
    const slash = /(\d{4})\s*[/\-]\s*([A-Za-z0-9]{3})\b/g;
    // "0588 BDM" — mindestens ein Buchstabe, sonst schluckt es "0588 123".
    const spaced = /(\d{4})\s+(?=[A-Za-z0-9]{3}\b)([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)\b/g;
    for (const re of [slash, spaced]) {
      let m;
      while ((m = re.exec(s)) !== null) {
        candidates.push({ index: m.index, end: m.index + m[0].length, h: m[1], t: String(m[2] || '').toUpperCase() });
      }
    }
    candidates.sort((a, b) => a.index - b.index);
  }

  // … und per Reichweiten-KETTE akzeptieren: jedes akzeptierte Paar verlaengert
  // das Lesefenster um EVIDENCE_WINDOW_CHARS. Ein starres Fenster las am
  // 21.08.2026 nur 8 von 12 aufgelisteten Schluesselnummern — die Liste war
  // laenger als 200 Zeichen, der Rest fiel wortlos unter den Tisch.
  HSN_TSN_CONTEXT_RE.lastIndex = 0;
  let marker;
  while ((marker = HSN_TSN_CONTEXT_RE.exec(s)) !== null) {
    let reach = marker.index + EVIDENCE_WINDOW_CHARS;
    for (const cand of candidates) {
      if (cand.index < marker.index) continue;
      if (cand.index > reach) break;
      const before = s.slice(Math.max(0, cand.index - 40), cand.index);
      // Teilenummern-Etikett = KONTEXTWECHSEL: ab hier folgt eine Teilenummern-
      // Liste, die Kette endet (nicht nur dieses Paar ueberspringen — sonst
      // frisst sich die Reichweite durch die ganze Liste; Review 2026-08-21).
      if (PART_NUMBER_LABEL_RE.test(before)) break;
      if (/^\d{4}$/.test(cand.h) && /^[A-Z0-9]{3}$/.test(cand.t)) {
        out.add(`${cand.h}|${cand.t}`);
        reach = Math.max(reach, cand.end + EVIDENCE_WINDOW_CHARS);
      }
    }
  }

  // Die ausgeschriebene Form ("HSN 0588, TSN BDM") kann der obige Leser besser.
  extractHsnTsnCandidates(s).forEach((pair) => out.add(pair));

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
  const records = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    records.push(JSON.parse(s));
  }
  const index = buildMvlIndexFromRecords(records);
  MVL_CACHE = {
    atMs: now,
    jsonlPath,
    configuredPath: configuredPath || null,
    download: download || null,
    gcsUri: resolveMvlGcsUri() || null,
    ...index,
  };
  return MVL_CACHE;
}

function tokenizeAlnum(text = '') {
  return String(text || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
}

function splitPlatformTokens(platform = '') {
  return safeString(platform)
    .toUpperCase()
    .split(/[,/\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * MVL-Index aus Compact-Records bauen — EINE Quelle fuer Produktion und Tests.
 *
 * Zusaetzlich zum bisherigen Index (byHsnTsn, byMakePlatform mit ROH-String):
 * - byMakePlatform bekommt jeden Komma-/Slash-Token einzeln: 10.711 von 55.851
 *   MVL-Zeilen tragen Listen wie "4MB, 4MG, 4MQ" — ein Titel-Token ("4MB")
 *   konnte den Roh-String-Schluessel nie treffen.
 * - byMakeModel + modelsByMake: die Fahrzeugnennung ("Audi Q7") steht in
 *   Autoteile-Titeln fast immer; der Modell-Index macht sie deterministisch
 *   nachschlagbar (resolveKTypFromVehicleSpec), samt platform/period fuer die
 *   Generations-Trennung.
 */
function buildMvlIndexFromRecords(records = []) {
  const byHsnTsn = new Map();
  const makes = new Set();
  const byMakePlatform = new Map();
  const byMakeModel = new Map(); // `${makeLower}|${MODEL TOKENS}` -> [{k, platform, period}]
  const modelsByMake = new Map(); // makeLower -> Map<modelKey, tokens[]>
  let parsed = 0;
  for (const rec of records) {
    parsed += 1;
    const k = Number(rec?.k);
    if (!Number.isFinite(k)) continue;
    const make = safeString(rec?.make);
    const makeLower = make ? make.toLowerCase() : '';
    if (makeLower) makes.add(makeLower);
    const platform = safeString(rec?.platform);
    if (makeLower && platform) {
      const keys = new Set([platform, ...splitPlatformTokens(platform)]);
      for (const token of keys) {
        const key = `${makeLower}|${token}`;
        const set = byMakePlatform.get(key) || new Set();
        set.add(k);
        byMakePlatform.set(key, set);
      }
    }
    const modelTokens = tokenizeAlnum(rec?.model);
    if (makeLower && modelTokens.length) {
      const modelKey = modelTokens.join(' ');
      const mm = modelsByMake.get(makeLower) || new Map();
      if (!mm.has(modelKey)) mm.set(modelKey, modelTokens);
      modelsByMake.set(makeLower, mm);
      const rowKey = `${makeLower}|${modelKey}`;
      const rows = byMakeModel.get(rowKey) || [];
      rows.push({ k, platform, period: safeString(rec?.period) });
      byMakeModel.set(rowKey, rows);
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
  return { ok: true, parsed, byHsnTsn, makes, byMakePlatform, byMakeModel, modelsByMake };
}

function resolveMotoGcsUri() {
  const direct = safeString(process.env.MOTO_JSONL_GCS_URI || '');
  if (direct) return direct;
  const bucket = normalizeBucketName(process.env.MVL_GCS_BUCKET || process.env.STORAGE_BUCKET) || 'prodsandjobs';
  const object = safeString(process.env.MOTO_GCS_OBJECT) || 'datasets/DE_Motorradliste_2025_06.compact.jsonl';
  if (!bucket || !object) return '';
  return `gs://${bucket}/${object.replace(/^\/+/, '')}`;
}

async function loadMotoIndex() {
  const now = Date.now();
  if (MOTO_CACHE && now - (MOTO_CACHE.atMs || 0) < MOTO_CACHE_TTL_MS) return MOTO_CACHE;

  let jsonlPath = resolveMotoPath();
  let download = null;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    // GCS-Fallback (Spiegel des MVL-Musters): sobald der Motorrad-ePID-Datensatz
    // unter gs://<bucket>/datasets/ liegt, funktioniert er auf allen Instanzen
    // ohne Redeploy. Stand 2026-07-16 existiert die Datei dort noch NICHT
    // (moto_missing) — Upload ist ein Operator-Schritt.
    const uri = resolveMotoGcsUri();
    const dest = path.join(os.tmpdir(), 'DE_Motorradliste_2025_06.compact.jsonl');
    download = await ensureMvlJsonlDownloaded({ uri, destinationPath: dest });
    if (download?.ok && download?.path && fs.existsSync(download.path)) {
      jsonlPath = download.path;
    }
  }
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    MOTO_CACHE = { atMs: now, ok: false, reason: 'moto_missing', jsonlPath: jsonlPath || null, download: download || null, gcsUri: resolveMotoGcsUri() || null };
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

function extractVehicleMakes(text, makeSet, { minLen = 3 } = {}) {
  const lower = String(text || '').toLowerCase();
  const found = new Set();
  for (const make of makeSet) {
    // minLen 2 gilt NUR fuer EIGENE Produktdaten (kontrollierter Text): "VW"
    // fiel dort bisher KOMPLETT durch (kein make-Treffer => kein Plattform-
    // Pfad). Web-Seiten behalten die 3er-Schranke — sonst waehlt "500 mg" oder
    // "DS" in gefetchtem Freitext eine Fahrzeugmarke (Review 2026-08-21).
    if (!make || make.length < minLen) continue;
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

/**
 * Fahrzeugbezogener Eigen-Text des Produkts: Titel, Kurzbeschreibung und
 * Kompatibilitäts-Attribute ("Passend für", "Fahrzeugmarke", …).
 * Teilenummern (MPN/OE) werden herausgeschnitten, damit plattform-ähnliche
 * Tokens aus Teilenummern (z. B. Bosch "…J27") nie als Fahrzeug-Plattform
 * fehlgedeutet werden können.
 */
function collectLocalFitmentText(product, { excludeValues = [] } = {}) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const compatKeyRe = /passend|kompatib|fahrzeug|vehicle|verwendung|modell|baureihe|plattform/i;
  const compatValues = Object.entries(attrs)
    .filter(([k]) => compatKeyRe.test(String(k || '')))
    .map(([, v]) => safeString(v))
    .filter(Boolean);
  let text = [
    safeString(product?.identification?.name),
    safeString(product?.details?.short_description),
    ...compatValues,
  ]
    .filter(Boolean)
    .join('\n');
  for (const raw of excludeValues) {
    const val = safeString(raw);
    if (!val) continue;
    text = text.split(val).join(' ');
  }
  return text.trim();
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

function parseExistingKTypIds(product) {
  const raw = safeString(product?.details?.attributes?.['K-Typ']);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[|,;]+/)
        .map((x) => safeString(x))
        .filter((x) => /^\d+$/.test(x))
        .map(Number)
    )
  );
}

/**
 * Bestehenden K-Typ-Wert ERWEITERN, ohne ihn neu zu formatieren.
 *
 * K-Typ darf Notizen tragen (`<id>,<note>|<id>,<note>` — siehe CLAUDE.md).
 * Ein Union-Rewrite ueber geparste Zahlen wuerde diese Notizen still loeschen
 * (Datenverlust-Klasse aus Punkt 16, Review-Befund 2026-08-21). Deshalb:
 * bestehende Eintraege bleiben VERBATIM stehen, neue IDs werden nur angehaengt.
 */
function buildExtendedKTypValue(existingRaw, newIds = [], cap = 60) {
  const raw = safeString(existingRaw);
  const sortedNew = Array.from(new Set((newIds || []).map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
  if (!raw) {
    const ids = cap > 0 ? sortedNew.slice(0, cap) : sortedNew;
    return { value: formatKTyp(ids, { maxLen: 0 }), added: ids.length, total: ids.length };
  }
  const entries = raw.split('|').map((e) => e.trim()).filter(Boolean);
  const existingIds = new Set();
  for (const e of entries) {
    const m = e.match(/^(\d+)/);
    if (m) existingIds.add(Number(m[1]));
  }
  const fresh = [];
  for (const id of sortedNew) {
    if (existingIds.has(id)) continue;
    if (cap > 0 && entries.length + fresh.length >= cap) break;
    fresh.push(String(id));
  }
  if (!fresh.length) return { value: raw, added: 0, total: entries.length };
  return { value: [...entries, ...fresh].join('|'), added: fresh.length, total: entries.length + fresh.length };
}

function parsePeriodYears(period = '') {
  const s = safeString(period);
  const m = s.match(/(\d{4})\s*\/\s*\d{1,2}\s*-\s*(?:(\d{4})\s*\/\s*\d{1,2})?/);
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isFinite(start)) return null;
  const end = m[2] ? Number(m[2]) : 2035; // offenes Ende = laeuft noch
  return { start, end: Number.isFinite(end) ? end : 2035 };
}

/**
 * Generations-Trennung: ein Modell-Treffer allein reicht NIE.
 * Erst Plattform-Token (praefix-tolerant: "4M" trifft 4MB/4MG/4MN), dann
 * Bauzeitraum-Ueberlappung. Ohne jeden Generations-Beleg: leere Menge —
 * sonst bekaeme ein 4M-Teil auch das alte Q7 (4LB) zugeschrieben.
 */
function pickGenerationRows(rows, { platCands = [], years = new Set() } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const withPlat = platCands.length
    ? rows.filter((r) => {
        const recToks = splitPlatformTokens(r.platform);
        return recToks.some((rt) => platCands.some((t) => rt === t || (t.length >= 2 && rt.startsWith(t))));
      })
    : [];
  if (!years.size) return withPlat;
  const base = withPlat.length ? withPlat : rows;
  return base.filter((r) => {
    const p = parsePeriodYears(r.period);
    if (!p) return false;
    for (const y of years) {
      if (y >= p.start && y <= p.end) return true;
    }
    return false;
  });
}

/**
 * K-Typ direkt aus der Fahrzeugnennung der EIGENEN Produktdaten aufloesen.
 *
 * Der HSN/TSN-Weg ist eine Lupe: jede Schluesselnummer ist EINE Homologation.
 * Gemessen am Vorfall 2026-08-21 (Airbag-Steuergeraet Audi Q7 4M + Q8):
 * 12 recherchierte Schluesselnummern -> 8 K-Typen; die MVL kennt fuer die
 * Baureihe ~44. Dieses Nachschlagen ist deterministisch (kein LLM):
 * Marke + Modell-Tokenfolge + Generations-Beleg (Plattform-Token/Baujahr)
 * gegen den MVL-Index. Was dort nicht steht, wird nicht geschrieben.
 */
function resolveKTypFromVehicleSpec(product, { mvl = null, maxKTypes = 60 } = {}) {
  const catId = pickCategoryId(product);
  const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
  if (fitmentMode !== 'auto') {
    return { ok: false, reason: fitmentMode ? 'not_auto_fitment' : 'not_fitment_category' };
  }
  const index = mvl;
  if (!index?.ok || !index.byMakeModel || !index.modelsByMake) return { ok: false, reason: 'mvl_missing' };

  const mpn = pickPartNumber(product);
  const fitmentText = collectLocalFitmentText(product, { excludeValues: [mpn] });
  if (!fitmentText) return { ok: false, reason: 'no_vehicle_text' };

  const textTokens = tokenizeAlnum(fitmentText);
  const makes = extractVehicleMakes(fitmentText, index.makes, { minLen: 2 });
  if (!makes.length) return { ok: false, reason: 'no_make' };

  // Baujahr zaehlt als Generations-Beleg, steht aber nicht im Fitment-Text
  // (collectLocalFitmentText kennt den Schluessel nicht) — explizit dazulesen.
  const attrs = product?.details?.attributes || {};
  const extra = product?.details?.attributes_extra || {};
  const yearText = [
    fitmentText,
    pickFromAttributes(attrs, ['Baujahr', 'Baujahre', 'Baujahr von', 'Baujahr bis']),
    pickFromAttributes(extra, ['Baujahr', 'Baujahre']),
  ]
    .filter(Boolean)
    .join('\n');
  const years = new Set(extractYearCandidates(yearText));

  // Plattform-Kandidaten: Tokens mit Buchstabe UND Ziffer (4M, B8, 8P) —
  // reine Buchstaben ("SRS", "SUV") und reine Zahlen (Masse) sind keine Plattform.
  const platCands = Array.from(
    new Set(textTokens.filter((t) => t.length >= 2 && t.length <= 6 && /[A-Z]/.test(t) && /\d/.test(t)))
  );

  // Explizite Modell-Attribute ("Modell":"X5") verankern kurze Modellnamen,
  // die im Fliesstext mehrdeutig waeren.
  const attrModelValues = new Set();
  for (const [k, v] of Object.entries(attrs)) {
    const norm = safeString(k).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!/^(modell|model|fahrzeugmodell|baureihe)$/.test(norm)) continue;
    const t = tokenizeAlnum(v).join(' ');
    if (t) attrModelValues.add(t);
  }

  // Tokens MIT Zeichen-Offsets — die Aufzuehlungs-Kette unten muss den Rohtext
  // zwischen zwei Modellnennungen auf Verbinder (&, Komma, "und") pruefen.
  const upperText = String(fitmentText).toUpperCase();
  const tokMatches = Array.from(upperText.matchAll(/[A-Z0-9]+/g));

  // Zwischen zwei Nennungen darf nur Aufzaehlung stehen: mindestens ein
  // Verbinder, sonst nur Leerraum und plattform-artige Kurztokens mit Ziffer
  // ("Q7 4M & Q8" ja, "Fiesta V GT" nein — da steht kein Verbinder).
  const hasEnumerationPath = (fromCharEnd, toCharStart) => {
    if (toCharStart <= fromCharEnd) return false;
    const between = upperText.slice(fromCharEnd, toCharStart);
    if (between.length > 40) return false;
    if (!/[,&+/]|\b(UND|ODER|BZW)\b/.test(between)) return false;
    const residue = between.replace(/\b(UND|ODER|BZW)\b/g, ' ').replace(/[,&+/().]/g, ' ');
    const toks = residue.match(/[A-Z0-9]+/g) || [];
    return toks.every((t) => t.length <= 6 && /\d/.test(t));
  };

  const hits = new Set();
  const matchedModels = [];
  let modelSeen = false;
  for (const make of makes) {
    const models = index.modelsByMake.get(make);
    if (!models) continue;
    const makeTok = tokenizeAlnum(make)[0] || '';
    const makePositions = [];
    textTokens.forEach((t, i) => {
      if (makeTok && t === makeTok) makePositions.push(i);
    });

    // Schritt 1: alle Modell-Nennungen einsammeln. Laengster Modellname gewinnt
    // an seiner Textposition — "Q8 E-Tron SUV" darf nicht zusaetzlich als "Q8"
    // (Verbrenner) zaehlen.
    const candidates = Array.from(models.values()).sort((a, b) => b.length - a.length);
    const claimed = new Set();
    const mentions = [];
    for (const modelTokens of candidates) {
      for (let i = 0; i + modelTokens.length <= textTokens.length; i += 1) {
        if (claimed.has(i)) continue;
        let all = true;
        for (let j = 0; j < modelTokens.length; j += 1) {
          if (textTokens[i + j] !== modelTokens[j]) {
            all = false;
            break;
          }
        }
        if (!all) continue;
        for (let j = 0; j < modelTokens.length; j += 1) claimed.add(i + j);
        const last = tokMatches[i + modelTokens.length - 1];
        mentions.push({
          modelTokens,
          i,
          startChar: tokMatches[i].index,
          endChar: last.index + last[0].length,
          // Kurze Einzeltoken-Modelle brauchen einen ANKER: reine Ziffern ("205"
          // — sonst wird jede Massangabe zum Modell) und Namen mit <=2 Zeichen
          // ("GT", "KA", "M3" — sonst wird jedes Ausstattungs-Kuerzel und jede
          // Gewindegroesse zum Modell; Dry-Run 2026-08-21: drei Fiesta-Produkte
          // matchten "Ford GT").
          needsAnchor: modelTokens.length === 1 && (/^\d+$/.test(modelTokens[0]) || modelTokens[0].length <= 2),
          accepted: false,
        });
      }
    }
    if (!mentions.length) continue;
    mentions.sort((a, b) => a.i - b.i);

    // Schritt 2: Anker aufloesen. Direkt-Anker: Modell ohne Anker-Pflicht,
    // Position direkt hinter der Marke, oder ausdrueckliches Modell-Attribut.
    // Ketten-Anker: haengt per Aufzaehlungs-Verbinder an einer bereits
    // akzeptierten Nennung ("Audi Q7 4M & Q8" -> Q8 zaehlt).
    for (const m of mentions) {
      if (!m.needsAnchor) m.accepted = true;
      else if (makePositions.some((p) => m.i - p >= 1 && m.i - p <= 2)) m.accepted = true;
      else if (attrModelValues.has(m.modelTokens.join(' '))) m.accepted = true;
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of mentions) {
        if (m.accepted) continue;
        const chained = mentions.some(
          (o) => o.accepted && o !== m && hasEnumerationPath(o.endChar, m.startChar)
        );
        if (chained) {
          m.accepted = true;
          changed = true;
        }
      }
    }

    // Schritt 3: akzeptierte Nennungen gegen die MVL aufloesen (Generations-Gate).
    for (const m of mentions) {
      if (!m.accepted) continue;
      modelSeen = true;
      const rows = index.byMakeModel.get(`${make}|${m.modelTokens.join(' ')}`) || [];
      const chosen = pickGenerationRows(rows, { platCands, years });
      if (chosen.length) {
        const label = `${make}|${m.modelTokens.join(' ')}`;
        // Titel UND Modell-Attribut nennen dasselbe Fahrzeug — nur einmal listen.
        if (!matchedModels.some((x) => `${x.make}|${x.model}` === label)) {
          matchedModels.push({ make, model: m.modelTokens.join(' '), rows: chosen.length });
        }
        chosen.forEach((r) => hits.add(r.k));
      }
    }
  }

  if (!hits.size) {
    return { ok: false, reason: modelSeen ? 'vehicle_generation_unresolved' : 'no_model' };
  }
  const ids = Array.from(hits)
    .sort((a, b) => a - b)
    .slice(0, maxKTypes);
  return {
    ok: true,
    ids,
    matched: matchedModels,
    evidence: {
      platform_tokens: platCands,
      years: years.size ? [Math.min(...years), Math.max(...years)] : [],
    },
  };
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

async function enrichKTypIfPossible(product, { reason = 'identify', maxKTypes = 60, mvl: injectedMvl = null } = {}) {
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
  const mvl = fitmentMode === 'auto' ? injectedMvl || (await loadMvlIndex()) : null;
  const moto = fitmentMode === 'moto' ? await loadMotoIndex() : null;
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

  // Deterministic fast-path 2: Fahrzeug-MODELL + Generations-Beleg (Plattform-
  // Token oder Baujahr) aus den eigenen Produktdaten. Praeziser als der
  // Marke+Plattform-Pfad darunter (Modell-Gate + Generations-Trennung) und
  // braucht KEIN MPN — laeuft deshalb VOR der missing_part_number-Schranke.
  if (fitmentMode === 'auto' && mvl?.ok) {
    const vspec = resolveKTypFromVehicleSpec(product, { mvl, maxKTypes });
    if (vspec.ok && vspec.ids.length) {
      product.details = product.details || {};
      product.details.attributes =
        product.details.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
      product.details.attributes['K-Typ'] = formatKTyp(vspec.ids, { maxLen: 0 });
      attachKTypeTrace(product, {
        ok: true,
        reason,
        source: 'local_vehicle_model',
        fitment_mode: fitmentMode,
        catId: catId || null,
        mpn: mpn || null,
        matched: vspec.matched,
        evidence: vspec.evidence,
        ktypes: vspec.ids,
        mvl_path: mvl?.jsonlPath || null,
      });
      clearKTypWarnings(product);
      if (process.env.DEBUG_KTYPE) {
        console.log('[ktype] enriched', {
          productId: product?.id || null,
          fitmentMode,
          source: 'local_vehicle_model',
          count: vspec.ids.length,
          matched: vspec.matched,
        });
      }
      return { ok: true, fitmentMode, ids: vspec.ids };
    }
  }

  // Deterministic fast-path 3: Fahrzeugmarke + Plattform-Token aus den EIGENEN
  // Produktdaten (Titel/Kompatibilitäts-Attribute) gegen die MVL mappen.
  // Autoteile-Titel tragen die Verwendung fast immer ("… für Audi A4 B8 …"),
  // während Web-Seiten selten HSN/TSN nennen — genau daran scheiterten 39 von
  // 48 Rest-Produkten (Audit 2026-07-16). Gleicher No-Guessing-Vertrag wie der
  // Web-Pfad: nur exakte make|platform-Treffer in der MVL zählen; das Make-Gate
  // verhindert, dass Teilenummern-Tokens ohne Fahrzeugmarke je matchen.
  if (fitmentMode === 'auto' && mvl?.ok) {
    const fitmentText = collectLocalFitmentText(product, { excludeValues: [mpn] });
    if (fitmentText) {
      const localMakes = extractVehicleMakes(fitmentText, mvl.makes, { minLen: 2 });
      const localPlatformHits = new Set();
      const matchedKeys = [];
      if (localMakes.length) {
        // Nur Tokens mit mindestens einem Buchstaben (B8, W169, F45) — reine
        // Zahlen-Tokens (Maße, Mengen) sind keine belastbare Plattform-Evidenz.
        const tokens = extractPlatformTokens(fitmentText).filter((t) => /[A-Z]/i.test(t));
        for (const make of localMakes) {
          for (const tok of tokens) {
            const set = mvl.byMakePlatform.get(`${make}|${tok}`);
            if (!set) continue;
            matchedKeys.push(`${make}|${tok}`);
            for (const id of set.values()) localPlatformHits.add(id);
          }
        }
      }
      const idsLocalMp = Array.from(localPlatformHits).sort((a, b) => a - b).slice(0, maxKTypes);
      if (idsLocalMp.length) {
        product.details = product.details || {};
        product.details.attributes =
          product.details.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
        product.details.attributes['K-Typ'] = formatKTyp(idsLocalMp, { maxLen: 0 });
        attachKTypeTrace(product, {
          ok: true,
          reason,
          source: 'local_make_platform',
          fitment_mode: fitmentMode,
          catId: catId || null,
          mpn: mpn || null,
          matched: matchedKeys.slice(0, 20),
          ktypes: idsLocalMp,
          mvl_path: mvl?.jsonlPath || null,
        });
        clearKTypWarnings(product);
        if (process.env.DEBUG_KTYPE) {
          console.log('[ktype] enriched', {
            productId: product?.id || null,
            fitmentMode,
            source: 'local_make_platform',
            count: idsLocalMp.length,
            matched: matchedKeys.slice(0, 5),
          });
        }
        return { ok: true, fitmentMode, ids: idsLocalMp };
      }
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
  // Eintraege koennen Notizen tragen ("113153,Audi Q7") — fuer den Vergleich
  // zaehlt die fuehrende ID, nicht der Roh-String.
  const idOf = (e) => {
    const m = safeString(e).match(/^(\d+)/);
    return m ? m[1] : safeString(e);
  };
  const nowEntries = nowValue.split('|').map((x) => safeString(x)).filter(Boolean);
  const count = nowEntries.length;
  const beforeIds = new Set(
    safeString(beforeValue)
      .split('|')
      .map(idOf)
      .filter(Boolean)
  );
  const addedCount = nowEntries.map(idOf).filter((id) => !beforeIds.has(id)).length;
  const viaMap = {
    local_hsn_tsn: 'HSN/TSN',
    chat_evidence_hsn_tsn: 'HSN/TSN (Chat-Recherche)',
    local_vehicle_model: 'Fahrzeugmodell + eBay-Fahrzeugliste',
  };
  const via = viaMap[trace.source] || 'Web-Beleg + MVL';
  const summary = beforeIds.size
    ? `K-Typ (Fahrzeugverwendungsliste) erweitert: +${addedCount} auf ${count} Fahrzeuge via ${via}. Bestehende Eintraege bleiben erhalten.`
    : `K-Typ (Fahrzeugverwendungsliste) automatisch ermittelt: ${count} Fahrzeug${count === 1 ? '' : 'e'} via ${via}.`;
  return {
    summary,
    confidence: 0.95,
    // FE-Contract (types.ts DatasheetChange.attributes) ist eine Map, KEIN Array —
    // ProductSheet.applyAssistantChange iteriert Object.entries(); ein Array
    // erzeugte dort details.attributes['0'] = {key,value}-Müll (Review 2026-07-16).
    attributes: { 'K-Typ': nowValue },
  };
}

/**
 * Alles einsammeln, was in einer Chat-Antwort nach Schlüsselnummer aussieht.
 *
 * Zwei Quellen, weil das Modell den Beleg auf zwei Wegen ausliefert: in der
 * Antwort-Prosa und — wenn es kein passendes Feld findet — in einem selbst
 * erfundenen Merkmal ("Vergleichsnummer"). Beides ist inhaltlich richtige
 * Recherche und darf nicht verloren gehen, nur weil die Ablage falsch war.
 *
 * Merkmale kommen je nach Pipeline als Map (V2) oder als Liste (V3).
 */
function collectHsnTsnFromChatResult(chatResult) {
  if (!chatResult || typeof chatResult !== 'object') return [];
  const parts = [safeString(chatResult.message)];

  const changes = Array.isArray(chatResult.datasheetChanges) ? chatResult.datasheetChanges : [];
  changes.forEach((change) => {
    const attrs = change?.attributes;
    if (!attrs) return;
    if (Array.isArray(attrs)) {
      attrs.forEach((a) => parts.push(`${safeString(a?.key || a?.name)} ${safeString(a?.value)}`));
      return;
    }
    if (typeof attrs === 'object') {
      Object.entries(attrs).forEach(([k, v]) => parts.push(`${safeString(k)} ${safeString(v)}`));
    }
  });

  return extractHsnTsnFromEvidenceText(parts.filter(Boolean).join('\n'));
}

/**
 * K-Typ aus NACHGEREICHTEM Beleg setzen (Schlüsselnummern aus der Chat-Recherche).
 *
 * enrichKTypIfPossible() startet im Chat parallel zum Modell-Aufruf und liest
 * deshalb nur, was schon im Produkt stand. Was das Modell im selben Zug
 * herausfindet, kommt zu spät. Dieser Weg holt das nach — mit denselben
 * Regeln: nur Fahrzeug-Kategorien, nur echte MVL-Treffer, nie raten, und ein
 * bestehender K-Typ bleibt unangetastet.
 */
async function enrichKTypFromHsnTsnEvidence(
  product,
  pairs = [],
  { mvl = null, maxKTypes = 60, reason = 'chat_evidence', extendExisting = false } = {}
) {
  const list = Array.from(
    new Set(
      (Array.isArray(pairs) ? pairs : [])
        .map((p) => normalizeHsnTsn(p) || safeString(p).toUpperCase())
        .filter((p) => /^\d{4}\|[A-Z0-9]{3}$/.test(p))
    )
  );
  if (!list.length) return { ok: false, reason: 'no_evidence' };

  const catId = pickCategoryId(product);
  const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
  // Die Schlüsselnummer ist eine PKW-Kennung; die Motorrad-Liste kennt sie nicht.
  if (fitmentMode !== 'auto') {
    return { ok: false, reason: fitmentMode ? 'not_auto_fitment' : 'not_fitment_category' };
  }
  // extendExisting (nur Chat mit ausdruecklicher K-Typ-Frage): ein gefuellter
  // K-Typ wird per Union ERWEITERT statt still uebersprungen. Bestand fliegt
  // nie raus. Ohne das Flag: bisheriges Verhalten (unangetastet).
  if (hasKTyp(product) && !extendExisting) return { ok: false, reason: 'already_has_ktype' };

  const index = mvl || (await loadMvlIndex());
  if (!index?.ok) return { ok: false, reason: 'mvl_missing' };

  const mapped = new Set();
  for (const pair of list) {
    const set = index.byHsnTsn.get(pair);
    if (!set) continue;
    for (const id of set.values()) mapped.add(id);
  }
  const newIds = Array.from(mapped)
    .sort((a, b) => a - b)
    .slice(0, maxKTypes);
  if (!newIds.length) return { ok: false, reason: 'no_mvl_match', hsnTsn: list };

  const existingRaw = safeString(product?.details?.attributes?.['K-Typ']);
  const ext = buildExtendedKTypValue(existingRaw, newIds, maxKTypes);
  if (existingRaw && ext.added === 0) {
    return { ok: false, reason: 'no_new_ids', hsnTsn: list };
  }
  const ids = newIds;

  product.details = product.details || {};
  product.details.attributes =
    product.details.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  product.details.attributes['K-Typ'] = ext.value;
  attachKTypeTrace(product, {
    ok: true,
    reason,
    source: 'chat_evidence_hsn_tsn',
    fitment_mode: fitmentMode,
    catId: catId || null,
    hsn_tsn: list,
    ktypes: ids,
    mvl_path: index?.jsonlPath || null,
  });
  clearKTypWarnings(product);
  return { ok: true, fitmentMode, ids, hsnTsn: list };
}

// "K-Typ bitte", "KTyp fuellen", "Fahrzeugverwendungsliste ergaenzen" — die
// ausdrueckliche K-Typ-Frage schaltet den Erweitern-Modus frei. Bewusst eng:
// "Typ" allein, "Kompatibilitaet" oder "k typisch" zaehlen nicht (die
// Suffix-Liste ist geschlossen, kein \w* — Review-Befund 2026-08-21).
const KTYP_INTENT_RE = /\bk[\s\-–]?typ(?:en|s|nummern?|liste)?\b|fahrzeugverwendungsliste|\bfahrzeugliste\b|\bmvl\b/i;

function isKTypIntentMessage(message = '') {
  return KTYP_INTENT_RE.test(String(message || ''));
}

/**
 * Der deterministische K-Typ-Zug NACH der Modell-Antwort (alle Chat-Pipelines).
 *
 * Vorfall 2026-08-21 ("k-typ bitte", SKU-7093518261): Das Feld trug 5 von ~44
 * Fahrzeugen, und der Chat schwieg komplett, weil "bestehender K-Typ bleibt
 * unangetastet" — fuer den Bediener ununterscheidbar von "kann es nicht".
 *
 * Regeln:
 * - Leeres Feld: fuellen (Schluesselnummern-Ernte + Fahrzeugnennung), wie bisher.
 * - Gefuelltes Feld + K-Typ-Frage: per Union ERWEITERN (Bestand bleibt).
 * - Gefuelltes Feld ohne K-Typ-Frage: nicht anfassen (bisheriges Verhalten).
 * Persistiert wird weiterhin NUR ueber die "Uebernehmen"-Change-Card.
 */
async function resolveKTypForChatTurn(product, chatResult, { userMessage = '', mvl = null, maxKTypes = 60 } = {}) {
  const intent = isKTypIntentMessage(userMessage);
  const beforeIds = parseExistingKTypIds(product);
  const hadValue = beforeIds.length > 0;
  const out = { intent, status: 'noop', beforeCount: beforeIds.length, nowCount: beforeIds.length, addedCount: 0 };

  const catId = pickCategoryId(product);
  const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
  if (fitmentMode !== 'auto') {
    out.status = fitmentMode ? 'not_auto_fitment' : 'not_fitment_category';
    return out;
  }
  if (hadValue && !intent) {
    out.status = 'kept_existing';
    return out;
  }

  const index = mvl || (await loadMvlIndex());
  if (!index?.ok) {
    out.status = 'mvl_missing';
    return out;
  }

  // 1) Schluesselnummern aus der SOEBEN gelieferten Antwort ernten (Prosa +
  //    Change-Cards) und gegen die MVL aufloesen.
  const pairs = collectHsnTsnFromChatResult(chatResult);
  if (pairs.length) {
    const res = await enrichKTypFromHsnTsnEvidence(product, pairs, {
      mvl: index,
      maxKTypes,
      reason: 'chat_evidence',
      extendExisting: intent,
    });
    if (res?.ok || res?.reason) out.evidence = { pairs, result: res?.ok ? 'ok' : res?.reason };
  }

  // 2) Fahrzeugnennung der eigenen Produktdaten — holt die GANZE Baureihe,
  //    nicht nur die recherchierten Einzel-Homologationen.
  const vspec = resolveKTypFromVehicleSpec(product, { mvl: index, maxKTypes });
  if (vspec.ok && vspec.ids.length) {
    const merged = buildExtendedKTypValue(
      product?.details?.attributes?.['K-Typ'],
      vspec.ids,
      maxKTypes
    );
    if (merged.added > 0) {
      product.details = product.details || {};
      product.details.attributes =
        product.details.attributes && typeof product.details.attributes === 'object'
          ? product.details.attributes
          : {};
      product.details.attributes['K-Typ'] = merged.value;
      attachKTypeTrace(product, {
        ok: true,
        reason: 'chat',
        source: 'local_vehicle_model',
        fitment_mode: fitmentMode,
        catId: catId || null,
        matched: vspec.matched,
        evidence: vspec.evidence,
        ktypes: vspec.ids,
        mvl_path: index?.jsonlPath || null,
      });
      clearKTypWarnings(product);
    }
  } else if (vspec.reason) {
    out.vehicleSpec = vspec.reason;
  }

  const nowIds = parseExistingKTypIds(product);
  const beforeSet = new Set(beforeIds);
  out.nowCount = nowIds.length;
  out.addedCount = nowIds.filter((id) => !beforeSet.has(id)).length;
  if (out.addedCount > 0) out.status = hadValue ? 'extended' : 'filled';
  else out.status = hadValue ? 'already_set' : 'no_evidence';
  return out;
}

module.exports = {
  enrichKTypIfPossible,
  enrichKTypFromHsnTsnEvidence,
  extractHsnTsnFromEvidenceText,
  collectHsnTsnFromChatResult,
  buildKTypDatasheetChange,
  buildExtendedKTypValue,
  buildMvlIndexFromRecords,
  resolveKTypFromVehicleSpec,
  resolveKTypForChatTurn,
  isKTypIntentMessage,
  collectLocalFitmentText,
  loadMvlIndex,
  resolveMvlPath,
  loadMotoIndex,
  resolveMotoPath,
};

