'use strict';

/**
 * gpsr-evidence.js — Beleg-Validierung fuer GPSR-/Hersteller-Daten.
 *
 * AUDIT 2026-07-16: 1353 von 1600 Produkten tragen "volle" GPSR-Daten, aber
 * KEIN einziges hat Beleg-Metadaten. Stichproben zeigen Halluzinationen
 * (okopp@apple.com als Apple-Kontakt, Telefon-Platzhalter nach dem Muster
 * "+496105456789"). 15+ Writer schreiben GPSR unverifiziert, zwei
 * Amplifikatoren (Registry-Enforce am Save-Boundary + brandGpsrMap im
 * Kaufland-Enricher) kopieren einen einzelnen falschen Eintrag auf viele
 * Produkte. Exakt das Muster des Preis-Halluzinations-Incidents 2026-07-11.
 *
 * Vorlage (Gold-Standard): lib/price-evidence.js —
 *   1. PURE Gates ohne I/O: eindeutige Fake-Telefonnummern, verdaechtige
 *      E-Mail-Adressen, strukturell untaugliche Beleg-URLs (Suche/Social/
 *      Marktplatz) werden OHNE Netz erkannt.
 *   2. verifyGpsrRecord: laedt Kandidaten-Seiten (fetchPageForVerification
 *      aus price-evidence, Unlocker-first + Direkt-GET-Fallback) und prueft,
 *      ob Herstellername + Adresse dort wirklich stehen. Infrastruktur-Fehler
 *      (0/401/403/407/408/429/5xx) werden EHRLICH als "konnten nicht pruefen"
 *      gemeldet (infra_blocked), NIE als "unbelegt" gewertet — 404/410 sind
 *      dagegen Evidenz GEGEN die Quelle (isInfraFetchFailure, gleiche Doktrin
 *      wie price-evidence).
 *   3. getOrVerifyBrandGpsr: Firestore-Cache nach dem Muster von
 *      lib/hazmat-gemini-lookup.js (TTL 30d, Negativ-Caching, transiente
 *      Fehler werden NICHT gecacht).
 *
 * Feld-Bereinigung (fake phone / suspect email → null) ist ein VORSCHLAG im
 * Rueckgabe-gpsr — ob geschrieben wird, entscheidet der Caller (Schreibpfade
 * laufen weiterhin ausschliesslich ueber saveProductV2). Dieses Modul schreibt
 * NIE nach products_v2 und aendert per require keinen bestehenden Code-Pfad.
 */

const { fetchPageForVerification, isInfraFetchFailure } = require('./price-evidence');
// normalizeForCompare('brand', v) == stripCorpSuffixes(v) — der exportierte
// Zugang zur Firmennamen-Normalisierung aus lib/cross-reference.js.
const { normalizeForCompare } = require('./cross-reference');
const logger = (() => {
  try { return require('./logger'); } catch { return { warn: () => {}, info: () => {} }; }
})();

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_PAGES = 4;
const CACHE_COLLECTION = 'gpsr_evidence_cache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
const SEQUENCE_RUN_LEN = 6; // 123456 / 654321
const REPEAT_RUN_LEN = 6;   // 000000 / 111111

// Lazy Firestore client — gleiches Muster wie hazmat-gemini-lookup.js /
// gpsr-gemini-lookup.js, um zirkulaere Dependencies mit lib/firestore.js zu
// vermeiden.
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

// ───────────────────────────────────────────────────────────────────────────
// 1a. looksLikeFakePhone — PURE, kein I/O.
// ───────────────────────────────────────────────────────────────────────────

function _hasMonotonicRun(digits, len) {
  let asc = 1;
  let desc = 1;
  for (let i = 1; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
    asc = d === 1 ? asc + 1 : 1;
    desc = d === -1 ? desc + 1 : 1;
    if (asc >= len || desc >= len) return true;
  }
  return false;
}

function _hasRepeatRun(digits, len) {
  let run = 1;
  for (let i = 1; i < digits.length; i++) {
    run = digits[i] === digits[i - 1] ? run + 1 : 1;
    if (run >= len) return true;
  }
  return false;
}

/**
 * Erkennt EINDEUTIGE Platzhalter-Telefonnummern (LLM-Halluzinations-Muster):
 *   - auf-/absteigende Sequenzen ab 6 Ziffern (123456, 654321, …456789)
 *   - Wiederholungen ab 6 gleichen Ziffern (000000, 111111)
 *   - eindeutig zu kurz (< 7 Ziffern national bzw. < 8 nach +/00-Prefix)
 * Konservativ: alles andere gilt als plausibel (false). Leerer Input → false
 * (nichts zu flaggen). PURE — kein I/O.
 *
 * @param {string} phone
 * @returns {boolean}
 */
