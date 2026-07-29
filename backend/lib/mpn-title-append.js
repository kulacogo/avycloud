'use strict';

/**
 * Herstellernummer (MPN) ans Titelende anhängen — reine Funktionen, KEIN I/O.
 *
 * HINTERGRUND (Messung 2026-07-29 an products_v2, tenantId='default'):
 * 581 von 765 Bestandsprodukten haben eine Herstellernummer, aber nur 165
 * tragen sie im Titel. Bei Ersatzteilen/Zubehör ist die Teilenummer die
 * häufigste Sucheingabe auf eBay — fehlt sie im Titel, findet die Suche das
 * Angebot nicht.
 *
 * NICHT VERHANDELBAR (deshalb ausschliesslich additive Regeln):
 * - NUR hinten anhängen. Niemals kürzen, umsortieren oder die Marke verdrängen.
 * - Passt "<titel> <mpn>" nicht in maxLen → Titel bleibt exakt unverändert.
 * - Idempotent: zweimal angewendet ändert sich nichts.
 *
 * Gatet wird der Aufruf (nicht dieses Modul) über TITLE_APPEND_MPN:
 *   unset|'off'  → Codepfad wird gar nicht betreten (heutiges Verhalten)
 *   'shadow'     → rechnen + loggen, NICHTS mutieren
 *   'on'         → Titel wirklich ergänzen
 */

/** Generische Platzhalter, normalisiert (nur A-Z0-9). */
const GENERIC_PLACEHOLDER_KEYS = new Set([
  'DOESNOTAPPLY',
  'DOESNTAPPLY',
  'NOTAPPLICABLE',
  'NOTAPPLY',
  'NA',
  'NV',
  'NONE',
  'NULL',
  'KEINE',
  'KEINEANGABE',
  'OHNEANGABE',
  'UNBEKANNT',
  'UNKNOWN',
  'TODO',
  'TBD',
  'XXX',
  'XXXX',
]);

/** GTIN-Längen: reine Ziffernfolgen dieser Länge sind EAN/UPC-Fehlablagen. */
const GTIN_DIGIT_LENGTHS = new Set([8, 12, 13, 14]);

const MIN_MPN_LENGTH = 3;

function safeString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/**
 * Normalisiert auf Grossschrift + nur A-Z0-9.
 * '0 986 479 058' und '0986479058' und '0-986-479-058' → '0986479058'.
 */
function normalizeKey(value) {
  const s = safeString(value);
  if (!s) return '';
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Führende Nullen weg — GTINs werden mal mit, mal ohne gespeichert. */
function stripLeadingZeros(key) {
  if (!key) return '';
  const stripped = key.replace(/^0+/, '');
  return stripped || key;
}

function keysMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return stripLeadingZeros(a) === stripLeadingZeros(b);
  }
  return false;
}

/**
 * Ist die MPN als Titel-Token brauchbar?
 *
 * @param {*} rawMpn
 * @param {{gtins?: Array<*>, sku?: *, brand?: *}} [ctx]
 * @returns {{ok: boolean, reason: string, mpn: string, key: string}}
 */
function isUsefulMpn(rawMpn, ctx = {}) {
  const mpn = safeString(rawMpn);
  const key = normalizeKey(mpn);
  const out = (ok, reason) => ({ ok, reason, mpn, key });

  if (!mpn) return out(false, 'empty');
  if (!key) return out(false, 'empty'); // z. B. '-', '--', '/'
  if (GENERIC_PLACEHOLDER_KEYS.has(key)) return out(false, 'placeholder');
  if (mpn.length < MIN_MPN_LENGTH || key.length < MIN_MPN_LENGTH) return out(false, 'too_short');

  // Reine 8/12/13/14-stellige Ziffernfolgen sind EAN/UPC/GTIN-Fehlablagen,
  // keine Herstellernummern.
  if (/^\d+$/.test(key) && GTIN_DIGIT_LENGTHS.has(key.length)) return out(false, 'gtin_like');

  const gtins = Array.isArray(ctx.gtins) ? ctx.gtins : [];
  for (const gtin of gtins) {
    if (keysMatch(key, normalizeKey(gtin))) return out(false, 'equals_gtin');
  }

  if (keysMatch(key, normalizeKey(ctx.sku))) return out(false, 'equals_sku');
  if (key === normalizeKey(ctx.brand)) return out(false, 'equals_brand');

  return out(true, 'ok');
}

