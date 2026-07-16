#!/usr/bin/env node
/**
 * report-ce-safety-gaps.js — CE-/Sicherheits-Kennzeichen-Prüfreport (READ-ONLY).
 *
 * WICHTIG — KEIN RECHTSURTEIL, KEIN AUTO-WRITE:
 *   Dieses Script BEHAUPTET KEINE CE-Pflicht rechtsverbindlich. Ob ein Produkt
 *   unter eine CE-Richtlinie fällt und ob das Kennzeichen tatsächlich angebracht
 *   ist, steht auf dem PHYSISCHEN Produkt — ein Auto-Write des CE-Attributs wäre
 *   selbst eine Erfindung (exakt das Halluzinations-Muster, das wir bei GPSR/
 *   Preisen bekämpfen). Das Script PRIORISIERT die physische Prüfung durch den
 *   Operator: es liefert Kandidaten-Listen, nie Urteile. Deshalb gibt es
 *   bewusst KEIN --apply und keinerlei Firestore-Writes.
 *
 * Heuristik: konfigurierbares Regel-Array CE_RULES (Kategorie-Pattern →
 * Richtlinien-HINWEIS, z. B. 'Spielzeug: 2009/48/EG'). Gematcht wird gegen
 * alle bekannten Kategorie-Texte eines Produkts (identification.category,
 * details.category.path, details.categoryPath) plus den eBay-Kategorie-Text
 * des aktiven Listings (primaryCategoryName aus ebayListingsLive).
 *
 * 4 Buckets:
 *   [1] CE-pflichtVERDÄCHTIG + aktives Listing (eBay/Kaufland) + KEIN
 *       CE-/Kennzeichen-Attribut → höchste Prio: Produkt physisch prüfen.
 *   [2] CE-pflichtverdächtig, kein CE-Attribut, aber ohne aktives Listing.
 *   [3] CE-Claim vorhanden, aber KEINE der Pflicht-Heuristiken matcht →
 *       Plausibilitäts-Check (Claim erfunden? Regel-Lücke?).
 *   [4] Safety-Attribute vorhanden (Signalwort/H-Sätze/P-Sätze/SDS) →
 *       Vollständigkeits-Check inkl. SDS-URL-Erreichbarkeit (nur HEAD/GET,
 *       kein Write). Infrastruktur-Fehler (403/429/5xx/Netz) werden nach der
 *       price-evidence-Doktrin EHRLICH als infra_blocked ("konnten nicht
 *       prüfen") gemeldet — nur 404/410 gelten als Evidenz gegen die URL.
 *
 * Aufruf:
 *   node backend/scripts/report-ce-safety-gaps.js                 # Report → Repo-Root
 *   node backend/scripts/report-ce-safety-gaps.js /tmp/out.csv    # CSV-Pfad
 *   node backend/scripts/report-ce-safety-gaps.js --tenant trendocean
 *   node backend/scripts/report-ce-safety-gaps.js --skip-sds-check
 *   node backend/scripts/report-ce-safety-gaps.js --max-sds-checks 50
 *
 * Output: Konsolen-Aggregat + CSV (Default: <repo>/ce-safety-gaps-<datum>.csv).
 */

'use strict';

// Kanonische Collection ist products_v2 (Production: USE_PRODUCTS_V2=true).
// MUSS vor allen lib-Requires gesetzt sein.
process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');
// PURE Reuse aus dem Gold-Standard lib/price-evidence.js: 404/410 = echtes
// Urteil gegen die URL, 0/401/403/407/408/429/5xx = "konnten nicht prüfen".
const { isInfraFetchFailure } = require('../lib/price-evidence');

const DEFAULT_SDS_TIMEOUT_MS = 10000;
const DEFAULT_MAX_SDS_CHECKS = 200;
const SDS_CHECK_CONCURRENCY = 4;
const ROWS_SHOWN_PER_BUCKET = 15;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Normalisierung — PURE, kein I/O.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Attribut-Key-Normalisierung nach dem Muster von
 * services/kaufland-attribute-enricher.js normalizeToken(), zusätzlich
 * diakritik-/ß-tolerant (ASCII), damit 'Prüfzeichen' und 'Pruefzeichen'
 * denselben Token ergeben. PURE.
 */
function normalizeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

