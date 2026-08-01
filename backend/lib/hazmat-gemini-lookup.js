'use strict';

/**
 * hazmat-gemini-lookup.js — Gemini-Lookup fuer GHS/CLP-Gefahrstoff-Kennzeichnung
 * (Sicherheitsdatenblatt, Signalwort, H-/P-Saetze) + regulatorische Pflicht-
 * Kennzeichnung (Biozid).
 *
 * Warum: Kaufland lehnt Chemie-/Pflegeprodukte ohne CLP-Attribute ab
 * ("Fehlend: Sicherheitsdatenblatt, Signalwort, Gefahrenhinweise,
 * Sicherheitsinfo (P-Saetze)" bzw. "Fehlend: Biozid"). Diese Library liefert
 * die Daten verifiziert an — die Verdrahtung in den Kaufland-Enricher passiert
 * in einer Folge-Phase (dieses Modul aendert KEINE bestehenden Code-Pfade).
 *
 * Muster: eng an lib/gpsr-gemini-lookup.js angelehnt — Gemini-3-Flash via
 * gemini3GenerateJSON (Recherche-Auftrag + striktes JSON-Schema), Firestore-
 * Cache mit TTL, Normalisierung, Fehler → null.
 *
 * COMPLIANCE-GUARDS (Kern dieses Moduls):
 *   1. VERIFIKATIONS-GUARD: eine SDS-URL gilt erst als "verified", wenn sie
 *      per HTTP geladen wurde und die Response mit den PDF-Magic-Bytes
 *      "%PDF-" beginnt. HTML-Seiten / Redirect-Landingpages → verified=false,
 *      verifiedSdsUrl=null. Es wird NIE geraten.
 *   2. KEINE ERFUNDENEN SAETZE: liefert Gemini KEINE SDS-URL, werden H-/P-
 *      Saetze verworfen (nicht belegbar). Der Prompt verbietet Erfindungen
 *      zusaetzlich explizit.
 *   3. ENUM-STRIKT: signalwort ist EXAKT einer von
 *      'Gefahr' | 'Achtung' | 'Kein Signalwort' — alles andere → null.
 *   4. FORMAT-STRIKT: H-/P-Saetze werden auf "CODE deutscher CLP-Text"
 *      normalisiert (Doppelpunkt nach dem Code entfernt, Kombinationscodes
 *      wie P403+P235 erlaubt). Eintraege ohne gueltigen CLP-Code oder ohne
 *      Text werden verworfen.
 *
 * Cache: Firestore-Collection 'hazmat_lookup_cache', Doc-Key = EAN
 * (digits-only), TTL 30 Tage. Auch NEGATIVE Ergebnisse werden gecacht, damit
 * ein Produkt ohne auffindbares SDS nicht bei jedem Sync-Lauf erneut einen
 * Gemini-Call ausloest.
 *
 * Safety:
 *   - Per-Call Hard-Timeout (Gemini: 20s default, SDS-Fetch: 15s default)
 *   - Alle Fehler geschluckt → lookup gibt null zurueck (Transient-Fehler
 *     werden NICHT gecacht)
 *   - Dieses Modul schreibt NIE nach products_v2 — Caller nutzen saveProductV2()
 *   - Additiv: kein bestehender Code-Pfad wird durch require dieses Files geaendert
 */

const { gemini3GenerateJSON } = require('./gemini3-client');
const logger = (() => {
  try { return require('./logger'); } catch { return { warn: () => {}, info: () => {} }; }
})();

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SDS_FETCH_TIMEOUT_MS = 15000;
const MAX_SDS_BYTES = 25 * 1024 * 1024; // 25 MB Download-Guard
const CACHE_COLLECTION = 'hazmat_lookup_cache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
const PDF_MAGIC = '%PDF-';
const SIGNALWORT_VALUES = ['Gefahr', 'Achtung', 'Kein Signalwort'];
const MAX_CLP_ENTRIES = 25;
const MAX_SOURCES = 10;

