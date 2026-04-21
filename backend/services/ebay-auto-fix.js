/**
 * eBay Auto-Fix Service — MVP.
 *
 * Versucht ein Produkt automatisch zu reparieren wenn `addFixedPriceItem` fehlgeschlagen ist.
 * Fix-Strategien (in Reihenfolge):
 *   1. Kategorie-Mismatch → primaryCategoryId entfernen, eBay matched per GTIN/EAN-Catalog selbst.
 *   2. Fehlende Pflicht-Aspects → aus Fehlertext extrahieren + Pflichtliste der Kategorie laden,
 *      dann via Gemini Werte generieren und in details.attributes schreiben.
 *
 * Cap: nur was der Aufrufer per Iteration triggert. Service merkt sich keinen Stand —
 * Idempotenz erreicht der Aufrufer durch Vergleich `fixes.length`.
 */

const { getRequiredAspects, isKnownEbayCategoryId, getCategoryAspectCatalog } = require('../lib/ebay-taxonomy');
const {
  extractMisusedAspectNames,
  isCategoryMismatchError,
  isImageConflictError,
  isAspectsCapExceededError,
} = require('../lib/ebay-trading-api');

const EBAY_ASPECTS_CAP = 45;

const ASPECT_GEMINI_TIMEOUT_MS = 8000;
const ASPECT_GEMINI_MAX_TOKENS = 600;

function safeString(v) {
  return v == null ? '' : String(v);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function getErrorMessages(lastError) {
  if (!lastError) return [];
  const out = [];
  if (typeof lastError.message === 'string') out.push(lastError.message);
  const errs = lastError?.details?.errors;
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (e?.longMessage) out.push(String(e.longMessage));
      if (e?.shortMessage) out.push(String(e.shortMessage));
    }
  }
  return out.filter(Boolean);
}

/**
 * Extrahiert "missing aspect"-Namen aus eBay-Fehlertexten (DE + EN).
 * Akzeptierte Muster:
 *   "Item Specifics 'Marke' is required"
 *   "Es fehlt das Merkmal 'Hersteller'"
 *   "Pflichtangabe 'Farbe' fehlt"
 *   "Required item specific Brand is missing"
 *   "Das Merkmal Marke ist erforderlich"
 */
