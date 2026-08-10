/**
 * listing-error-classify.js — maps a marketplace listing error (eBay/Kaufland)
 * onto a STABLE group key + a human-readable German label, so the Listing-Fehler
 * cockpit can group hundreds of failures into a handful of actionable buckets
 * ("12× ISBN fehlt", "5× Bild-URL Strichpunkt") for batch fixing.
 *
 * Input is tolerant: an error object ({ code, message, severity, kind }) or a
 * raw string. Classification is by explicit code first, then message patterns.
 * Unknown errors fall back to OTHER (never throws).
 */

// Ordered rules — first match wins. Each: { key, label, codes?, test?(msg) }.
const RULES = [
  {
    // Kaufland "Ungültig"-Listings (product_valid=false) — geschrieben von der
    // invalid-reasons-Phase in services/kaufland-listings-sync.js. Bewusst als
    // ERSTE Regel: der explizite Code muss gewinnen, bevor generische
    // Message-Pattern (REQUIRED_ASPECT_MISSING, IMAGE_ISSUE, …) auf die im
    // Fehlertext aufgezählten Attributnamen (z.B. 'Bild') anspringen.
    key: 'KAUFLAND_PRODUCT_DATA_INVALID',
    label: 'Kaufland: Produktdaten unvollständig/abgelehnt',
    codes: ['KAUFLAND_PRODUCT_DATA_INVALID'],
    test: (m) => /kaufland-?angebot inaktiv|fehlende produktdaten/i.test(m),
  },
  {
    key: 'ALREADY_LISTED',
    label: 'Bereits gelistet',
    test: (m) => /bereits.*(gelistet|gelisted)|already.*listed|duplicate listing/i.test(m),
  },
  {
    key: 'IMG_URL_SEMICOLON',
    label: 'Bild-URL enthält Strichpunkt',
    test: (m) => /(bild-?url|video-?id|picture ?url).*(strichpunkt|semikolon|semicolon)/i.test(m)
      || /(strichpunkt|semikolon|semicolon).*(bild-?url|video-?id)/i.test(m),
  },
  {
    key: 'ISBN_MISSING',
    label: 'ISBN fehlt',
    test: (m) => /\bisbn\b.*(fehlt|missing|required|hinzu)/i.test(m) || /feld isbn/i.test(m),
  },
  {
    key: 'EAN_ISSUE',
    label: 'EAN fehlt oder ungültig',
    codes: ['KAUFLAND_EAN_INVALID', 'KAUFLAND_EAN_MISSING'],
    test: (m) => /\bean\b.*(fehlt|invalid|ungültig|ungueltig|missing|nicht registriert)/i.test(m)
      || /keine ean/i.test(m),
  },
  {
    // Muss VOR PRICE_MISSING stehen: hier IST ein Preis da, er wurde nur nie
    // bewusst entschieden (stiller Rueckfall auf den recherchierten Marktpreis).
    // Siehe Preis-Gate REQUIRE_EXPLICIT_SELLPRICE, Audit 2026-07-29.
    key: 'SELLPRICE_NOT_CONFIRMED',
    label: 'Verkaufspreis nicht bestätigt',
    test: (m) => /kein bewusst gesetzter verkaufspreis/i.test(m),
  },
  {
    key: 'PRICE_MISSING',
    label: 'Preis fehlt',
    codes: ['EBAY_PUBLISH_NO_PRICE'],
    test: (m) => /(kein preis|preis fehlt|no price|price.*required|kein preis ableitbar)/i.test(m),
  },
  {
    // Muss VOR CATEGORY_MISSING stehen: die Meldung nennt eine Kategorie-ID und
    // wuerde sonst auf das generische Kategorie-Muster anspringen. Hier ist die
    // Kategorie vorhanden — nur der gewaehlte Artikelzustand passt nicht dazu.
    key: 'CONDITION_NOT_ALLOWED',
    label: 'Artikelzustand in dieser Kategorie nicht zulässig',
    codes: ['EBAY_CONDITION_NOT_ALLOWED'],
    test: (m) => /artikelzustand .* nicht zulässig|artikelzustand .* nicht zulaessig/i.test(m),
  },
  {
    key: 'CATEGORY_MISSING',
    label: 'Kategorie fehlt oder ungültig',
    codes: ['EBAY_PUBLISH_NO_CATEGORY'],
    test: (m) => /(kategorie fehlt|keine.*kategorie|category.*(missing|invalid|required))/i.test(m),
  },
  {
    key: 'TITLE_MISSING',
    label: 'Titel fehlt',
    codes: ['EBAY_PUBLISH_NO_TITLE'],
    test: (m) => /(titel fehlt|kein titel|title.*(missing|required))/i.test(m),
  },
  {
    key: 'POLICY_RESTRICTED',
    label: 'Richtlinie / verbotene Begriffe (Fehler 240)',
    codes: ['240'],
    kinds: ['policy'],
    test: (m) => /(verboten|restricted|richtlinie|policy|nicht erlaubt)/i.test(m),
  },
  {
    key: 'REQUIRED_ASPECT_MISSING',
    label: 'Pflicht-Merkmal fehlt',
    test: (m) => /(pflicht|required aspect|item specific|merkmal.*(fehlt|required)|attribut.*fehlt)/i.test(m),
  },
  {
    key: 'NO_STOCK',
    label: 'Kein Bestand',
    test: (m) => /(kein bestand|no stock|out of stock|bestand.*0)/i.test(m),
  },
  {
    key: 'IMAGE_ISSUE',
    label: 'Bildproblem',
    test: (m) => /(bild|picture|image|foto).*(fehlt|missing|ungültig|invalid|konflikt|eps)/i.test(m),
  },
];

const OTHER = { key: 'OTHER', label: 'Sonstiger Fehler' };

function normalizeError(err) {
  if (err == null) return { code: null, message: '', severity: 'Error', kind: null };
  if (typeof err === 'string') return { code: null, message: err, severity: 'Error', kind: null };
  return {
    code: err.code != null ? String(err.code) : null,
    message: String(err.message || err.reason || ''),
    severity: err.severity || 'Error',
    kind: err.kind || null,
  };
}

/**
 * @param {object|string} err
 * @returns {{ groupKey: string, label: string, message: string, code: string|null }}
 */
function classifyListingError(err) {
  const { code, message, kind } = normalizeError(err);
  const msg = message || '';
  for (const rule of RULES) {
    if (code && Array.isArray(rule.codes) && rule.codes.includes(code)) {
      return { groupKey: rule.key, label: rule.label, message: msg, code };
    }
    if (kind && Array.isArray(rule.kinds) && rule.kinds.includes(kind)) {
      return { groupKey: rule.key, label: rule.label, message: msg, code };
    }
    if (typeof rule.test === 'function' && msg && rule.test(msg)) {
      return { groupKey: rule.key, label: rule.label, message: msg, code };
    }
  }
  return { groupKey: OTHER.key, label: OTHER.label, message: msg, code };
}

module.exports = { classifyListingError, RULES, OTHER };