// Browser-artiger User-Agent — viele Hersteller-Sites blocken generische Agents.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

// Lazy Firestore client — gleiches Muster wie gpsr-gemini-lookup.js, um
// zirkulaere Dependencies mit lib/firestore.js zu vermeiden.
let _firestore = null;
function _getFirestore() {
  if (!_firestore) {
    const { Firestore } = require('@google-cloud/firestore');
    _firestore = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
    });
  }
  return _firestore;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Gemini gibt gelegentlich Sentinel-Strings statt JSON-null zurueck.
 */
function cleanupSentinel(v) {
  const s = safeString(v);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (['null', 'n/a', 'na', 'unbekannt', 'unknown', 'none', '-', '—'].includes(lower)) return null;
  return s;
}

/**
 * Stabiler Cache-Key aus einer EAN: digits-only. Mindestens 8 Stellen
 * (EAN-8), sonst kein Cache-Key (→ Lookup laeuft, wird aber nicht gecacht).
 */
function eanCacheKey(ean) {
  const digits = safeString(ean).replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 14) return '';
  return digits;
}

/**
 * Signalwort-Normalisierung: EXAKT einer der 3 Kaufland-Enum-Werte,
 * alles andere → null. Englische CLP-Aequivalente werden gemappt.
 */
function normalizeSignalwort(v) {
  const s = cleanupSentinel(v);
  if (!s) return null;
  const lower = s.toLowerCase().replace(/[.!]+$/, '').trim();
  if (lower === 'gefahr' || lower === 'danger') return 'Gefahr';
  if (lower === 'achtung' || lower === 'warning') return 'Achtung';
  if (
    lower === 'kein signalwort'
    || lower === 'kein'
    || lower === 'keins'
    || lower === 'keines'
    || lower === 'entfaellt'
    || lower === 'entfällt'
    || lower === 'no signal word'
    || lower === 'not applicable'
  ) {
    return 'Kein Signalwort';
  }
  return null;
}

// Einzelner CLP-Code-Token: H226, EUH208, P280, H360FD, P501 …
const CLP_TOKEN_RE = /^(euh|h|p)\s*(\d{3})([a-z]{0,2})$/i;
// Ganzer Eintrag: Code(-Kombination) + Separator (:/-/–) + Text.
const CLP_ENTRY_RE = /^((?:EUH|H|P)\s*\d{3}[A-Za-z]{0,2}(?:\s*\+\s*(?:EUH|H|P)\s*\d{3}[A-Za-z]{0,2})*)\s*[:\-–—]?\s*(.*)$/i;

/**
 * Normalisiert einen einzelnen H-/P-Satz auf das Kaufland-Format
 * "CODE deutscher CLP-Text" (ohne Doppelpunkt nach dem Code).
 *
 *   "H226: Fluessigkeit und Dampf entzuendbar."  → "H226 Fluessigkeit und Dampf entzuendbar."
 *   "P403 + P235: …"                             → "P403+P235 …"
 *
 * Verworfen (→ null): Eintraege ohne gueltigen CLP-Code, ohne Text
 * (wir erfinden NIE CLP-Text zu einem nackten Code) oder mit falscher
 * Familie (H-Liste darf nur H/EUH enthalten, P-Liste nur P).
 *
 * @param {string} raw
 * @param {'H'|'P'} family
 * @returns {string|null}
 */