function looksLikeFakePhone(phone) {
  const raw = safeString(phone);
  if (!raw) return false;
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return false;

  const intl = /^\+/.test(raw) || /^00\d/.test(digits);
  const rest = /^\+/.test(raw) ? digits : (/^00\d/.test(digits) ? digits.slice(2) : digits);

  // Zu kurz: international braucht Laendercode (1-3) + min. 7 nationale Ziffern.
  if (intl) {
    if (rest.length < 8) return true;
  } else if (digits.length < 7) {
    return true;
  }

  if (_hasMonotonicRun(digits, SEQUENCE_RUN_LEN)) return true;
  if (_hasRepeatRun(digits, REPEAT_RUN_LEN)) return true;
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// 1b. looksLikeSuspectEmail — PURE, kein I/O.
// ───────────────────────────────────────────────────────────────────────────

// Freemail-/Generik-Provider: kein Domain-Mismatch-Urteil moeglich —
// Kleinhersteller nutzen legitim info@gmail.com. Eine PERSOENLICHE
// Freemail-Adresse als Hersteller-Kontakt ist dagegen das Halluzinations-Muster.
const GENERIC_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.de', 'hotmail.com',
  'hotmail.de', 'live.com', 'live.de', 'yahoo.com', 'yahoo.de', 'ymail.com',
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'gmx.com', 'web.de', 't-online.de',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'mail.com', 'mail.de',
  'protonmail.com', 'proton.me', 'posteo.de', 'freenet.de', 'arcor.de',
  'mailbox.org', 'yandex.com', 'yandex.ru', 'magenta.de',
]);

// Geschaeftliche Postfach-Prefixe — wirken NICHT persoenlich.
const BUSINESS_PREFIX_KEYWORDS = new Set([
  'info', 'service', 'kontakt', 'contact', 'support', 'office', 'mail', 'post',
  'hello', 'hi', 'sales', 'vertrieb', 'kundenservice', 'kundendienst',
  'customerservice', 'customercare', 'care', 'shop', 'verkauf', 'bestellung',
  'bestellungen', 'order', 'orders', 'gpsr', 'compliance', 'safety',
  'produktsicherheit', 'productsafety', 'legal', 'recht', 'datenschutz',
  'privacy', 'impressum', 'admin', 'webmaster', 'marketing', 'presse', 'press',
  'pr', 'team', 'noreply', 'no-reply', 'anfrage', 'anfragen', 'feedback',
]);

function _emailParts(email) {
  const s = safeString(email).toLowerCase();
  const m = s.match(/^([^@\s]+)@([^@\s]+\.[^@\s]{2,})$/);
  if (!m) return null;
  return { local: m[1], domain: m[2].replace(/^www\./, '') };
}

/**
 * Grobe eTLD+1-Heuristik: apple.com, bosch.de, foo.co.uk.
 */
function _registrableDomain(host) {
  const h = safeString(host).toLowerCase().replace(/^www\./, '');
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  if (/^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(last2)) {
    return labels.slice(-3).join('.');
  }
  return last2;
}