function extractMissingAspectNames(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const found = new Set();
  const patterns = [
    /item\s+specifics?\s+['"]([^'"]+)['"]\s+(?:is\s+required|is\s+missing|must\s+be)/i,
    /required\s+item\s+specific\s+['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?\s+(?:is\s+missing|is\s+required)/i,
    /missing\s+(?:required\s+)?item\s+specific[s:]*\s*['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?(?:\.|,|$)/i,
    /(?:es\s+fehlt|fehlt)\s+(?:das|die)\s+(?:Pflicht-?)?Merkmal[s:]*\s*['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?(?:\.|,|$)/i,
    /Pflichtangabe\s+['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?\s+fehlt/i,
    /(?:Das|Die)\s+Merkmal\s+['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?\s+(?:ist\s+erforderlich|wird\s+ben(?:ö|oe)tigt)/i,
    /Artikelmerkmal\s+['"]?([A-Za-zÄÖÜäöüß0-9 \-/&]+?)['"]?\s+(?:fehlt|ist\s+erforderlich)/i,
  ];
  for (const msg of messages) {
    for (const re of patterns) {
      const m = re.exec(msg);
      if (m && m[1]) {
        const name = m[1].trim().replace(/\s{2,}/g, ' ');
        if (name && name.length <= 60) found.add(name);
      }
    }
  }
  return Array.from(found);
}

function getAttributesMap(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return {};
  return attrs;
}

function setAttribute(product, name, value) {
  if (!product.details) product.details = {};
  if (!product.details.attributes || typeof product.details.attributes !== 'object') {
    product.details.attributes = {};
  }
  product.details.attributes[name] = value;
}

function attributeHasValue(attrs, name) {
  const v = attrs[name];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((x) => safeString(x).trim().length > 0);
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function dedupeMerge(...arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    for (const item of arr || []) {
      const key = safeString(item).trim();
      if (!key) continue;
      const k = key.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(key);
    }
  }
  return out;
}

/**
 * Reduce details.attributes down to EBAY_ASPECTS_CAP entries, prioritising
 * required > recommended > optional (per eBay taxonomy for the product's
 * categoryId) > the remaining attributes in insertion order.
 *
 * Mutates `product` and returns `{ removed, kept, dropped }`.
 */
function trimAspectsToCap(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return { removed: 0, kept: 0, dropped: [] };

  const keys = Object.keys(attrs);
  if (keys.length <= EBAY_ASPECTS_CAP) return { removed: 0, kept: keys.length, dropped: [] };

  const categoryId = product?.details?.categoryId;
  let catalog = null;
  try {
    catalog = isKnownEbayCategoryId(categoryId) ? getCategoryAspectCatalog(categoryId) : null;
  } catch {
    catalog = null;
  }

  // Universal fallback priority used when the category catalog is unknown —
  // these are the aspects eBay requires across most leaf categories in DE.
  const UNIVERSAL_PRIORITY = [
    'Marke', 'Hersteller', 'Herstellernummer', 'MPN', 'Produktart',
    'Modell', 'Farbe', 'Material', 'Größe', 'Gewicht',
    'EAN', 'UPC', 'GTIN', 'ISBN',
  ];
  const priorityOrder = [
    ...(catalog?.requiredAspects || []),
    ...(catalog?.recommendedAspects || []),
    ...(catalog?.optionalAspects || []),
    ...UNIVERSAL_PRIORITY,
  ];

  // Case-insensitive lookup of attribute keys
  const attrKeyLower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const kept = [];
  const keptSet = new Set();

  for (const priorityName of priorityOrder) {
    if (kept.length >= EBAY_ASPECTS_CAP) break;
    const matchKey = attrKeyLower.get(String(priorityName).toLowerCase());
    if (matchKey && !keptSet.has(matchKey)) {
      kept.push(matchKey);
      keptSet.add(matchKey);
    }
  }

  // Fill remaining slots with the product's own keys in insertion order
  for (const k of keys) {
    if (kept.length >= EBAY_ASPECTS_CAP) break;
    if (!keptSet.has(k)) {
      kept.push(k);
      keptSet.add(k);
    }
  }

  const dropped = keys.filter((k) => !keptSet.has(k));
  const nextAttrs = {};
  for (const k of kept) nextAttrs[k] = attrs[k];
  product.details.attributes = nextAttrs;

  return { removed: dropped.length, kept: kept.length, dropped };
}

function buildProductContext(product) {
  const ident = product?.identification || {};
  const details = product?.details || {};
  const ids = details.identifiers || {};
  const lines = [];
  if (ident.name) lines.push(`Titel: ${ident.name}`);
  if (ident.brand) lines.push(`Marke: ${ident.brand}`);
  if (ident.category) lines.push(`Kategorie: ${ident.category}`);
  if (ids.ean) lines.push(`EAN: ${ids.ean}`);
  if (ids.gtin) lines.push(`GTIN: ${ids.gtin}`);
  if (ids.mpn) lines.push(`MPN: ${ids.mpn}`);
  if (details.short_description) lines.push(`Kurzbeschreibung: ${details.short_description}`);
  if (Array.isArray(details.key_features) && details.key_features.length) {
    lines.push(`Features: ${details.key_features.slice(0, 6).join('; ')}`);
  }
  return lines.join('\n');
}

async function fillAspectsViaGemini(product, missingNames, generateText) {
  if (!Array.isArray(missingNames) || !missingNames.length) return {};
  const ctx = buildProductContext(product);
  if (!ctx) return {};
  const aspectList = missingNames.map((n) => `- ${n}`).join('\n');
  const prompt = [
    'Du bist eBay-Listing-Experte. Generiere kurze, korrekte Werte für die fehlenden eBay-Pflichtmerkmale dieses Produkts.',
    '',
    'Produktinformationen:',
    ctx,
    '',
    'Fehlende Pflicht-Merkmale:',
    aspectList,
    '',
    'Antworte AUSSCHLIESSLICH mit gültigem JSON-Objekt der Form {"Merkmalname":"Wert", ...}.',
    'Werte müssen kurze Strings sein (1-3 Wörter wenn möglich), korrekt für eBay Deutschland.',
    'Wenn ein Wert nicht sinnvoll aus den Daten ableitbar ist, lass den Schlüssel weg statt zu raten.',
    'Beispiel: {"Marke":"Sony","Farbe":"Schwarz"}',
  ].join('\n');

  let raw;
  try {
    raw = await Promise.race([
      generateText(prompt, { temperature: 0.3, maxOutputTokens: ASPECT_GEMINI_MAX_TOKENS }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Gemini timeout')),
          ASPECT_GEMINI_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    return { __error: safeString(err?.message) };
  }

  const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object') return {};
    const cleaned = {};
    for (const [k, v] of Object.entries(parsed)) {
      const value = safeString(v).trim();
      if (!value || value.length > 80) continue;
      cleaned[k] = value;
    }
    return cleaned;
  } catch {
    return {};
  }
}

/**
 * Auto-fix entry-point.
 * @param {object} product   Vollständiges Produkt-Dokument (V2-Schema).
 * @param {object} opts
 * @param {Error|null} opts.lastError    Fehler von addFixedPriceItem (optional aber stark empfohlen).
 * @param {function} [opts.generateText] Override für Gemini (Tests).
 * @returns {Promise<{ product, fixes: string[], skip: boolean, reason?: string }>}
 */
async function autoFixEbayProduct(product, opts = {}) {
  if (!product || typeof product !== 'object') {
    return { product, fixes: [], skip: true, reason: 'Kein Produkt übergeben' };
  }

  const fixes = [];
  const fixed = deepClone(product);
  const lastError = opts.lastError || null;
  const errs = lastError?.details?.errors;
  const messages = getErrorMessages(lastError);
  const generateText = opts.generateText || require('../lib/gemini').generateText;

  // Strategy 1: Category mismatch → drop categoryId so eBay catalog matching kicks in.
  if (isCategoryMismatchError(errs)) {
    const had = fixed?.details?.categoryId;
    if (had) {
      if (!fixed.details) fixed.details = {};
      fixed.details.categoryId = null;
      fixes.push('Kategorie entfernt (eBay übernimmt Catalog-Matching)');
    }
  }

  // Strategy 3: Image conflict (EPS + self-managed pictures cannot be combined) →
  // drop the catalog reference so only our own pictures are sent.
  // Safety: only skip catalog if the product actually has its OWN pictures,
  // otherwise the resulting listing would be image-less which eBay rejects.
  if (isImageConflictError(errs)) {
    const ownImages = Array.isArray(fixed?.details?.images)
      ? fixed.details.images.filter((img) => {
          const url = typeof img === 'string' ? img : (img?.url_or_base64 || img?.url || '');
          return typeof url === 'string' && /^https?:\/\//i.test(url);
        })
      : [];
    if (ownImages.length > 0) {
      if (!fixed.details) fixed.details = {};
      if (!fixed.details.skipEbayCatalogLookup) {
        fixed.details.skipEbayCatalogLookup = true;
        fixes.push('Katalog-Verknüpfung entfernt (eigene Bilder behalten)');
      }
    }
    // else: skip the auto-fix; the publishing will surface the original error
    // and the user must add own pictures before retrying.
  }

  // Strategy 4: Too many item specifics (>45) → priority-trim to 45.
  if (isAspectsCapExceededError(errs)) {
    const trimmed = trimAspectsToCap(fixed);
    if (trimmed.removed > 0) {
      fixes.push(`Artikelmerkmale auf ${EBAY_ASPECTS_CAP} reduziert (Pflicht zuerst)`);
    }
  }

  // Strategy 2: Missing required aspects → collect names, ask Gemini for values.
  const fromError = extractMissingAspectNames(messages);
  const fromMisused = extractMisusedAspectNames(errs); // these are PRODUCT aspects sent as ItemSpecifics
  const categoryId = fixed?.details?.categoryId || product?.details?.categoryId;
  const fromCatalog = isKnownEbayCategoryId(categoryId)
    ? getRequiredAspects(categoryId)
    : [];

  const candidateAspects = dedupeMerge(fromError, fromCatalog);
  const attrs = getAttributesMap(fixed);
  const stillMissing = candidateAspects.filter((name) => !attributeHasValue(attrs, name));

  if (stillMissing.length === 0 && fromMisused.length === 0 && fixes.length === 0) {
    return { product: fixed, fixes, skip: true, reason: 'Keine Auto-Fix-Strategie anwendbar' };
  }

  if (stillMissing.length > 0) {
    const generated = await fillAspectsViaGemini(fixed, stillMissing, generateText);
    if (generated && !generated.__error) {
      const added = [];
      for (const [name, value] of Object.entries(generated)) {
        if (!attributeHasValue(getAttributesMap(fixed), name)) {
          setAttribute(fixed, name, value);
          added.push(name);
        }
      }
      if (added.length) {
        fixes.push(`Pflicht-Merkmale ergänzt: ${added.join(', ')}`);
      }
    }
  }

  if (fixes.length === 0) {
    return { product: fixed, fixes, skip: true, reason: 'Auto-Fix konnte keine Daten ergänzen' };
  }

  return { product: fixed, fixes, skip: false };
}

module.exports = {
  autoFixEbayProduct,
  extractMissingAspectNames,
};