function normalizeClpEntry(raw, family) {
  const s = cleanupSentinel(raw);
  if (!s) return null;
  const compact = s.replace(/\s+/g, ' ').trim();
  const m = compact.match(CLP_ENTRY_RE);
  if (!m) return null;

  const tokens = m[1].split('+').map((t) => {
    const tm = t.trim().match(CLP_TOKEN_RE);
    if (!tm) return null;
    // Prefix uppercase, Suffix-Buchstaben originalgetreu (H361d vs H360FD).
    return `${tm[1].toUpperCase()}${tm[2]}${tm[3]}`;
  });
  if (tokens.length === 0 || tokens.some((t) => !t)) return null;

  const head = tokens[0];
  if (family === 'H' && !(head.startsWith('H') || head.startsWith('EUH'))) return null;
  if (family === 'P' && !head.startsWith('P')) return null;

  const text = cleanupSentinel(m[2].replace(/^[:\-–—]\s*/, ''));
  if (!text) return null;

  return `${tokens.join('+')} ${text}`;
}

/**
 * Normalisiert eine Liste von H-/P-Saetzen (dedupe, cap, Familien-Filter).
 * @param {unknown} list
 * @param {'H'|'P'} family
 * @returns {string[]}
 */
function normalizeClpList(list, family) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const normalized = normalizeClpEntry(raw, family);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_CLP_ENTRIES) break;
  }
  return out;
}