/**
 * Kategorie-Text-Normalisierung: lowercase-ASCII (ä→a, ß→ss, Diakritika weg),
 * Breadcrumb-/Satz-Trenner → Space. Die CE_RULES-Patterns laufen auf dieser
 * Form. PURE.
 */
function normalizeCategoryText(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[>|/\\,;:+&()[\]{}._"'!?-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────────────────────────────────────────────────────────
// CE-Pflicht-Heuristik — konfigurierbares Regel-Array. PURE.
//
// ACHTUNG: Das sind HINWEISE auf typischerweise CE-pflichtige Produktgruppen,
// KEINE rechtsverbindliche Einstufung. Kategorien sind selbst LLM-/Marktplatz-
// Daten und können falsch sein. Ergebnis = Kandidat für die physische Prüfung.
// Patterns matchen auf normalizeCategoryText()-Form (lowercase-ASCII);
// deutsche Komposita bleiben EIN Token ('fahrradhelm'), daher Suffix-Matches.
// ───────────────────────────────────────────────────────────────────────────
const CE_RULES = [
  {
    id: 'elektro',
    label: 'Elektronik/Elektro (Niederspannung/EMV/Funk)',
    directive: 'Niederspannung 2014/35/EU, EMV 2014/30/EU, Funk (RED) 2014/53/EU',
    // (a|ae)/(o|oe)/(u|ue): Kategorie-Texte schreiben Umlaute mal als
    // Umlaut (→ normalisiert 'a'), mal ausgeschrieben ('ae').
    patterns: [
      /\bled\b/, /strahler\b/, /scheinwerfer\b/, /leuchte(n)?\b/, /lampe(n)?\b/,
      /lichterkette/, /lichtleiste/,
      /ladeger(a|ae)t/, /ladekabel/, /netzteil/, /powerbank/, /batterielade/,
      /elektrowerkzeug/, /akkuschrauber/, /bohrmaschine/, /winkelschleifer/,
      /schleifmaschine/, /l(o|oe)tkolben/, /heissluftpistole/, /elektroger(a|ae)t/,
      /\bbluetooth\b/, /\bfunk\b/, /funkger(a|ae)t/, /\bwlan\b/, /\bwifi\b/,
      /\bradios?\b/, /kopfh(o|oe)rer/, /lautsprecher/, /smartphone/, /\btablet\b/,
      /\bnotebook\b/, /\blaptop\b/,
      /\belektro\b/, /elektronik/, /elektroartikel/, /elektroinstallation/,
      /steckdose/, /\bdimmer\b/, /\btrafo\b/, /transformator/, /\bakkus?\b/,
    ],
  },
  {
    id: 'spielzeug',
    label: 'Spielzeug',
    directive: 'Spielzeug: 2009/48/EG',
    patterns: [
      /spielzeug/, /spielware(n)?\b/, /\btoys?\b/, /puppe(n)?\b/,
      /pl(u|ue)schtier/, /kuscheltier/, /kinderspiel/, /babyspiel/,
    ],
  },
  {
    id: 'psa',
    label: 'PSA (Persönliche Schutzausrüstung)',
    directive: 'PSA: Verordnung (EU) 2016/425',
    patterns: [
      // Komposita: 'fahrradhelm', 'schutzhelm' — Suffix-Match, kein \b davor.
      /(schutz|fahrrad|motorrad|kinder|bau|reit|ski|kletter|arbeits)helm/,
      /(^|\s)helm(e|s)?\b/,
      /schutzbrille/, /sicherheitsbrille/,
      /schutzhandschuh/, /arbeitshandschuh/,
      /geh(o|oe)rschutz/, /atemschutz/, /staubmaske/, /atemmaske/, /\bffp\d?\b/,
      /warnweste/, /sicherheitsschuh/, /schutzausr(u|ue)stung/, /(^|\s)psa\b/,
      /knieschutz/, /knieschoner/,
    ],
  },
  {
    id: 'maschinen',
    label: 'Maschinen',
    directive: 'Maschinen: 2006/42/EG',
    patterns: [
      /maschine(n)?\b/,
      /(ketten|kreis|stich|sabel|band|gehrungs|tisch)s(a|ae)ge/, /\bs(a|ae)gen?\b/,
      /hochdruckreiniger/, /kompressor/, /rasenm(a|ae)her/, /vertikutierer/,
      /h(a|ae)cksler/, /heckenschere/, /freischneider/, /motorsense/,
      /schweissger(a|ae)t/, /seilwinde/, /hebeb(u|ue)hne/, /pumpe(n)?\b/,
    ],
  },
  {
    id: 'gas-druck',
    label: 'Gas-/Druckgeräte (Gasgrill!)',
    directive: 'Gasgeräte: Verordnung (EU) 2016/426 / Druckgeräte: 2014/68/EU',
    patterns: [
      /gasgrill/, /gaskocher/, /campingkocher/, /gasbrenner/, /gasheiz/,
      /gasstrahler/, /druckminderer/, /druckregler/, /druckbeh(a|ae)lter/,
      /\bpropan/, /druckluft/,
    ],
  },
  {
    id: 'messgeraete',
    label: 'Messgeräte',
    directive: 'Messgeräte: 2014/32/EU (MID)',
    patterns: [
      /messger(a|ae)t/, /multimeter/, /waage(n)?\b/, /entfernungsmesser/,
      /thermometer/, /manometer/, /luftdruckpr(u|ue)fer/,
    ],
  },
];

/**
 * Matcht Kategorie-Texte gegen CE_RULES. Pro Regel höchstens ein Treffer
 * (erste matchende Text/Pattern-Kombination). PURE — kein I/O.
 *
 * @param {string|string[]} categoryTexts
 * @returns {Array<{id:string,label:string,directive:string,matchedPattern:string,matchedText:string}>}
 */
function matchCeRules(categoryTexts) {
  const texts = (Array.isArray(categoryTexts) ? categoryTexts : [categoryTexts])
    .map(normalizeCategoryText)
    .filter(Boolean);
  const matches = [];
  for (const rule of CE_RULES) {
    let hit = null;
    for (const text of texts) {
      const pattern = rule.patterns.find((re) => re.test(text));
      if (pattern) {
        hit = { id: rule.id, label: rule.label, directive: rule.directive, matchedPattern: String(pattern), matchedText: text };
        break;
      }
    }
    if (hit) matches.push(hit);
  }
  return matches;
}

/**
 * Sammelt alle Kategorie-Texte eines Produkts (+ extra Texte, z. B. den
 * eBay-Listing-Kategorie-Namen). PURE.
 */
function collectCategoryTexts(product, extraTexts = []) {
  const details = (product && product.details) || {};
  const categoryObj = details.category;
  const texts = [
    product && product.identification && product.identification.category,
    categoryObj && typeof categoryObj === 'object' ? categoryObj.path : categoryObj,
    details.categoryPath,
    ...(Array.isArray(extraTexts) ? extraTexts : [extraTexts]),
  ];
  const seen = new Set();
  const out = [];
  for (const t of texts) {
    const s = safeString(t);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Attribut-Scans — PURE.
// ───────────────────────────────────────────────────────────────────────────

function attrValueNonEmpty(v) {
  if (Array.isArray(v)) return v.some((x) => !!safeString(x));
  if (v && typeof v === 'object') return Object.values(v).some((x) => !!safeString(x));
  return !!safeString(v);
}

/** details.attributes + details.attributes_extra zusammengelegt. PURE. */
function mergedAttributes(details) {
  const d = details && typeof details === 'object' ? details : {};
  const a = d.attributes && typeof d.attributes === 'object' && !Array.isArray(d.attributes) ? d.attributes : {};
  const extra = d.attributes_extra && typeof d.attributes_extra === 'object' && !Array.isArray(d.attributes_extra) ? d.attributes_extra : {};
  return { ...extra, ...a };
}

/**
 * CE-/Kennzeichen-Attribut-Key? (normalizeToken-Scan: CE, CE-Kennzeichnung,
 * CE-Konformität, Konformitätserklärung, Zertifizierung, Prüfzeichen, …). PURE.
 */
function classifyCeAttributeKey(key) {
  const token = normalizeToken(key);
  if (!token) return false;
  if (token === 'ce') return true;
  if (token.includes('cekennzeich')) return true;      // CE-Kennzeichnung/-zeichen
  if (token.includes('cemark')) return true;           // CE marking
  if (token.includes('cekonform')) return true;        // CE-Konformität
  if (token.includes('konformit')) return true;        // Konformität(serklärung)/Konformitaet
  if (token.startsWith('zertifi')) return true;        // Zertifizierung/Zertifikate
  if (token.startsWith('certif')) return true;         // certification/certificates
  if (token.includes('prufzeichen') || token.includes('pruefzeichen')) return true; // Prüfzeichen
  if (token.includes('prufsiegel') || token.includes('pruefsiegel')) return true;   // Prüfsiegel
  return false;
}

/**
 * Alle CE-Attribut-Keys mit non-empty Wert (Original-Schreibweise). PURE.
 */
function findCeAttributeKeys(attrs) {
  const out = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (classifyCeAttributeKey(k) && attrValueNonEmpty(v)) out.push(k);
  }
  return out;
}

/**
 * GHS/CLP-Sub-Feld-Matcher — Spiegel von kaufland-attribute-enricher
 * classifyHazmatToken(), aber auf unserer ASCII-Token-Form. PURE.
 */
function classifyHazmatToken(token) {
  if (token === 'signalwort' || token === 'signalword') return 'signalwort';
  if (token === 'gefahrenhinweise' || token === 'hsatze' || token === 'hsaetze'
    || token === 'hazardstatements') return 'hSaetze';
  if (token.startsWith('sicherheitsinfo') || token === 'psatze' || token === 'psaetze'
    || token === 'precautionarystatements') return 'pSaetze';
  if (token === 'sicherheitsdatenblatt' || token === 'safetydatasheet') return 'sds';
  return null;
}

const SAFETY_FIELDS = ['signalwort', 'hSaetze', 'pSaetze', 'sds'];

/**
 * Sammelt Safety-Attribute (GHS/CLP) aus den Attributen: erster non-empty
 * Wert pro Sub-Feld + present/missing-Listen. missing ist nur gefüllt, wenn
 * MINDESTENS ein Safety-Attribut existiert (sonst ist nichts zu prüfen). PURE.
 *
 * @returns {{ fields: {signalwort:string|null,hSaetze:string|null,pSaetze:string|null,sds:string|null},
 *   present: string[], missing: string[] }}
 */
function collectSafetyAttributes(attrs) {
  const fields = { signalwort: null, hSaetze: null, pSaetze: null, sds: null };
  for (const [k, v] of Object.entries(attrs || {})) {
    const sub = classifyHazmatToken(normalizeToken(k));
    if (!sub || fields[sub] != null || !attrValueNonEmpty(v)) continue;
    fields[sub] = Array.isArray(v) ? v.map((x) => safeString(x)).filter(Boolean).join(' | ') : safeString(v);
  }
  const present = SAFETY_FIELDS.filter((f) => fields[f] != null);
  const missing = present.length ? SAFETY_FIELDS.filter((f) => fields[f] == null) : [];
  return { fields, present, missing };
}

// ───────────────────────────────────────────────────────────────────────────
// Bucket-Entscheidung pro Produkt — PURE.
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string[]} p.categoryTexts   alle Kategorie-Texte (Produkt + Listings)
 * @param {object}   p.attributes      merged details.attributes(+_extra)
 * @param {boolean}  p.hasLiveEbay
 * @param {boolean}  p.hasLiveKaufland
 * @returns {{ ruleMatches:Array, ceKeys:string[], safety:object, live:boolean, buckets:number[] }}
 */
function evaluateProduct({ categoryTexts, attributes, hasLiveEbay, hasLiveKaufland } = {}) {
  const ruleMatches = matchCeRules(categoryTexts || []);
  const ceKeys = findCeAttributeKeys(attributes || {});
  const safety = collectSafetyAttributes(attributes || {});
  const live = !!(hasLiveEbay || hasLiveKaufland);

  const buckets = [];
  if (ruleMatches.length && ceKeys.length === 0) buckets.push(live ? 1 : 2);
  if (ceKeys.length > 0 && ruleMatches.length === 0) buckets.push(3);
  if (safety.present.length > 0) buckets.push(4);

  return { ruleMatches, ceKeys, safety, live, buckets };
}

// ───────────────────────────────────────────────────────────────────────────
// SDS-URL-Erreichbarkeit — read-only Netz (HEAD, GET-Fallback). Kein Write.
// ───────────────────────────────────────────────────────────────────────────

function isHttpUrl(v) {
  const s = safeString(v);
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Klassifiziert einen HTTP-Status nach der price-evidence-Doktrin. PURE.
 * 2xx/3xx = reachable; Infra (0/401/403/407/408/429/5xx) = infra_blocked
 * ("konnten nicht prüfen", KEIN Urteil); Rest (v. a. 404/410) = unreachable
 * (echtes Urteil gegen die URL).
 */
function classifySdsCheck(httpStatus) {
  const s = Number(httpStatus) || 0;
  if (s >= 200 && s < 400) return 'reachable';
  if (isInfraFetchFailure(s)) return 'infra_blocked';
  return 'unreachable';
}

/**
 * HEAD-first-Erreichbarkeits-Check; GET-Fallback wenn HEAD nicht erlaubt/
 * geblockt ist (405/501/Infra/Netzfehler). Liest nur — schreibt nie.
 * fetchImpl-Injection für Tests.
 *
 * @returns {Promise<{ status:'reachable'|'unreachable'|'infra_blocked'|'skipped', httpStatus:number|null, method:string|null }>}
 */
async function checkUrlReachable(url, { timeoutMs = DEFAULT_SDS_TIMEOUT_MS, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { status: 'skipped', httpStatus: null, method: null };

  const attempt = async (method) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { method, redirect: 'follow', signal: ctrl.signal });
      return { httpStatus: Number(res && res.status) || 0 };
    } finally {
      clearTimeout(timer);
    }
  };

  let head = null;
  try {
    head = await attempt('HEAD');
  } catch {
    head = null; // Netzfehler/Timeout → GET probieren
  }
  if (head && classifySdsCheck(head.httpStatus) === 'reachable') {
    return { status: 'reachable', httpStatus: head.httpStatus, method: 'HEAD' };
  }

  // HEAD wird oft geblockt (405/501) oder als Bot abgewiesen — GET als
  // zweite Meinung, bevor irgendein Urteil fällt.
  let get = null;
  try {
    get = await attempt('GET');
  } catch {
    get = null;
  }
  if (get) {
    return { status: classifySdsCheck(get.httpStatus), httpStatus: get.httpStatus, method: 'GET' };
  }
  if (head) {
    return { status: classifySdsCheck(head.httpStatus), httpStatus: head.httpStatus, method: 'HEAD' };
  }
  return { status: 'infra_blocked', httpStatus: 0, method: null };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// CSV — PURE.
// ───────────────────────────────────────────────────────────────────────────

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADER = [
  'bucket', 'prio', 'sku', 'product_id', 'title', 'brand', 'category_text',
  'matched_rules', 'directive_hints', 'ce_attribute_keys',
  'live_ebay', 'live_kaufland',
  'safety_present', 'safety_missing', 'sds_url', 'sds_check', 'note',
];

function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((h) => csvEscape(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    tenantId: process.env.TENANT_ID || 'default',
    csvPath: null,
    skipSdsCheck: false,
    sdsTimeoutMs: DEFAULT_SDS_TIMEOUT_MS,
    maxSdsChecks: DEFAULT_MAX_SDS_CHECKS,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--skip-sds-check') out.skipSdsCheck = true;
    else if (t === '--sds-timeout-ms') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.sdsTimeoutMs = Math.floor(n);
      i += 1;
    } else if (t === '--max-sds-checks') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 0) out.maxSdsChecks = Math.floor(n);
      i += 1;
    } else if (t === '--out') { out.csvPath = argv[i + 1] || null; i += 1; }
    else if (t === '--help' || t === '-h') out.help = true;
    else if (!t.startsWith('--') && !out.csvPath) out.csvPath = t;
  }
  return out;
}