/**
 * Steht die MPN (separator-unabhängig) schon im Titel?
 */
function titleContainsMpn(title, mpn) {
  const titleKey = normalizeKey(title);
  const mpnKey = normalizeKey(mpn);
  if (!titleKey || !mpnKey) return false;
  return titleKey.includes(mpnKey);
}

/**
 * Hängt die MPN hinten an — oder gibt den Titel unverändert zurück.
 *
 * @param {string} title
 * @param {string} mpn
 * @param {{maxLen?: number}} [opts]
 * @returns {string}
 */
function appendMpnToTitle(title, mpn, opts = {}) {
  const original = typeof title === 'string' ? title : title === undefined || title === null ? '' : String(title);
  const maxLenRaw = Number(opts.maxLen);
  const maxLen = Number.isFinite(maxLenRaw) && maxLenRaw > 0 ? maxLenRaw : 80;

  const base = original.trim();
  const token = safeString(mpn);
  if (!base || !token) return original;

  // Schon drin (auch mit anderen Trennzeichen) → nichts tun. Das ist auch
  // die Idempotenz-Garantie.
  if (titleContainsMpn(base, token)) return original;

  const next = `${base} ${token}`;
  // NIEMALS kürzen: passt es nicht, bleibt der Titel wie er ist.
  if (next.length > maxLen) return original;
  return next;
}

function pickAttr(attrs, ...names) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return '';
  const lowerMap = new Map();
  for (const k of Object.keys(attrs)) {
    lowerMap.set(String(k).trim().toLowerCase(), attrs[k]);
  }
  for (const name of names) {
    const v = lowerMap.get(String(name).trim().toLowerCase());
    const s = safeString(v);
    if (s) return s;
  }
  return '';
}

/** Herstellernummer aus dem Produkt lesen (kanonisch: details.identifiers.mpn). */
function extractMpn(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes;
  return safeString(ids.mpn) || pickAttr(attrs, 'Herstellernummer', 'MPN', 'Hersteller-Nummer');
}

/** Alle bekannten GTIN-artigen Kennungen des Produkts. */
function extractGtins(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes;
  const out = [];
  for (const key of ['ean', 'upc', 'gtin', 'isbn']) {
    const v = safeString(ids[key]);
    if (v) out.push(v);
  }
  for (const name of ['EAN', 'UPC', 'GTIN', 'ISBN']) {
    const v = pickAttr(attrs, name);
    if (v) out.push(v);
  }
  return out;
}

function extractSku(product) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku);
}

function extractBrand(product) {
  return safeString(product?.identification?.brand) || safeString(product?.details?.brand);
}

/**
 * Entscheidet für ein Produkt, ob und wie der Titel ergänzt würde.
 * Rein — mutiert das Produkt NICHT.
 *
 * @returns {{changed: boolean, title: string, mpn: string, reason: string}}
 */
function computeMpnTitleAppend(product, title, opts = {}) {
  const original = typeof title === 'string' ? title : title === undefined || title === null ? '' : String(title);
  const mpn = extractMpn(product);
  const check = isUsefulMpn(mpn, {
    gtins: extractGtins(product),
    sku: extractSku(product),
    brand: extractBrand(product),
  });
  if (!check.ok) {
    return { changed: false, title: original, mpn, reason: check.reason };
  }
  if (!original.trim()) {
    return { changed: false, title: original, mpn, reason: 'no_title' };
  }
  if (titleContainsMpn(original, mpn)) {
    return { changed: false, title: original, mpn, reason: 'already_in_title' };
  }
  const next = appendMpnToTitle(original, mpn, opts);
  if (next === original) {
    return { changed: false, title: original, mpn, reason: 'no_fit' };
  }
  return { changed: true, title: next, mpn, reason: 'appended' };
}

/**
 * Flag TITLE_APPEND_MPN: 'off' (default, unset == off) | 'shadow' | 'on'.
 */
function getTitleAppendMpnMode(env = process.env) {
  const raw = String((env && env.TITLE_APPEND_MPN) || '').trim().toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes') return 'on';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

module.exports = {
  normalizeKey,
  isUsefulMpn,
  titleContainsMpn,
  appendMpnToTitle,
  computeMpnTitleAppend,
  extractMpn,
  extractGtins,
  getTitleAppendMpnMode,
  GENERIC_PLACEHOLDER_KEYS,
  MIN_MPN_LENGTH,
};