function normalizeUrl(v) {
  const s = cleanupSentinel(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * JSON-Schema (Gemini 3 SDK) fuer die strukturierte Antwort.
 * Bei requestedFields=['biozid'] wird das Schema um die Biozid-Felder erweitert.
 */
function buildSchema({ includeBiozid } = {}) {
  const properties = {
    sds_url: { type: 'string', description: 'DIREKTE URL zum offiziellen Sicherheitsdatenblatt-PDF. Leer wenn kein SDS auffindbar.' },
    signalwort: { type: 'string', description: "EXAKT einer von 'Gefahr' | 'Achtung' | 'Kein Signalwort'. Leer wenn unbekannt." },
    h_saetze: { type: 'array', items: { type: 'string' }, description: "Gefahrenhinweise: 'Code + deutscher CLP-Text ohne Doppelpunkt', z.B. 'H226 Fluessigkeit und Dampf entzuendbar.'" },
    p_saetze: { type: 'array', items: { type: 'string' }, description: "Sicherheitshinweise (P-Saetze) im gleichen Format, Kombinationscodes erlaubt, z.B. 'P403+P235 An einem gut belueftbaren Ort aufbewahren. Kuehl halten.'" },
    confidence: { type: 'number', description: 'Wie sicher du bist, dass die Angaben zum konkreten Produkt gehoeren (0..1).' },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs, aus denen die Angaben belegt sind.' },
  };
  if (includeBiozid) {
    properties.biozid = { type: 'string', description: 'Deutsche Pflicht-Kennzeichnung fuer Biozid-/Pflanzenschutzprodukte (Pflichtwarnhinweis bzw. BAUA-/Zulassungsnummer). Leer ohne Quelle.' };
    properties.biozid_sources = { type: 'array', items: { type: 'string' }, description: 'URLs, die die Biozid-Angabe belegen.' };
  }
  return {
    type: 'object',
    properties,
    required: ['confidence'],
  };
}

function buildPrompt({ ean, brand, title, includeBiozid }) {
  const ident = [];
  const t = safeString(title);
  const b = safeString(brand);
  const e = safeString(ean);
  if (t) ident.push(`- Produkt: ${t}`);
  if (b) ident.push(`- Marke: ${b}`);
  if (e) ident.push(`- EAN/GTIN: ${e}`);

  const lines = [
    'Du bist Compliance-Rechercheur fuer Gefahrstoff-Kennzeichnung nach CLP/GHS (EU-Verordnung 1272/2008).',
    'Finde das OFFIZIELLE Sicherheitsdatenblatt (SDS) des folgenden Produkts — oder eines identischen Produkts desselben Herstellers:',
    ...ident,
    '',
    'Suche im Web: Hersteller-Website, offizielle Haendler-Produktseiten, SDS-Datenbanken.',
    'Extrahiere aus dem Sicherheitsdatenblatt (Abschnitt 2: Moegliche Gefahren) bzw. der offiziellen Produktseite:',
    '- sds_url: die DIREKTE URL zur SDS-PDF-Datei (KEINE HTML-Seite, KEIN Downloadportal-Link). Wenn kein SDS auffindbar: leerer String.',
    "- signalwort: EXAKT einer von 'Gefahr' | 'Achtung' | 'Kein Signalwort'.",
    "- h_saetze: Gefahrenhinweise im Format 'Code + deutscher CLP-Text ohne Doppelpunkt', z.B. 'H226 Fluessigkeit und Dampf entzuendbar.' Kombinationscodes sind erlaubt.",
    "- p_saetze: Sicherheitshinweise im gleichen Format, z.B. 'P403+P235 An einem gut belueftbaren Ort aufbewahren. Kuehl halten.'",
    '- confidence: 0..1, wie sicher du bist, dass die Angaben zum KONKRETEN Produkt gehoeren.',
    '- sources: alle URLs, aus denen du die Angaben belegst.',
  ];

  if (includeBiozid) {
    lines.push(
      "- biozid: Recherchiere zusaetzlich die deutsche Pflicht-Kennzeichnung fuer Biozid-/Pflanzenschutzprodukte, z.B. den Pflichtwarnhinweis ('Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.' bzw. 'Pflanzenschutzmittel vorsichtig verwenden. Vor Verwendung stets Etikett und Produktinformationen lesen.') und/oder die BAUA-Registriernummer bzw. Zulassungsnummer des Produkts.",
      '- biozid_sources: URLs, die die Biozid-Angabe belegen. OHNE belegbare Quelle: biozid leer lassen.'
    );
  }

  lines.push(
    '',
    'REGELN (verbindlich):',
    '- ERFINDE NIEMALS H- oder P-Saetze. Gib nur Saetze an, die belegbar aus dem SDS oder der offiziellen Produktseite hervorgehen.',
    "- Kennzeichnungsfreie Produkte (keine Gefahrstoff-Kennzeichnung noetig): signalwort 'Kein Signalwort', h_saetze und p_saetze leer.",
    '- Wenn kein SDS auffindbar ist: sds_url leer lassen und confidence niedrig (< 0.4) ansetzen.',
    'KEIN Markdown, KEIN Erklaerungstext, NUR das JSON-Objekt.'
  );

  return lines.join('\n');
}

/**
 * Validiert + normalisiert die Gemini-Antwort. Gibt bei unbrauchbarem Input
 * null zurueck; ein "leeres" (negatives) Ergebnis ist dagegen ein gueltiges
 * Objekt — negative Ergebnisse sind cache-wuerdig.
 */
function normalizeResponse(raw, { includeBiozid = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const out = {
    sdsUrl: normalizeUrl(raw.sds_url != null ? raw.sds_url : raw.sdsUrl),
    signalwort: normalizeSignalwort(raw.signalwort),
    hSaetze: normalizeClpList(raw.h_saetze != null ? raw.h_saetze : raw.hSaetze, 'H'),
    pSaetze: normalizeClpList(raw.p_saetze != null ? raw.p_saetze : raw.pSaetze, 'P'),
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
    sources: normalizeSources(raw.sources),
    regulatory: null,
  };

  if (includeBiozid) {
    const biozidText = cleanupSentinel(raw.biozid);
    const biozidSources = normalizeSources(raw.biozid_sources != null ? raw.biozid_sources : raw.biozidSources);
    // Nur mit Quelle — sonst null (Compliance: keine unbelegte Pflicht-Kennzeichnung).
    out.regulatory = biozidText && biozidSources.length > 0
      ? { biozid: biozidText, sources: biozidSources }
      : { biozid: null, sources: [] };
  }

  return out;
}

/**
 * VERIFIKATIONS-GUARD: laedt eine mutmassliche SDS-URL und prueft die
 * PDF-Magic-Bytes. Nur eine Response, die mit "%PDF-" beginnt, gilt als
 * verifiziertes SDS. HTML-Seiten, Fehlerseiten, Redirect-Landingpages → ok=false.
 *
 * Gibt bei Erfolg auch den geladenen Buffer zurueck, damit eine Folge-Phase
 * das PDF ohne zweiten Download nach GCS spiegeln kann (uploadDocumentBuffer).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — Injection fuer Tests
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ checked: boolean, ok: boolean, status?: number|null, contentType?: string|null, size?: number, buffer?: Buffer, error?: string }>}
 */
async function verifySdsUrl(url, opts = {}) {
  const u = normalizeUrl(url);
  if (!u) return { checked: false, ok: false, error: 'invalid-url' };

  const doFetch = opts.fetchImpl || global.fetch || require('node-fetch');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : (parseInt(process.env.HAZMAT_SDS_FETCH_TIMEOUT_MS || '', 10) || DEFAULT_SDS_FETCH_TIMEOUT_MS);

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await doFetch(u, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
      },
      signal: controller ? controller.signal : undefined,
    });

    if (!res || !res.ok) {
      return { checked: true, ok: false, status: res ? res.status : null, error: `http-${res ? res.status : 'no-response'}` };
    }

    const contentType = res.headers && typeof res.headers.get === 'function'
      ? (res.headers.get('content-type') || null)
      : null;
    const declaredLength = res.headers && typeof res.headers.get === 'function'
      ? parseInt(res.headers.get('content-length') || '', 10)
      : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SDS_BYTES) {
      return { checked: true, ok: false, status: res.status, contentType, error: 'too-large' };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SDS_BYTES) {
      return { checked: true, ok: false, status: res.status, contentType, error: 'too-large' };
    }

    const isPdf = buf.length >= PDF_MAGIC.length
      && buf.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
    if (!isPdf) {
      // Gemini hat vermutlich eine HTML-Seite geliefert — wir raten NICHT.
      return { checked: true, ok: false, status: res.status, contentType, error: 'not-pdf' };
    }

    return { checked: true, ok: true, status: res.status, contentType, size: buf.length, buffer: buf };
  } catch (err) {
    return { checked: true, ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Haupt-Lookup: Gemini beauftragen, das offizielle SDS zu finden und
 * GHS/CLP-Daten zu extrahieren; anschliessend die SDS-URL verifizieren.
 *
 * Rueckgabe-Shape (oder null bei Fehler/leerem Input):
 * {
 *   sdsUrl: string|null,          // was Gemini gemeldet hat (unverifiziert)
 *   verifiedSdsUrl: string|null,  // NUR gesetzt wenn PDF-Check bestanden
 *   verified: boolean,
 *   signalwort: 'Gefahr'|'Achtung'|'Kein Signalwort'|null,
 *   hSaetze: string[],
 *   pSaetze: string[],
 *   confidence: number,           // 0..1
 *   sources: string[],
 *   regulatory: { biozid: string|null, sources: string[] }|null,
 *   sdsVerification: { checked, ok, status?, contentType?, size?, error? }
 * }
 *
 * @param {object} params
 * @param {string} [params.ean]
 * @param {string} [params.brand]
 * @param {string} [params.title]
 * @param {string[]} [params.requestedFields] — z.B. ['biozid']
 * @param {number} [params.timeoutMs]
 * @param {string} [params.model]
 * @param {Function} [params.fetchImpl] — Injection fuer Tests (SDS-Verifikation)
 * @param {number} [params.sdsFetchTimeoutMs]
 */
async function lookupHazmatViaGemini(params = {}) {
  const ean = safeString(params.ean);
  const brand = safeString(params.brand);
  const title = safeString(params.title);
  if (!ean && !brand && !title) return null;

  const requestedFields = Array.isArray(params.requestedFields)
    ? params.requestedFields.map((f) => safeString(f).toLowerCase()).filter(Boolean)
    : [];
  const includeBiozid = requestedFields.includes('biozid');

  const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : (parseInt(process.env.HAZMAT_GEMINI_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS);

  const model = params.model
    || process.env.HAZMAT_GEMINI_MODEL
    || 'gemini-2.5-flash';

  let normalized;
  try {
    const parsed = await Promise.race([
      gemini3GenerateJSON({
        prompt: buildPrompt({ ean, brand, title, includeBiozid }),
        schema: buildSchema({ includeBiozid }),
        model,
        temperature: 0.2,
        maxOutputTokens: 2048,
        timeoutMs,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hazmat-gemini timeout')), timeoutMs + 1000)),
    ]);

    normalized = normalizeResponse(parsed, { includeBiozid });
    if (!normalized) return null;
  } catch (err) {
    try {
      logger.warn(
        { ean, brand, title, error: err?.message || String(err) },
        '[hazmat-gemini-lookup] lookup failed'
      );
    } catch (_) { /* logger optional */ }
    return null;
  }

  // ── VERIFIKATIONS-GUARD ────────────────────────────────────────────────
  let verified = false;
  let verifiedSdsUrl = null;
  let verification = { checked: false, ok: false };

  if (normalized.sdsUrl) {
    verification = await verifySdsUrl(normalized.sdsUrl, {
      fetchImpl: params.fetchImpl,
      timeoutMs: params.sdsFetchTimeoutMs,
    });
    if (verification.ok) {
      verified = true;
      verifiedSdsUrl = normalized.sdsUrl;
    }
  } else {
    // Kein SDS gefunden → H-/P-Saetze sind nicht belegbar. Compliance-kritisch:
    // wir reichen NIE unbelegte Gefahren-/Sicherheitshinweise durch.
    normalized.hSaetze = [];
    normalized.pSaetze = [];
  }

  // Buffer NIE im Ergebnis durchreichen (Firestore-Cache, Doc-Limit 1 MB) —
  // Folge-Phasen nutzen verifySdsUrl() direkt, wenn sie das PDF brauchen.
  const { buffer, ...verificationMeta } = verification;

  return {
    sdsUrl: normalized.sdsUrl,
    verifiedSdsUrl,
    verified,
    signalwort: normalized.signalwort,
    hSaetze: normalized.hSaetze,
    pSaetze: normalized.pSaetze,
    confidence: normalized.confidence,
    sources: normalized.sources,
    regulatory: normalized.regulatory,
    sdsVerification: verificationMeta,
  };
}

/**
 * Negativ = nichts Verwertbares gefunden (weder verifiziertes SDS noch
 * Signalwort noch H-/P-Saetze noch Biozid-Kennzeichnung). Wird trotzdem
 * gecacht, um Dauer-Retries pro Sync-Lauf zu verhindern.
 */
function isNegativeResult(result) {
  if (!result || typeof result !== 'object') return true;
  const hasAny = result.verified
    || result.verifiedSdsUrl
    || result.signalwort
    || (Array.isArray(result.hSaetze) && result.hSaetze.length > 0)
    || (Array.isArray(result.pSaetze) && result.pSaetze.length > 0)
    || (result.regulatory && result.regulatory.biozid);
  return !hasAny;
}

function _timestampToMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}

/**
 * Cache-Read: gibt { result, negative, cached: true } zurueck, wenn ein
 * frischer Eintrag existiert (TTL 30d) UND er die angefragten Felder abdeckt
 * (ein alter Eintrag ohne Biozid-Recherche zaehlt bei requestedFields=['biozid']
 * als Miss). Fehler/Miss/stale → null.
 */
async function readHazmatCache(ean, opts = {}) {
  const key = eanCacheKey(ean);
  if (!key) return null;
  try {
    const db = _getFirestore();
    const snap = await db.collection(CACHE_COLLECTION).doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const tsMs = _timestampToMs(data.lookedUpAt);
    if (!tsMs) return null;
    if ((Date.now() - tsMs) > CACHE_TTL_MS) return null;
    if (!data.result || typeof data.result !== 'object') return null;

    const requestedFields = Array.isArray(opts.requestedFields)
      ? opts.requestedFields.map((f) => safeString(f).toLowerCase()).filter(Boolean)
      : [];
    const cachedFields = Array.isArray(data.requestedFields) ? data.requestedFields : [];
    for (const field of requestedFields) {
      if (!cachedFields.includes(field)) return null; // Feld nie recherchiert → Miss
    }

    return {
      result: data.result,
      negative: !!data.negative,
      source: data.source || 'gemini-googleSearch',
      cached: true,
      lookedUpAtMs: tsMs,
    };
  } catch (err) {
    try {
      logger.warn(
        { ean, error: err?.message || String(err) },
        '[hazmat-gemini-lookup] cache read failed'
      );
    } catch (_) { /* */ }
    return null;
  }
}

/**
 * Cache-Write: persistiert auch negative Ergebnisse. Wirft nie.
 */
async function writeHazmatCache(ean, meta, result) {
  const key = eanCacheKey(ean);
  if (!key || !result || typeof result !== 'object') return;
  try {
    const db = _getFirestore();
    // JSON-Roundtrip strippt undefined-Werte (Firestore lehnt sie ab).
    const cleanResult = JSON.parse(JSON.stringify(result));
    await db.collection(CACHE_COLLECTION).doc(key).set({
      ean: key,
      brand: safeString(meta && meta.brand) || null,
      title: safeString(meta && meta.title) || null,
      requestedFields: Array.isArray(meta && meta.requestedFields)
        ? meta.requestedFields.map((f) => safeString(f).toLowerCase()).filter(Boolean)
        : [],
      result: cleanResult,
      negative: isNegativeResult(result),
      source: 'gemini-googleSearch',
      lookedUpAt: new Date(),
    });
  } catch (err) {
    try {
      logger.warn(
        { ean, error: err?.message || String(err) },
        '[hazmat-gemini-lookup] cache write failed'
      );
    } catch (_) { /* */ }
  }
}

/**
 * Get-or-fetch-Wrapper: Cache first (max 30d alt, inkl. Negativ-Eintraege),
 * sonst Gemini-Lookup + Persist. Transiente Fehler (lookup → null) werden
 * NICHT gecacht.
 *
 * @param {object} params — wie lookupHazmatViaGemini, plus:
 * @param {boolean} [params.useCache=true]
 * @returns {Promise<null|object>} lookup-Shape + { cached, negative, source }
 */
async function getOrFetchHazmat(params = {}) {
  const ean = safeString(params.ean);
  const brand = safeString(params.brand);
  const title = safeString(params.title);
  if (!ean && !brand && !title) return null;

  // 1) Cache hit?
  if (params.useCache !== false) {
    const cached = await readHazmatCache(ean, { requestedFields: params.requestedFields });
    if (cached && cached.result) {
      return {
        ...cached.result,
        cached: true,
        negative: cached.negative,
        source: cached.source,
      };
    }
  }

  // 2) Cache miss → Gemini + Verifikation
  const result = await lookupHazmatViaGemini(params);
  if (!result) return null;

  await writeHazmatCache(ean, {
    brand,
    title,
    requestedFields: params.requestedFields,
  }, result);

  return {
    ...result,
    cached: false,
    negative: isNegativeResult(result),
    source: 'gemini-googleSearch',
  };
}

module.exports = {
  lookupHazmatViaGemini,
  getOrFetchHazmat,
  verifySdsUrl,
  readHazmatCache,
  writeHazmatCache,
  normalizeResponse,
  normalizeSignalwort,
  normalizeClpEntry,
  normalizeClpList,
  eanCacheKey,
  isNegativeResult,
  buildPrompt,
  buildSchema,
  // Konstanten fuer Tests
  CACHE_COLLECTION,
  CACHE_TTL_MS,
  MAX_SDS_BYTES,
  SIGNALWORT_VALUES,
  PDF_MAGIC,
};