function defaultCsvPath() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const date = new Date().toISOString().slice(0, 10);
  return path.join(repoRoot, `ce-safety-gaps-${date}.csv`);
}

function truncate(s, n) {
  const str = safeString(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function productSku(data) {
  return safeString(
    (data && data.identification && data.identification.sku)
    || (data && data.details && data.details.identifiers && data.details.identifiers.sku)
  ) || null;
}

function productEans(data) {
  const idf = (data && data.details && data.details.identifiers) || {};
  const ident = (data && data.identification) || {};
  const raw = [
    idf.ean, idf.gtin, idf.upc, ident.barcode,
    ...(Array.isArray(ident.barcodes) ? ident.barcodes : []),
    ...(Array.isArray(idf.barcodes) ? idf.barcodes : []),
  ];
  const out = new Set();
  for (const v of raw) {
    const digits = safeString(v).replace(/\D+/g, '');
    if (digits.length >= 8) out.add(digits);
  }
  return [...out];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(0, 40).join('\n'));
    return;
  }
  if (process.env.USE_PRODUCTS_V2 !== 'true') {
    throw new Error('USE_PRODUCTS_V2=true erforderlich (wie Production) — sonst liest das Script die Legacy-Collection.');
  }

  // Lazy requires: erst in main(), damit der Modul-Export für Tests frei von
  // Firestore-Clients bleibt (Muster: repair-price-evidence.js).
  const { firestore } = require('../lib/firestore');
  const { getCollection } = require('../lib/product-store');
  const { isRetiredKauflandUnit } = require('../lib/kaufland-unit-status');
  const collectionName = getCollection();

  console.error(`[ce-safety-gaps] READ-ONLY Report — tenant=${args.tenantId} collection=${collectionName}`);
  console.error('[ce-safety-gaps] HINWEIS: Dieses Script behauptet KEINE CE-Pflicht rechtsverbindlich.');
  console.error('[ce-safety-gaps] Es priorisiert die PHYSISCHE Prüfung — CE-Wahrheit steht auf dem Produkt.');

  // ── Produkte laden (Projektion) ────────────────────────────────────────────
  // Regel 8: Queries mit tenantId. Für 'default' geht das NICHT als
  // where-Klausel — Bestands-Docs tragen kein tenantId-Feld (gleiche Realität
  // wie repair-price-evidence.js) → in-memory filtern.
  let ref = firestore.collection(collectionName);
  if (args.tenantId !== 'default') ref = ref.where('tenantId', '==', args.tenantId);
  ref = ref.select(
    'identification.sku', 'identification.name', 'identification.brand',
    'identification.category', 'identification.barcode', 'identification.barcodes',
    'details.category', 'details.categoryPath', 'details.identifiers',
    'details.attributes', 'details.attributes_extra', 'tenantId'
  );
  const productSnap = await ref.get();
  const products = [];
  productSnap.forEach((d) => {
    const data = d.data() || {};
    if (args.tenantId === 'default' && data.tenantId && data.tenantId !== 'default') return;
    products.push({ id: d.id, data });
  });
  console.error(`[ce-safety-gaps] Produkte geladen: ${products.length}`);

  // ── Aktive Listings laden ──────────────────────────────────────────────────
  const [ebaySnap, kauflandSnap] = await Promise.all([
    firestore.collection('ebayListingsLive').where('active', '==', true)
      .select('sku', 'skuIndex', 'primaryCategoryName').get(),
    firestore.collection('kauflandUnitsLive').where('active', '==', true)
      .select('id_offer', 'id_offer_normalized', 'ean', 'eans', 'status').get(),
  ]);

  // eBay: sku(lower) → [{ itemId, categoryName }]
  const ebayBySku = new Map();
  ebaySnap.forEach((d) => {
    const data = d.data() || {};
    const skus = new Set([
      safeString(data.sku),
      ...(Array.isArray(data.skuIndex) ? data.skuIndex.map((s) => safeString(s)) : []),
    ]);
    for (const sku of skus) {
      if (!sku) continue;
      const key = sku.toLowerCase();
      if (!ebayBySku.has(key)) ebayBySku.set(key, []);
      ebayBySku.get(key).push({ itemId: d.id, categoryName: safeString(data.primaryCategoryName) || null });
    }
  });

  // Kaufland: id_offer(lower) → unitIds, ean(digits) → unitIds. Tombstones
  // (STALE/NOT_FOUND) sind KEINE Listings (lib/kaufland-unit-status.js).
  const kauflandBySku = new Map();
  const kauflandByEan = new Map();
  kauflandSnap.forEach((d) => {
    const data = d.data() || {};
    if (isRetiredKauflandUnit(data)) return;
    const skuKey = safeString(data.id_offer_normalized || data.id_offer).toLowerCase();
    if (skuKey) {
      if (!kauflandBySku.has(skuKey)) kauflandBySku.set(skuKey, []);
      kauflandBySku.get(skuKey).push(d.id);
    }
    const eans = new Set([
      safeString(data.ean).replace(/\D+/g, ''),
      ...(Array.isArray(data.eans) ? data.eans.map((e) => safeString(e).replace(/\D+/g, '')) : []),
    ]);
    for (const ean of eans) {
      if (ean.length < 8) continue;
      if (!kauflandByEan.has(ean)) kauflandByEan.set(ean, []);
      kauflandByEan.get(ean).push(d.id);
    }
  });
  console.error(`[ce-safety-gaps] Aktive Listings: eBay=${ebaySnap.size} kaufland=${kauflandSnap.size}`);

  // ── Auswertung ─────────────────────────────────────────────────────────────
  const rows = [];
  const bucketCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const ruleCounts = new Map();
  let suspects = 0;

  for (const { id, data } of products) {
    const sku = productSku(data);
    const skuKey = (sku || '').toLowerCase();
    const eans = productEans(data);

    const ebayHits = skuKey ? (ebayBySku.get(skuKey) || []) : [];
    const kauflandUnitIds = new Set(skuKey ? (kauflandBySku.get(skuKey) || []) : []);
    for (const ean of eans) {
      for (const uid of kauflandByEan.get(ean) || []) kauflandUnitIds.add(uid);
    }

    const listingCategoryNames = ebayHits.map((h) => h.categoryName).filter(Boolean);
    const categoryTexts = collectCategoryTexts(data, listingCategoryNames);
    const attributes = mergedAttributes(data.details);

    const evalResult = evaluateProduct({
      categoryTexts,
      attributes,
      hasLiveEbay: ebayHits.length > 0,
      hasLiveKaufland: kauflandUnitIds.size > 0,
    });
    if (evalResult.ruleMatches.length) {
      suspects += 1;
      for (const m of evalResult.ruleMatches) {
        ruleCounts.set(m.id, (ruleCounts.get(m.id) || 0) + 1);
      }
    }
    if (!evalResult.buckets.length) continue;

    const base = {
      sku: sku || id,
      product_id: id,
      title: truncate((data.identification && data.identification.name) || '', 120),
      brand: safeString(data.identification && data.identification.brand) || '',
      category_text: truncate(categoryTexts.join(' | '), 160),
      matched_rules: evalResult.ruleMatches.map((m) => m.id).join('; '),
      directive_hints: evalResult.ruleMatches.map((m) => m.directive).join('; '),
      ce_attribute_keys: evalResult.ceKeys.join('; '),
      live_ebay: ebayHits.map((h) => h.itemId).join('; '),
      live_kaufland: [...kauflandUnitIds].join('; '),
      safety_present: evalResult.safety.present.join('; '),
      safety_missing: evalResult.safety.missing.join('; '),
      sds_url: '',
      sds_check: '',
      note: '',
    };

    for (const bucket of evalResult.buckets) {
      bucketCounts[bucket] += 1;
      const row = { ...base, bucket, prio: bucket === 1 ? 'HOCH' : bucket === 4 ? 'MITTEL' : 'NORMAL' };
      if (bucket === 1) {
        row.note = 'CE-pflichtverdaechtig + LIVE + kein CE-Attribut — physisch pruefen (hoechste Prio)';
      } else if (bucket === 2) {
        row.note = 'CE-pflichtverdaechtig, kein CE-Attribut, kein aktives Listing';
      } else if (bucket === 3) {
        row.note = 'CE-Claim vorhanden, aber keine Pflicht-Heuristik matcht — Plausibilitaet pruefen';
      } else if (bucket === 4) {
        row.sds_url = safeString(evalResult.safety.fields.sds);
        row.sds_check = evalResult.safety.fields.sds == null
          ? 'sds_missing'
          : (isHttpUrl(evalResult.safety.fields.sds) ? 'pending' : 'not_a_url');
        row.note = evalResult.safety.missing.length
          ? `Safety-Attribute unvollstaendig: ${evalResult.safety.missing.join(', ')} fehlen`
          : 'Safety-Attribute vorhanden — Vollstaendigkeits-Check';
      }
      rows.push(row);
    }
  }

  // ── SDS-Erreichbarkeit (Bucket 4, read-only HEAD/GET) ──────────────────────
  const sdsRows = rows.filter((r) => r.bucket === 4 && r.sds_check === 'pending');
  if (args.skipSdsCheck) {
    for (const r of sdsRows) r.sds_check = 'skipped';
  } else if (sdsRows.length) {
    const uniqueUrls = [...new Set(sdsRows.map((r) => r.sds_url))].slice(0, args.maxSdsChecks);
    console.error(`[ce-safety-gaps] SDS-Erreichbarkeit: ${uniqueUrls.length} eindeutige URLs (HEAD/GET, read-only) …`);
    const resultsByUrl = new Map();
    await mapWithConcurrency(uniqueUrls, SDS_CHECK_CONCURRENCY, async (url) => {
      const res = await checkUrlReachable(url, { timeoutMs: args.sdsTimeoutMs });
      resultsByUrl.set(url, res);
    });
    for (const r of sdsRows) {
      const res = resultsByUrl.get(r.sds_url);
      r.sds_check = res
        ? `${res.status}${res.httpStatus ? `(${res.httpStatus})` : ''}`
        : 'skipped(cap)'; // --max-sds-checks Kappung
    }
  }

  // ── Konsolen-Aggregat ──────────────────────────────────────────────────────
  console.log('');
  console.log('══════════ CE-/Sicherheits-Kennzeichen-Prüfreport (READ-ONLY) ══════════');
  console.log('HINWEIS: KEINE rechtsverbindliche CE-Einstufung — Heuristik zur');
  console.log('Priorisierung der PHYSISCHEN Prüfung. CE-Wahrheit steht auf dem Produkt.');
  console.log('');
  console.log(`Produkte gescannt: ${products.length} (tenant=${args.tenantId})`);
  console.log(`CE-pflichtverdaechtig (Heuristik): ${suspects}`);
  if (ruleCounts.size) {
    console.log('  je Regel:');
    for (const rule of CE_RULES) {
      const n = ruleCounts.get(rule.id) || 0;
      if (n) console.log(`    ${String(n).padStart(5)}x ${rule.id} — ${rule.directive}`);
    }
  }
  console.log('');
  console.log(`[1] pflichtverdaechtig + LIVE + kein CE-Attribut (HOECHSTE PRIO): ${bucketCounts[1]}`);
  console.log(`[2] pflichtverdaechtig, kein CE-Attribut, ohne Listing:          ${bucketCounts[2]}`);
  console.log(`[3] CE-Claim in Nicht-Pflicht-Kategorie (Plausibilitaet):        ${bucketCounts[3]}`);
  console.log(`[4] Safety-Attribute vorhanden (Vollstaendigkeit/SDS):           ${bucketCounts[4]}`);

  for (const bucket of [1, 2, 3, 4]) {
    const bucketRows = rows.filter((r) => r.bucket === bucket);
    if (!bucketRows.length) continue;
    const shown = bucketRows.slice(0, ROWS_SHOWN_PER_BUCKET);
    console.log('');
    console.log(`── Bucket [${bucket}] — ${shown.length}/${bucketRows.length} angezeigt (Rest im CSV):`);
    for (const r of shown) {
      const extra = bucket === 4
        ? ` sds=${r.sds_check || '-'}${r.safety_missing ? ` fehlt:${r.safety_missing}` : ''}`
        : (bucket === 3 ? ` keys:${r.ce_attribute_keys}` : ` rules:${r.matched_rules}`);
      console.log(`    ${r.sku} — ${r.title || '(ohne Titel)'}${extra}`);
    }
  }

  // ── CSV schreiben ──────────────────────────────────────────────────────────
  const csvPath = args.csvPath ? path.resolve(args.csvPath) : defaultCsvPath();
  rows.sort((a, b) => a.bucket - b.bucket || String(a.sku).localeCompare(String(b.sku)));
  fs.writeFileSync(csvPath, toCsv(rows));
  console.log('');
  console.log(`[ce-safety-gaps] CSV (${rows.length} Zeilen): ${csvPath}`);
  console.log('[ce-safety-gaps] READ-ONLY — es wurde nichts geschrieben (kein --apply vorgesehen).');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ce-safety-gaps] FATAL:', err.message);
    process.exit(1);
  });
}

// Pure Helpers für Tests exportieren (kein Firestore-Client beim Require).
module.exports = {
  parseArgs,
  normalizeToken,
  normalizeCategoryText,
  CE_RULES,
  matchCeRules,
  collectCategoryTexts,
  mergedAttributes,
  attrValueNonEmpty,
  classifyCeAttributeKey,
  findCeAttributeKeys,
  classifyHazmatToken,
  collectSafetyAttributes,
  evaluateProduct,
  isHttpUrl,
  classifySdsCheck,
  checkUrlReachable,
  csvEscape,
  toCsv,
  CSV_HEADER,
  productEans,
  productSku,
};