function _hostnameOf(url) {
  const s = safeString(url);
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      .hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Persoenlich wirkendes Prefix: vorname-/initialen-Muster (okopp@, j.smith@,
 * max.mustermann@). Bekannte Business-Prefixe (info@, service@, kontakt@ …)
 * zaehlen NIE als persoenlich.
 */
function _isPersonalLocalPart(local) {
  const lp = safeString(local).toLowerCase();
  if (!lp) return false;
  const segments = lp.split(/[._\-+]/).filter(Boolean);
  for (const seg of segments) {
    const base = seg.replace(/[0-9]+$/, '');
    if (BUSINESS_PREFIX_KEYWORDS.has(seg) || BUSINESS_PREFIX_KEYWORDS.has(base)) return false;
  }
  const base = lp.replace(/[0-9]+$/, '');
  if (/^[a-z]{1,3}[._-][a-z]{2,20}$/.test(base)) return true;  // j.smith
  if (/^[a-z]{2,20}[._-][a-z]{2,20}$/.test(base)) return true; // max.mustermann
  if (/^[a-z]{2,16}$/.test(base)) return true;                 // okopp, foo
  return false;
}

/**
 * Marken-Aehnlichkeit einer Domain: "bosch-home.com" passt zu "Bosch GmbH",
 * "tommy.com" passt zu "TOMMY JEANS". Konservativ zugunsten von "kein Flag".
 */
function _domainMatchesBrand(domain, brand) {
  const b = normalizeForCompare('brand', safeString(brand)).replace(/[^a-z0-9]/g, '');
  if (b.length < 3) return false;
  const host = safeString(domain).toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  const hostFlat = host.replace(/[^a-z0-9]/g, '');
  if (hostFlat.includes(b)) return true;
  const labels = host.split('.');
  const sld = (labels.length >= 2 ? labels[labels.length - 2] : labels[0] || '')
    .replace(/[^a-z0-9]/g, '');
  return sld.length >= 4 && b.includes(sld);
}

/**
 * Verdaechtige Hersteller-Kontakt-E-Mail (Halluzinations-Muster wie
 * okopp@apple.com). PURE — kein I/O. Konservativ: nur eindeutige Faelle.
 *
 * Regeln:
 *   - Domain == Hersteller-URL-Domain oder brand-aehnlich → nie suspect;
 *     persoenliches Prefix ergibt nur den Hinweis 'personal_mailbox'.
 *   - Freemail-Provider: persoenliches Prefix → suspect (personal_freemail);
 *     Business-Prefix (info@/service@/…) → ok, Hinweis 'generic_provider'.
 *   - Fremde Firmen-Domain (Mismatch): suspect — mit persoenlichem UND mit
 *     Business-Prefix (info@fremdefirma.de ist kein Beleg fuer den Hersteller).
 *   - Ohne jede Referenz (weder manufacturerUrl noch brand): kein Urteil → ok.
 *
 * @param {string} email
 * @param {{ manufacturerUrl?: string, brand?: string }} [ctx]
 * @returns {{ suspect: boolean, reason: string|null, issues: string[] }}
 */
function looksLikeSuspectEmail(email, ctx = {}) {
  const parts = _emailParts(email);
  if (!parts) {
    const empty = !safeString(email);
    return {
      suspect: false,
      reason: empty ? 'empty' : 'not_an_email',
      issues: empty ? [] : ['invalid_email_format'],
    };
  }
  const manufacturerUrl = ctx && ctx.manufacturerUrl;
  const brand = ctx && ctx.brand;
  const personal = _isPersonalLocalPart(parts.local);
  const emailReg = _registrableDomain(parts.domain);
  const mfrHost = _hostnameOf(manufacturerUrl);
  const domainMatchesUrl = !!mfrHost && _registrableDomain(mfrHost) === emailReg;
  const domainMatchesBrandName = _domainMatchesBrand(parts.domain, brand);

  if (domainMatchesUrl || domainMatchesBrandName) {
    return {
      suspect: false,
      reason: 'domain_match',
      issues: personal ? ['personal_mailbox'] : [],
    };
  }

  if (GENERIC_EMAIL_PROVIDERS.has(emailReg) || GENERIC_EMAIL_PROVIDERS.has(parts.domain)) {
    if (personal) {
      return {
        suspect: true,
        reason: 'personal_freemail',
        issues: ['personal_mailbox', 'generic_provider'],
      };
    }
    return { suspect: false, reason: 'generic_provider', issues: ['generic_provider'] };
  }

  if (!mfrHost && !safeString(brand)) {
    // Keine Referenz → kein Mismatch-Urteil moeglich (konservativ: kein Flag).
    return {
      suspect: false,
      reason: 'no_reference',
      issues: personal ? ['personal_mailbox'] : [],
    };
  }

  return {
    suspect: true,
    reason: personal ? 'foreign_domain_personal' : 'foreign_domain',
    issues: personal ? ['domain_mismatch', 'personal_mailbox'] : ['domain_mismatch'],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1c. classifyImpressumUrl — PURE, kein I/O (analog classifyPriceSourceUrl).
// ───────────────────────────────────────────────────────────────────────────

const IMAGE_CDN_HOSTS = [
  /(^|\.)gstatic\.com$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)ggpht\.com$/i,
];
const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|svg|ico)([?#]|$)/i;

const SOCIAL_HOST_RES = [
  /(^|\.)facebook\.com$/i,
  /(^|\.)fb\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)pinterest\.[a-z.]+$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)threads\.net$/i,
];

// Marktplaetze hosten das Impressum des MARKTPLATZES, nie das des Herstellers.
const MARKETPLACE_HOST_RES = [
  /(^|\.)ebay\.[a-z.]+$/i,
  /(^|\.)amazon\.[a-z.]+$/i,
  /(^|\.)kaufland\.[a-z.]+$/i,
  /(^|\.)otto\.de$/i,
  /(^|\.)etsy\.com$/i,
  /(^|\.)alibaba\.com$/i,
  /(^|\.)aliexpress\.[a-z.]+$/i,
  /(^|\.)temu\.com$/i,
  /(^|\.)wish\.com$/i,
  /(^|\.)idealo\.[a-z.]+$/i,
  /(^|\.)geizhals\.[a-z.]+$/i,
  /(^|\.)billiger\.de$/i,
  /(^|\.)rakuten\.[a-z.]+$/i,
  /(^|\.)hood\.de$/i,
];

const SEARCH_URL_PATTERNS = [
  /google\.[a-z.]+\/(search|shopping|maps)/i,
  /bing\.[a-z.]+\/(search|shop)/i,
  /duckduckgo\.com\//i,
  /\/search([/?#]|$)/i,
  /[?&](q|query|search|search_value|searchterm|nkw|_nkw|keywords)=/i,
  /\/collections?\//i,
  /\/(category|categories|kategorie|kategorien)\//i,
];

const IMPRESSUM_PATH_RE = /\/(impressum|imprint|kontakt|contact|legal-notice|legal|about(-us)?)([/?#]|$)/i;

/**
 * Klassifiziert eine URL als Hersteller-Beleg-Kandidat. PURE — kein I/O.
 * Such-/Kategorie-, Social- und Marktplatz-URLs sind als Hersteller-Beleg
 * untauglich; Impressum-/Kontakt-/Legal-/About-Pfade und Hersteller-Domains
 * sind tauglich.
 *
 * @param {string} rawUrl
 * @returns {{ kind: 'candidate'|'search'|'social'|'marketplace'|'image'|'invalid', reason: string }}
 */
function classifyImpressumUrl(rawUrl) {
  const url = safeString(rawUrl);
  if (!url) return { kind: 'invalid', reason: 'empty' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid', reason: 'not_a_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'non_http' };
  }
  const host = parsed.hostname.replace(/^www\./i, '');
  if (!host.includes('.')) return { kind: 'invalid', reason: 'invalid_host' };
  if (IMAGE_CDN_HOSTS.some((re) => re.test(host))) return { kind: 'image', reason: 'image_cdn' };
  if (IMAGE_FILE_RE.test(parsed.pathname)) return { kind: 'image', reason: 'image_file' };
  if (SOCIAL_HOST_RES.some((re) => re.test(host))) return { kind: 'social', reason: 'social_network' };
  if (MARKETPLACE_HOST_RES.some((re) => re.test(host))) return { kind: 'marketplace', reason: 'marketplace' };
  if (SEARCH_URL_PATTERNS.some((re) => re.test(url))) return { kind: 'search', reason: 'search_or_category_page' };
  if (IMPRESSUM_PATH_RE.test(parsed.pathname)) return { kind: 'candidate', reason: 'impressum_path' };
  return { kind: 'candidate', reason: 'ok' };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. verifyGpsrRecord — Verifikation gegebener GPSR-Daten gegen echte Seiten.
// ───────────────────────────────────────────────────────────────────────────

const IMPRESSUM_PATHS = ['/impressum', '/imprint', '/kontakt', '/contact', '/legal-notice', '/about'];

/**
 * Kandidaten-URLs aus gpsr.url: die URL selbst + https-Varianten der
 * ueblichen Impressum-Pfade auf derselben Domain, gefiltert via
 * classifyImpressumUrl. Ist bereits die DOMAIN untauglich (Social/Marktplatz/
 * Bild-CDN), gibt es KEINE Kandidaten — facebook.com/impressum ist das
 * Impressum von Facebook, nie das des Herstellers. PURE — kein I/O.
 *
 * @param {string} rawUrl
 * @returns {string[]}
 */
function buildCandidateUrls(rawUrl) {
  const s = safeString(rawUrl);
  if (!s) return [];
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
  const rootCls = classifyImpressumUrl(`https://${parsed.host}/`);
  if (rootCls.kind !== 'candidate') return [];

  const urls = [];
  const seen = new Set();
  const push = (u) => {
    const key = u.replace(/\/+$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    if (classifyImpressumUrl(u).kind === 'candidate') urls.push(u);
  };
  push(parsed.toString());
  const httpsBase = `https://${parsed.host}`;
  for (const p of IMPRESSUM_PATHS) push(httpsBase + p);
  return urls;
}

/**
 * Diakritik-/Interpunktions-tolerante Normalisierung fuer Seiten-Matching.
 */
function normalizeForPageMatch(s) {
  return safeString(s)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrahiert den Adress-Kern aus einem GPSR-Record: (Strasse + Hausnummer)
 * und/oder (PLZ + Stadt). Explizite Felder (manufacturer_postalcode/_city)
 * gewinnen; sonst wird konservativ aus manufacturer_address geparst.
 * PURE — kein I/O.
 */
function extractAddressParts(gpsr) {
  const address = safeString(gpsr && gpsr.manufacturer_address);
  const segments = address.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  let street = null;
  for (const seg of segments) {
    // Strasse: enthaelt Buchstaben UND Ziffern, beginnt aber nicht mit einer PLZ.
    if (/\d/.test(seg) && /[a-zäöüß]/i.test(seg) && !/^\d{4,6}(\s|$)/.test(seg)) {
      street = seg;
      break;
    }
  }
  let postal = safeString(gpsr && gpsr.manufacturer_postalcode);
  let city = safeString(gpsr && gpsr.manufacturer_city);
  if (!postal || !city) {
    // "…, 81739 München" — letzte 4-6-stellige Zahl gilt als PLZ, Woerter danach als Stadt.
    const matches = [...address.matchAll(/(^|\D)(\d{4,6})\s+([a-zäöüß][a-zäöüß .\-]{1,40})/gi)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      if (!postal) postal = last[2];
      if (!city) city = last[3].trim();
    }
  }
  return { street, postal: postal || null, city: city || null };
}

/**
 * Strassen-Varianten: "Carl-Wery-Str. 34" muss auch "Carl-Wery-Straße 34"
 * auf der Seite matchen (und umgekehrt).
 */
function _streetNeedles(street) {
  const base = normalizeForPageMatch(street);
  if (!base || base.length < 4) return [];
  const set = new Set([base]);
  set.add(base.replace(/strasse\b/g, 'str'));
  set.add(base.replace(/str\b/g, 'strasse'));
  return [...set].filter((x) => x.length >= 4);
}

/**
 * Prueft einen geladenen Seiteninhalt (Text + Roh-HTML) gegen einen
 * GPSR-Record. PURE — kein I/O. Exportiert fuer Tests.
 *
 * @returns {{ ok: boolean, reason: string, nameMatch: boolean,
 *   addressMatch: boolean, emailMatch: 'confirmed'|'unconfirmed'|null,
 *   phoneMatch: 'confirmed'|'unconfirmed'|null }}
 */
function evaluateGpsrPageEvidence({ text, html, gpsr } = {}) {
  const record = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const rawText = String(text || '');
  const rawHtml = String(html || '');
  const combined = rawHtml ? `${rawText}\n${rawHtml}` : rawText;
  if (!combined || combined.length < 200) {
    return { ok: false, reason: 'page_empty', nameMatch: false, addressMatch: false, emailMatch: null, phoneMatch: null };
  }
  const haystack = normalizeForPageMatch(combined);
  const haystackRaw = combined.toLowerCase();
  const haystackDigits = combined.replace(/\D+/g, '');

  // (a) manufacturer_name — stripCorpSuffixes + diakritik-tolerant.
  const nameNeedle = normalizeForPageMatch(
    normalizeForCompare('brand', safeString(record.manufacturer_name))
  );
  const nameMatch = nameNeedle.length >= 3 && haystack.includes(nameNeedle);

  // (b) Adress-Kern: (Strasse+Hausnr) ODER (PLZ+Stadt).
  const { street, postal, city } = extractAddressParts(record);
  const streetHit = _streetNeedles(street || '').some((n) => haystack.includes(n));
  const postalNorm = normalizeForPageMatch(postal || '');
  const cityNorm = normalizeForPageMatch(city || '');
  const plzCityHit = !!postalNorm && !!cityNorm
    && haystack.includes(postalNorm) && haystack.includes(cityNorm);
  const addressMatch = streetHit || plzCityHit;

  // (c) email/phone: optional — gefunden → confirmed, sonst unconfirmed (KEIN Fail).
  const email = safeString(record.email).toLowerCase();
  const emailMatch = email
    ? (haystackRaw.includes(email) ? 'confirmed' : 'unconfirmed')
    : null;

  const phoneRaw = safeString(record.manufacturer_phone || record.phone);
  let phoneMatch = null;
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D+/g, '');
    const variants = new Set();
    if (digits.length >= 7) {
      variants.add(digits);
      if (digits.startsWith('00')) variants.add(digits.slice(2));
      // +49 89 … ↔ 089 … (nationale Schreibweise)
      if (/^\+/.test(phoneRaw) && digits.length >= 9) {
        variants.add(`0${digits.slice(2)}`);
      }
    }
    phoneMatch = [...variants].some((v) => haystackDigits.includes(v))
      ? 'confirmed'
      : 'unconfirmed';
  }

  const ok = nameMatch && addressMatch;
  const reason = ok
    ? 'verified'
    : (nameMatch ? 'address_not_on_page' : 'name_not_on_page');
  return { ok, reason, nameMatch, addressMatch, emailMatch, phoneMatch };
}

/**
 * Herzstueck: verifiziert einen GEGEBENEN GPSR-Record gegen echte Seiten.
 * KEIN Gemini — reine Verifikation. Fake-Gates (Telefon/E-Mail) laufen
 * IMMER, auch wenn kein Netz-Urteil moeglich ist.
 *
 * Status:
 *   - 'verified'      — Name + Adresse auf einer Kandidaten-Seite belegt
 *   - 'partial'       — nur der Name belegt
 *   - 'unverifiable'  — Seiten geladen (oder 404/410), Beleg nicht gefunden
 *   - 'infra_blocked' — ALLE Abrufe scheiterten an Infrastruktur
 *                       (0/401/403/429/5xx) → ehrlich "konnten nicht pruefen",
 *                       NIE als unverifiable werten
 *
 * Die Feld-Bereinigung im Rueckgabe-gpsr (fake phone / suspect email → null)
 * ist ein VORSCHLAG — ob geschrieben wird, entscheidet der Caller.
 *
 * @param {object} params
 * @param {string} [params.brand]
 * @param {object} params.gpsr — { manufacturer_name, manufacturer_address,
 *   manufacturer_city?, manufacturer_postalcode?, email?, manufacturer_phone?|phone?, url? }
 * @param {Function} [params.fetchImpl] — Injection fuer Tests; Signatur wie
 *   fetchPageForVerification: (url, { timeoutMs }) → { ok, status, text, html, via }
 * @param {number} [params.timeoutMs=15000]
 * @param {number} [params.maxPages=4]
 * @returns {Promise<{ status: 'verified'|'partial'|'unverifiable'|'infra_blocked',
 *   matchedFields: object, evidence: { url, checked_at, method }|null,
 *   issues: string[], gpsr: object, attempts: Array }>}
 */
async function verifyGpsrRecord({ brand, gpsr, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const record = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const cleaned = { ...record };
  const issues = [];
  const checkedAt = new Date().toISOString();

  // ── Fake-Gates: laufen IMMER, unabhaengig vom Netz ────────────────────────
  const phoneKey = record.manufacturer_phone != null && safeString(record.manufacturer_phone)
    ? 'manufacturer_phone'
    : (record.phone != null && safeString(record.phone) ? 'phone' : null);
  const phoneVal = phoneKey ? safeString(record[phoneKey]) : '';
  if (phoneVal && looksLikeFakePhone(phoneVal)) {
    issues.push('fake_phone_pattern');
    cleaned[phoneKey] = null;
  }
  let suspectEmail = false;
  if (safeString(record.email)) {
    const emailCheck = looksLikeSuspectEmail(record.email, { manufacturerUrl: record.url, brand });
    for (const i of emailCheck.issues) {
      if (!issues.includes(i)) issues.push(i);
    }
    if (emailCheck.suspect) {
      suspectEmail = true;
      issues.push(`suspect_email:${emailCheck.reason}`);
      cleaned.email = null;
    }
  }

  const matchedFields = {
    name: false,
    address: false,
    email: safeString(record.email) ? 'unconfirmed' : null,
    phone: phoneVal ? 'unconfirmed' : null,
  };

  const bail = (status, extraIssue) => {
    if (extraIssue && !issues.includes(extraIssue)) issues.push(extraIssue);
    return { status, matchedFields, evidence: null, issues, gpsr: cleaned, attempts: [] };
  };

  if (!gpsr || typeof gpsr !== 'object') return bail('unverifiable', 'no_gpsr_data');
  const name = safeString(record.manufacturer_name);
  if (!name) return bail('unverifiable', 'no_manufacturer_name');

  const candidates = buildCandidateUrls(record.url).slice(0, Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES));
  if (candidates.length === 0) return bail('unverifiable', 'no_candidate_urls');

  const fetcher = fetchImpl || fetchPageForVerification;
  const attempts = [];
  let best = null; // { level: 2=verified | 1=partial, url, via }
  let contentJudgements = 0;
  let infraFailures = 0;

  for (const url of candidates) {
    let page;
    try {
      page = await fetcher(url, { timeoutMs });
    } catch (err) {
      attempts.push({ url, ok: false, status: 0, reason: `fetch_error:${err && err.message}`, infra: true });
      infraFailures += 1;
      continue;
    }
    if (!page || !page.ok) {
      const status = Number(page && page.status) || 0;
      const infra = isInfraFetchFailure(status);
      attempts.push({ url, ok: false, status, reason: `fetch_failed_${status}`, infra });
      // 404/410 = Evidenz GEGEN die Quelle (echtes Urteil), Infra = kein Urteil.
      if (infra) infraFailures += 1;
      else contentJudgements += 1;
      continue;
    }

    const ev = evaluateGpsrPageEvidence({ text: page.text, html: page.html, gpsr: record });
    contentJudgements += 1;
    attempts.push({ url, ok: true, status: Number(page.status) || 200, reason: ev.reason, infra: false });

    if (ev.nameMatch) matchedFields.name = true;
    if (ev.addressMatch) matchedFields.address = true;
    if (ev.emailMatch === 'confirmed') matchedFields.email = 'confirmed';
    if (ev.phoneMatch === 'confirmed') matchedFields.phone = 'confirmed';

    const level = ev.nameMatch && ev.addressMatch ? 2 : (ev.nameMatch ? 1 : 0);
    if (level > 0 && (!best || level > best.level)) {
      best = { level, url, via: page.via || 'fetch' };
    }
    if (level === 2) break; // verified — frueh raus, keine weiteren Abrufe noetig
  }

  let status;
  if (best && best.level === 2) status = 'verified';
  else if (best && best.level === 1) status = 'partial';
  else if (contentJudgements === 0 && infraFailures > 0) status = 'infra_blocked';
  else status = 'unverifiable';

  if (status === 'infra_blocked' && !issues.includes('fetch_infrastructure_failure')) {
    issues.push('fetch_infrastructure_failure');
  }
  if (suspectEmail && matchedFields.email === 'confirmed') {
    // Beleg-Signal fuer den Caller: die als suspect genullte Adresse steht
    // WIRKLICH auf der Hersteller-Seite — Restore ist Caller-Entscheidung.
    if (!issues.includes('suspect_email_found_on_page')) issues.push('suspect_email_found_on_page');
  }

  const evidence = best
    ? { url: best.url, checked_at: checkedAt, method: best.via }
    : null;

  return { status, matchedFields, evidence, issues, gpsr: cleaned, attempts };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. getOrVerifyBrandGpsr — Cache-Wrapper (Muster: hazmat-gemini-lookup.js).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stabiler Firestore-Doc-Key aus einem Markennamen ("TOMMY JEANS" → "tommy-jeans").
 */
function brandCacheKey(brand) {
  const raw = safeString(brand).toLowerCase();
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Fingerprint des GPSR-Records: ein Cache-Hit gilt nur fuer EXAKT dieselben
 * Daten — sonst wuerde eine alte Verifikation fremde Werte "belegen".
 */
function gpsrFingerprint(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  return [
    normalizeForPageMatch(safeString(g.manufacturer_name)),
    normalizeForPageMatch(safeString(g.manufacturer_address)),
    normalizeForPageMatch(safeString(g.manufacturer_postalcode)),
    normalizeForPageMatch(safeString(g.manufacturer_city)),
    safeString(g.email).toLowerCase(),
    safeString(g.manufacturer_phone || g.phone).replace(/\D+/g, ''),
    safeString(g.url).toLowerCase(),
  ].join('|');
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
 * Cache-Read: frischer Eintrag (TTL 30d) MIT passendem Fingerprint, sonst null.
 * Wirft nie.
 */
async function readGpsrEvidenceCache(brand, fingerprint) {
  const key = brandCacheKey(brand);
  if (!key) return null;
  try {
    const db = _getFirestore();
    const snap = await db.collection(CACHE_COLLECTION).doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const tsMs = _timestampToMs(data.checkedAt);
    if (!tsMs) return null;
    if ((Date.now() - tsMs) > CACHE_TTL_MS) return null;
    if (!data.result || typeof data.result !== 'object') return null;
    if (safeString(data.fingerprint) !== safeString(fingerprint)) return null;
    return {
      result: data.result,
      negative: !!data.negative,
      cached: true,
      checkedAtMs: tsMs,
    };
  } catch (err) {
    try {
      logger.warn(
        { brand, error: err && err.message ? err.message : String(err) },
        '[gpsr-evidence] cache read failed'
      );
    } catch (_) { /* logger optional */ }
    return null;
  }
}

/**
 * Cache-Write: persistiert auch NEGATIVE Ergebnisse (unverifiable), aber NIE
 * transiente Infrastruktur-Ausfaelle (infra_blocked). Wirft nie.
 */
async function writeGpsrEvidenceCache(brand, fingerprint, result) {
  const key = brandCacheKey(brand);
  if (!key || !result || typeof result !== 'object') return;
  if (result.status === 'infra_blocked') return; // transient — NICHT cachen
  try {
    const db = _getFirestore();
    // JSON-Roundtrip strippt undefined-Werte (Firestore lehnt sie ab).
    const cleanResult = JSON.parse(JSON.stringify(result));
    await db.collection(CACHE_COLLECTION).doc(key).set({
      brand: safeString(brand),
      brand_lc: safeString(brand).toLowerCase(),
      fingerprint: safeString(fingerprint),
      status: result.status,
      negative: result.status === 'unverifiable',
      result: cleanResult,
      checkedAt: new Date(),
    });
  } catch (err) {
    try {
      logger.warn(
        { brand, error: err && err.message ? err.message : String(err) },
        '[gpsr-evidence] cache write failed'
      );
    } catch (_) { /* logger optional */ }
  }
}

/**
 * Get-or-verify-Wrapper: Cache first (TTL 30d, Fingerprint-Match, inkl.
 * Negativ-Eintraege), sonst verifyGpsrRecord + Persist. infra_blocked wird
 * NIE gecacht (naechster Lauf prueft erneut).
 *
 * @param {object} params
 * @param {string} [params.brand]
 * @param {object} params.gpsr
 * @param {Function} [params.fetchImpl]
 * @param {boolean} [params.useCache=true]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxPages]
 * @returns {Promise<null|object>} verifyGpsrRecord-Shape + { cached, negative }
 */
async function getOrVerifyBrandGpsr(params = {}) {
  const { brand, gpsr, fetchImpl, timeoutMs, maxPages } = params;
  if (!gpsr || typeof gpsr !== 'object') return null;

  const fingerprint = gpsrFingerprint(gpsr);

  if (params.useCache !== false && safeString(brand)) {
    const cached = await readGpsrEvidenceCache(brand, fingerprint);
    if (cached && cached.result) {
      return { ...cached.result, cached: true, negative: cached.negative };
    }
  }

  const result = await verifyGpsrRecord({ brand, gpsr, fetchImpl, timeoutMs, maxPages });
  if (safeString(brand)) {
    await writeGpsrEvidenceCache(brand, fingerprint, result);
  }
  return { ...result, cached: false, negative: result.status === 'unverifiable' };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. findManufacturerImpressumUrl — Kandidaten-URL-Beschaffung fuer das Gate.
//
// Incident 2026-08-04 (SKU-2834170242): verifyGpsrRecord baut Kandidaten NUR
// aus gpsr.url. Chat-Vorschlaege ohne URL wurden damit OHNE einen einzigen
// Netz-Request als "unverifiable" verworfen — egal wie korrekt die Daten
// waren. Dieser Helper beschafft die fehlende URL, urteilt aber NICHT selbst:
// die eigentliche Pruefung (Name+Adresse auf der Seite) bleibt bei
// verifyGpsrRecord. Reihenfolge: Marken-Registry (gpsrManufacturers) →
// Web-Suche "<Name> Impressum" (SerpAPI-first via lib/web-search-html).
// Best-effort: jeder Fehler → null, nie werfen.
// ───────────────────────────────────────────────────────────────────────────

function _normalizeToken(v) {
  return safeString(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function findManufacturerImpressumUrl({ brand, manufacturerName, searchImpl, registryLookupImpl } = {}) {
  const primaryName = safeString(manufacturerName) || safeString(brand);
  if (!primaryName) return null;

  // 1) Registry: bekannte Hersteller tragen ihre URL bereits.
  try {
    const lookup = registryLookupImpl || (async (n) => {
      const { getManufacturerGpsrByName } = require('./gpsr-manufacturer-registry');
      return getManufacturerGpsrByName(n);
    });
    const names = [safeString(manufacturerName), safeString(brand)].filter(Boolean);
    for (const name of names) {
      const entry = await lookup(name);
      const raw = entry && safeString(entry.url);
      if (!raw) continue;
      const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      if (classifyImpressumUrl(candidate).kind === 'candidate') return candidate;
    }
  } catch { /* best effort — weiter zur Suche */ }

  // 2) Web-Suche nach dem Impressum des Herstellers.
  try {
    const search = searchImpl || ((q, o) => require('./web-search-html').searchWeb(q, o));
    const res = await search(`${primaryName} Impressum`, { limit: 6, locale: 'de-DE' });
    const results = res && Array.isArray(res.results) ? res.results : [];
    const candidates = [];
    for (const r of results) {
      const u = safeString(r && r.url);
      if (!u) continue;
      if (classifyImpressumUrl(u).kind !== 'candidate') continue;
      candidates.push(u);
    }
    if (!candidates.length) return null;
    // Domain-Plausibilitaet: bevorzugt eine Domain, die den Marken-/Namens-Token
    // traegt (fjallraven → fjallraven.com). Ohne Treffer KEIN blinder Fallback
    // auf fremde Domains — verifyGpsrRecord wuerde auf einer beliebigen
    // Drittseite zwar Adress-genau pruefen, aber ein "partial" (nur Name)
    // waere dort wertlos bis irrefuehrend.
    const tokens = [primaryName, safeString(brand)]
      .map((n) => _normalizeToken(n.split(/\s+/)[0] || n))
      .filter((t) => t.length >= 4);
    for (const u of candidates) {
      let host = '';
      try { host = _normalizeToken(new URL(u).hostname); } catch { continue; }
      if (tokens.some((t) => host.includes(t))) return u;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  // Pure Gates
  looksLikeFakePhone,
  looksLikeSuspectEmail,
  classifyImpressumUrl,
  // URL-Beschaffung fuer das Gate
  findManufacturerImpressumUrl,
  // Verifikation
  buildCandidateUrls,
  extractAddressParts,
  evaluateGpsrPageEvidence,
  verifyGpsrRecord,
  // Cache-Wrapper
  getOrVerifyBrandGpsr,
  readGpsrEvidenceCache,
  writeGpsrEvidenceCache,
  brandCacheKey,
  gpsrFingerprint,
  // Konstanten fuer Tests
  CACHE_COLLECTION,
  CACHE_TTL_MS,
};
