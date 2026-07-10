'use strict';

/**
 * Kaufland-Product-Data-Repair — extrahiert aus admin-bulk-actions.js
 * (vormals Z. 1836 / 1859 / 2002).
 *
 * Repariert Kaufland-Listings die mit `incomplete-product`,
 * `missing_attributes` oder `min_one_missing_attributes` rejected wurden,
 * indem die fehlenden Attribute aus dem internen products_v2-Datensatz
 * (`details.attributes`, `details.attributes_extra`, `details.gpsr.*`)
 * abgeleitet und per Kaufland Product-Data API (`patch` + ggf. `put`)
 * nachgereicht werden.
 *
 * Reine extraktion — Verhalten unverändert. admin-bulk-actions.js requiret
 * jetzt diese Datei statt die Funktionen lokal zu definieren.
 *
 * Pure-functions (`buildKauflandProductDataAttributes`,
 * `buildKauflandComplianceContact`) lassen sich auch ohne Kaufland-API-Mock
 * testen. Der Wrapper `capKauflandAttributes` ist additiv, optional, und
 * lässt sich vom Bulk-Publisher nutzen um Kaufland-spezifische Aspect-Caps
 * zu erzwingen (Default 45, gespiegelt zu eBay).
 */

const {
  getProductData,
  getProductDataStatus,
  putProductData,
  patchProductData,
} = require('../lib/kaufland-api');
const { enforceAspectCap } = require('../lib/aspect-cap-enforcer');
// Lazy-require kaufland-manufacturer-whitelist to avoid pulling firestore into
// pure-function test paths that only exercise buildKauflandComplianceContact.
// The require happens inside buildKauflandProductDataAttributes.

// ─── Local helpers (mirror of admin-bulk-actions.js helpers) ──────────────

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function stripHtmlToPlainText(input) {
  const raw = safeString(input);
  if (!raw) return '';
  return raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKauflandAttributeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

const KAUFLAND_COUNTRY_CODE_FALLBACK = {
  germany: 'DE',
  deutschland: 'DE',
  austria: 'AT',
  osterreich: 'AT',
  'österreich': 'AT',
  poland: 'PL',
  polen: 'PL',
  france: 'FR',
  frankreich: 'FR',
  italy: 'IT',
  italien: 'IT',
  czechia: 'CZ',
  'czech republic': 'CZ',
  tschechien: 'CZ',
  slovakia: 'SK',
  slowakei: 'SK',
};

function normalizeKauflandCountryCode(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const compact = raw.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (/^[A-Z]{2}$/.test(compact)) return compact;
  const token = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return KAUFLAND_COUNTRY_CODE_FALLBACK[token] || '';
}

function normalizeKauflandAttributeValues(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => {
      if (entry == null) return [];
      if (typeof entry === 'object' && !Array.isArray(entry)) return [];
      const text = safeString(entry);
      if (!text) return [];
      if (typeof entry === 'string' && text.includes('|')) {
        return text
          .split('|')
          .map((part) => safeString(part))
          .filter(Boolean);
      }
      return [text];
    })
    .filter(Boolean)
    .slice(0, 25);
}

function pickImageUrl(entry) {
  if (typeof entry === 'string') return safeString(entry);
  if (!entry || typeof entry !== 'object') return '';
  return safeString(entry?.url_or_base64 || entry?.url || entry?.src || entry?.link);
}

// Kaufland fetcht jede picture-URL serverseitig als Mediendatei. Landet eine
// HTML-Produktseite in der Liste (Live-Beweis 2026-07-10, EAN 4036231080920:
// "https://www.fritz-berger.de/artikel/...?srsltid=...#thumbnail-modal"),
// DECLINED Kaufland ALLE picture-Werte mit media_not_ready_yet und der
// Datensatz hängt dauerhaft in "Angebotsdaten fehlen" (missing "Bild").
// Deshalb: nur Einträge durchlassen, die plausibel ein Bild sind — entweder
// per deklariertem image/*-mimeType oder per Bild-Extension im URL-Pfad
// (Query-String und Fragment zählen NICHT als Pfad).
const IMAGE_URL_EXTENSION_RX = /\.(jpg|jpeg|png|gif|webp|avif|bmp|tiff)$/;

function isLikelyImageUrl(entry) {
  const url = pickImageUrl(entry);
  if (!url) return false;
  const mimeType = entry && typeof entry === 'object' ? safeString(entry.mimeType) : '';
  if (/^image\//i.test(mimeType)) return true;
  try {
    // URL.pathname schneidet Query + Fragment ab — genau die Teile, hinter
    // denen sich Nicht-Bild-URLs als "Bild" tarnen (#thumbnail-modal etc.).
    const { pathname } = new URL(url);
    return IMAGE_URL_EXTENSION_RX.test(String(pathname || '').toLowerCase());
  } catch (parseErr) {
    // Nicht parsebar (relative Pfade, kaputte Strings, raw base64) → nie an
    // Kaufland weiterreichen.
    return false;
  }
}

// Kaufland requires a real fabric/material NAME for "Materialzusammensetzung"
// (technical key material_composition), the #1 attribute still missing on
// freshly-listed textiles (verified live 2026-05-24). Our internal data
// fragments this across inconsistent keys: "Materialzusammensetzung" sometimes
// holds only a bare percentage ("80%", "100%") while the actual fabric sits
// under "Material" / "Hauptmaterial" / "Außenmaterial". A bare percentage is
// rejected by Kaufland (reason: invalid_value).
//
// This scans candidate keys across both attribute pools and returns the best
// value that actually contains a fabric NAME (>=3 consecutive letters),
// preferring values that ALSO carry percentages (more complete composition).
// Returns '' if no usable fabric name exists anywhere.
function buildKauflandMaterialComposition(pools) {
  const FABRIC_NAME_RX = /[A-Za-zÄÖÜäöüß]{3,}/;
  // Priority order: explicit composition field first, then generic material,
  // then weave/fabric-type fallbacks.
  const CANDIDATE_TOKENS = [
    'materialzusammensetzung', 'materialcomposition',
    'material', 'hauptmaterial', 'aussenmaterial', 'obermaterial',
    'gewebeart', 'stoffart', 'gewebe', 'textil',
  ];
  const found = [];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object' || Array.isArray(pool)) continue;
    for (const [rawKey, rawValue] of Object.entries(pool)) {
      const token = normalizeKauflandAttributeToken(rawKey);
      const priority = CANDIDATE_TOKENS.indexOf(token);
      if (priority === -1) continue;
      for (const v of normalizeKauflandAttributeValues(rawValue)) {
        if (FABRIC_NAME_RX.test(v)) {
          found.push({ value: v.slice(0, 200), priority, hasPercent: /%/.test(v) });
        }
      }
    }
  }
  if (!found.length) return '';
  // A composition WITH percentages is more complete; within that, lower
  // priority index (more authoritative key) wins.
  found.sort((a, b) => {
    if (a.hasPercent !== b.hasPercent) return a.hasPercent ? -1 : 1;
    return a.priority - b.priority;
  });
  return found[0].value;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the GPSR `product_safety_contact` block from `product.details.gpsr.*`.
 * Returns `null` if either name OR full address is missing — Kaufland requires
 * both for the compliance contact to be considered complete.
 *
 * @param {object} product
 * @param {string} [fallbackName=''] — usually the brand name; used when gpsr.manufacturer_name is empty.
 * @returns {null | { name, address, email_address?, url?, phone_number? }}
 */
function buildKauflandComplianceContact(product, fallbackName = '') {
  const gpsr = product?.details?.gpsr && typeof product.details.gpsr === 'object' ? product.details.gpsr : {};
  const { buildKauflandContactFromGpsr, isNonEuManufacturer, hasEuRepFields } = require('../lib/gpsr-eu-rep');

  if (isNonEuManufacturer(gpsr) || hasEuRepFields(gpsr)) {
    const euContact = buildKauflandContactFromGpsr(gpsr);
    if (euContact) return euContact;
  }

  const name = safeString(gpsr?.manufacturer_name || fallbackName).replace(/\s+/g, ' ').trim();
  const countryCode = normalizeKauflandCountryCode(gpsr?.country_code || gpsr?.entity_country);
  const addressParts = [
    safeString(gpsr?.manufacturer_address),
    safeString(gpsr?.manufacturer_city),
    safeString(gpsr?.manufacturer_postalcode),
    countryCode,
  ].filter(Boolean);
  const address = addressParts.join(', ');
  if (!name || !address) return null;

  const contact = { name, address };
  const email = safeString(gpsr?.email);
  const url = safeString(gpsr?.url);
  const phone = safeString(gpsr?.manufacturer_phone);
  if (email) contact.email_address = email;
  if (url) contact.url = url;
  if (phone) contact.phone_number = phone;
  return contact;
}

/**
 * Build the full attributes object Kaufland expects, drawing from
 * `product.details.attributes`, `.attributes_extra` and `.gpsr.*`.
 *
 * Async since 2026-05 because we resolve the `manufacturer` attribute against
 * Kaufland's controlled whitelist (attribute id=21). Match-logic prefers the
 * exact Kaufland-side label (e.g. "Brax" instead of "BRAX") so the validator
 * does not reject with `not_manufacturer_name, invalid_value`.
 *
 * Whitelist-lookup failure is non-fatal — falls through to legacy behavior
 * (legal-entity > brand) on any error.
 *
 * @param {object} product
 * @param {object} [opts]
 * @param {string[]} [opts.missingAttributes=[]]       — from product-data/status
 * @param {string[]} [opts.minOneMissingAttributes=[]] — from product-data/status
 * @param {string}   [opts.storefront='de']            — Kaufland storefront for whitelist lookup
 * @returns {Promise<object>} attributes ready for putProductData/patchProductData.
 */
async function buildKauflandProductDataAttributes(product, { missingAttributes = [], minOneMissingAttributes = [], storefront = 'de' } = {}) {
  const attributes = {};

  // Kaufland DE-Storefront-Validator (May 2026): die englischen Standard-keys
  // (title/description/picture/manufacturer) werden zwar gespeichert aber NICHT
  // für Validation gezählt. Deutsche Storefront erfordert die DEUTSCHEN keys
  // (Titel/Beschreibung/Bild/Hersteller). Wir senden BEIDE damit es egal ist.
  // Beispiel-Beweis: putProductData mit nur englischem "title" → Kaufland
  // antwortet missing_attributes:["Titel"] obwohl title-key gespeichert ist.
  const isGermanStorefront = String(storefront || '').toLowerCase() === 'de';

  const title = safeString(product?.identification?.name).replace(/\s+/g, ' ').trim();
  if (title) {
    const trimmed = title.slice(0, 250);
    attributes.title = [trimmed];
    if (isGermanStorefront) attributes.Titel = [trimmed];
  }

  const descriptionRaw = safeString(product?.details?.short_description || product?.details?.description);
  const description = stripHtmlToPlainText(descriptionRaw);
  if (description) {
    const trimmed = description.slice(0, 4000);
    attributes.description = [trimmed];
    if (isGermanStorefront) attributes.Beschreibung = [trimmed];
  }

  const pictureUrls = Array.from(
    new Set(
      (Array.isArray(product?.details?.images) ? product.details.images : [])
        .filter((entry) => isLikelyImageUrl(entry))
        .map((entry) => pickImageUrl(entry))
        .filter((url) => /^https?:\/\//i.test(url))
    )
  );
  if (pictureUrls.length) {
    const trimmed = pictureUrls.slice(0, 20);
    attributes.picture = trimmed;
    if (isGermanStorefront) attributes.Bild = trimmed;
  }

  const attrsPrimary =
    product?.details?.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes)
      ? product.details.attributes
      : {};
  const attrsExtra =
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object' && !Array.isArray(product.details.attributes_extra)
      ? product.details.attributes_extra
      : {};
  const pickFromAttrsByNeedle = (...needles) => {
    const wanted = new Set(needles.map((n) => normalizeKauflandAttributeToken(n)).filter(Boolean));
    const pools = [attrsPrimary, attrsExtra];
    for (const pool of pools) {
      for (const [key, raw] of Object.entries(pool)) {
        const token = normalizeKauflandAttributeToken(key);
        if (!wanted.has(token)) continue;
        const values = normalizeKauflandAttributeValues(raw);
        if (values.length) return values[0];
      }
    }
    return '';
  };

  const brand = safeString(
    product?.identification?.brand ||
      product?.details?.identifiers?.brand ||
      pickFromAttrsByNeedle('marke', 'brand', 'hersteller')
  );

  // ── Manufacturer-Picker: Whitelist-Lookup > Legal Entity > Brand ────────
  // Kaufland's Validator declined pure brand names with hint:
  // "not_manufacturer_name, reason: invalid_value" — sie haben eine
  // kontrollierte Whitelist (attribute id=21). Bei Mismatch (Case, Variante,
  // unregistriert) wird der ganze Push als incomplete-product abgewiesen.
  //
  // Strategie (additiv, fail-safe):
  //   1. Wenn GPSR-Legal-Entity vorhanden ist → in Whitelist suchen
  //      (manche Hersteller registrieren ihren legalen Namen, nicht den Brand).
  //   2. Sonst (oder bei Miss) → brand in Whitelist suchen.
  //   3. Bei exact-match: Kauflands EXAKTEN Wert nehmen (z.B. "Brax", nicht "BRAX").
  //   4. Bei keinem Match: legacy Verhalten (legal-entity > brand) bleibt
  //      bestehen → Push schlägt zwar mglw. fehl, aber wir blockieren ihn
  //      nicht artifiziell (Whitelist-API könnte down sein).
  //
  // Whitelist-API-Failure ist NIE blockierend — silently fall back.
  const gpsrEntityName = safeString(product?.details?.gpsr?.manufacturer_name);
  const LEGAL_ENTITY_RX = /\b(GmbH|AG|Inc\.?|Ltd\.?|LLC|S\.?p\.?A\.?|B\.?V\.?|S\.?A\.?S?|SE|S\.?r\.?l\.?|Limited|Co\.,?\s*Ltd|Co\.\s*KG|OHG|KG|UG)\b/i;
  const gpsrHasLegalSuffix = gpsrEntityName && LEGAL_ENTITY_RX.test(gpsrEntityName);
  const legacyManufacturerName = gpsrHasLegalSuffix ? gpsrEntityName : brand;

  let kauflandManufacturerLabel = null;
  let manufacturerOperatorNote = null;
  let whitelistLookup = { findManufacturerInWhitelist: null };
  try {
    // Lazy-require so pure-function tests of this module don't need a firestore mock.
    whitelistLookup = require('../lib/kaufland-manufacturer-whitelist');
  } catch (requireErr) {
    // Module unavailable (shouldn't happen in normal builds) — skip lookup.
    whitelistLookup = { findManufacturerInWhitelist: null };
  }
  const lookupWhitelist = whitelistLookup?.findManufacturerInWhitelist;

  if (typeof lookupWhitelist === 'function') {
    // Attempt 1: legal-entity in whitelist.
    if (gpsrHasLegalSuffix && gpsrEntityName) {
      try {
        const r = await lookupWhitelist(gpsrEntityName, { storefront });
        if (r && r.exactMatch && r.label) {
          kauflandManufacturerLabel = r.label;
        }
      } catch (whitelistErr) {
        console.warn(
          `[kaufland-product-data-repair] manufacturer whitelist lookup (legal-entity="${gpsrEntityName}") failed: ${safeString(whitelistErr?.message)}`
        );
      }
    }
    // Attempt 2: brand in whitelist (fallback).
    if (!kauflandManufacturerLabel && brand) {
      try {
        const r = await lookupWhitelist(brand, { storefront });
        if (r && r.exactMatch && r.label) {
          kauflandManufacturerLabel = r.label; // Kauflands exakter Wert (Case-preserving)
        } else if (r && !r.found && r.source !== 'error') {
          manufacturerOperatorNote =
            `Brand "${brand}" nicht in Kaufland-Whitelist (hits=${r.total}). ` +
            'Registrieren via Kaufland Kontaktformular/Hersteller-Anfrage.';
        }
      } catch (whitelistErr) {
        console.warn(
          `[kaufland-product-data-repair] manufacturer whitelist lookup (brand="${brand}") failed: ${safeString(whitelistErr?.message)}`
        );
      }
    }
  }

  if (manufacturerOperatorNote) {
    const sku = safeString(product?.identification?.sku || product?.details?.identifiers?.sku || product?.id);
    console.warn(`[kaufland-product-data-repair] sku=${sku} brand="${brand}" ${manufacturerOperatorNote}`);
  }

  // Final manufacturer value: whitelist-label > legal-entity > brand.
  const manufacturerName = kauflandManufacturerLabel || legacyManufacturerName;
  if (manufacturerName) {
    attributes.manufacturer = [manufacturerName];
    // DE-Storefront erfordert "Hersteller"-Key zusätzlich (siehe Doppelschreibung
    // bei title/description/picture oben). Sonst missing_attributes:["Hersteller"]
    // obwohl manufacturer-Key gespeichert wurde.
    if (isGermanStorefront) attributes.Hersteller = [manufacturerName];
  }

  const complianceContact = buildKauflandComplianceContact(product, brand);
  if (complianceContact) attributes.product_safety_contact = complianceContact;

  // Material composition — CORE phase (always send if derivable), because it is
  // the #1 attribute that keeps freshly-listed textiles non-buyable. The
  // missing-backfill phase below alone is not enough: on initial listing the
  // `missing` list is empty, so without this the field would never be sent.
  const materialComposition = buildKauflandMaterialComposition([attrsPrimary, attrsExtra]);
  if (materialComposition) {
    attributes.material_composition = [materialComposition];
    if (isGermanStorefront) attributes.Materialzusammensetzung = [materialComposition];
  }

  const missing = Array.from(
    new Set(
      [...(Array.isArray(missingAttributes) ? missingAttributes : []), ...(Array.isArray(minOneMissingAttributes) ? minOneMissingAttributes : [])]
        .map((x) => safeString(x))
        .filter(Boolean)
    )
  );
  if (!missing.length) return attributes;

  const sourceMaps = [
    product?.details?.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes)
      ? product.details.attributes
      : {},
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object' && !Array.isArray(product.details.attributes_extra)
      ? product.details.attributes_extra
      : {},
  ];
  const sourceByToken = new Map();
  sourceMaps.forEach((source) => {
    Object.entries(source).forEach(([rawKey, rawValue]) => {
      const token = normalizeKauflandAttributeToken(rawKey);
      if (!token || sourceByToken.has(token)) return;
      sourceByToken.set(token, rawValue);
    });
  });

  missing.forEach((requiredName) => {
    const requiredToken = normalizeKauflandAttributeToken(requiredName);
    if (!requiredToken) return;
    const alreadyPresent = Object.keys(attributes).some(
      (key) => normalizeKauflandAttributeToken(key) === requiredToken
    );
    if (alreadyPresent) return;

    const isComplianceContactToken =
      requiredToken.includes('productsafetycontact') ||
      requiredToken.includes('compliancecontact') ||
      (requiredToken.includes('herstellername') && requiredToken.includes('verantwortlicheperson')) ||
      (requiredToken.includes('manufacturername') && requiredToken.includes('responsibleperson'));
    if (isComplianceContactToken) {
      if (complianceContact) {
        attributes[requiredName] = complianceContact;
        return;
      }
      const fallbackName = safeString(product?.details?.gpsr?.manufacturer_name || brand);
      if (fallbackName) {
        attributes[requiredName] = [fallbackName];
        return;
      }
    }

    if ((requiredToken.includes('titel') || requiredToken.includes('title')) && title) {
      attributes[requiredName] = [title.slice(0, 250)];
      return;
    }
    if ((requiredToken.includes('beschreibung') || requiredToken.includes('description')) && description) {
      attributes[requiredName] = [description.slice(0, 4000)];
      return;
    }
    if ((requiredToken.includes('bild') || requiredToken.includes('picture')) && pictureUrls.length) {
      attributes[requiredName] = pictureUrls.slice(0, 20);
      return;
    }
    if ((requiredToken === 'hersteller' || requiredToken.includes('manufacturer'))) {
      // Bevorzuge whitelist-label > legal-entity-name > brand.
      // Kaufland-Validator declined pure Brand-Strings als manufacturer.
      const candidate = kauflandManufacturerLabel || legacyManufacturerName || brand;
      if (candidate) {
        attributes[requiredName] = [candidate];
        return;
      }
    }

    const rawValue = sourceByToken.get(requiredToken);
    if (isComplianceContactToken && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const fromSource = {
        name: safeString(rawValue?.name || rawValue?.manufacturer_name || rawValue?.herstellername),
        address: safeString(rawValue?.address || rawValue?.manufacturer_address || rawValue?.anschrift),
        email_address: safeString(rawValue?.email_address || rawValue?.email || rawValue?.e_mail),
        url: safeString(rawValue?.url || rawValue?.website || rawValue?.kontaktseite),
        phone_number: safeString(rawValue?.phone_number || rawValue?.phone || rawValue?.telefon),
      };
      if (fromSource.name && fromSource.address) {
        if (!fromSource.email_address) delete fromSource.email_address;
        if (!fromSource.url) delete fromSource.url;
        if (!fromSource.phone_number) delete fromSource.phone_number;
        attributes[requiredName] = fromSource;
        return;
      }
    }

    const values = normalizeKauflandAttributeValues(rawValue);
    if (values.length) attributes[requiredName] = values;
  });

  return attributes;
}

/**
 * Try to repair Kaufland's missing_attributes / min_one_missing_attributes /
 * incomplete-product state by patching product-data with attributes derived
 * from the internal product. May fall back from PATCH to PUT if PATCH did
 * not produce a stored snapshot.
 *
 * NOTE: signature here is the same as in admin-bulk-actions.js. The
 * `idUnit`/`storefront` parameters are not used by the repair itself today
 * — they're part of the agreed contract so the audit layer can persist a
 * compact reference back to the audit doc.
 *
 * @param {object} opts
 * @param {object} opts.product
 * @param {string} opts.ean
 * @param {string|number|null} [opts.idUnit=null]
 * @param {string} [opts.storefront='de']
 * @param {string} [opts.locale='de-DE']
 * @returns {Promise<{ attempted: boolean, patchedKeys: string[], message: string }>}
 */
async function tryRepairKauflandProductData({
  product,
  ean,
  // idUnit and storefront accepted for contract symmetry, currently informational.
  // eslint-disable-next-line no-unused-vars
  idUnit = null,
  // eslint-disable-next-line no-unused-vars
  storefront = 'de',
  locale = 'de-DE',
} = {}) {
  const normalizedEan = safeString(ean).replace(/\D+/g, '');
  if (!normalizedEan) {
    return { attempted: false, patchedKeys: [], message: 'EAN fehlt – Product-Data-Reparatur übersprungen.' };
  }

  const normalizedLocale = safeString(locale) || 'de-DE';
  let statusBefore = null;
  let statusBeforeError = '';
  try {
    statusBefore = await getProductDataStatus(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    statusBeforeError = Number(error?.status) === 404 ? 'product-data/status=404 (noch kein Datensatz)' : safeString(error?.message);
  }
  let productDataBefore = null;
  let productDataBeforeError = '';
  try {
    productDataBefore = await getProductData(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    productDataBeforeError = Number(error?.status) === 404 ? 'product-data=404' : safeString(error?.message);
  }

  const attributes = await buildKauflandProductDataAttributes(product, {
    missingAttributes: statusBefore?.missing_attributes || [],
    minOneMissingAttributes: statusBefore?.min_one_missing_attributes || [],
    storefront: safeString(storefront) || 'de',
  });
  const patchedKeys = Object.keys(attributes);
  if (!patchedKeys.length) {
    return {
      attempted: false,
      patchedKeys,
      message: 'Keine geeigneten Product-Data-Felder aus dem Datensatz ableitbar.',
    };
  }

  // Predict id_category for repair targets that are still sitting in the
  // 46001 "Sonstiges-Sonstiges" stub bucket — without this hint Kaufland
  // validates against an empty schema and leaves attribute_values=[] even
  // after our PATCH/PUT. See kaufland-api.js putProductData() comment for
  // the underlying mechanism. We skip prediction when the status response
  // confirms a non-stub id_product is bound (existing real catalog).
  let predictedIdCategory = 0;
  const { getProductByEan, decideCategory } = require('../lib/kaufland-api');
  try {
    const cat = await getProductByEan(normalizedEan, { storefront: safeString(storefront) || 'de' });
    const catIdCategory = Number(cat?.id_category || 0);
    const catIsValid = !!cat?.is_valid;
    const isStub = !cat?.id_product || catIdCategory === 46001 || !catIsValid;
    if (isStub && attributes.title?.[0] && attributes.description?.[0] && attributes.manufacturer?.[0]) {
      const priceCents = (() => {
        const raw = product?.details?.pricing?.sellPrice
          ?? product?.pricing?.kaufland?.price
          ?? product?.pricing?.sellPrice
          ?? product?.details?.pricing?.amount;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 1000;
      })();
      const sug = await decideCategory({
        title: attributes.title[0],
        description: attributes.description[0],
        manufacturer: attributes.manufacturer[0],
        priceCents,
        storefront: safeString(storefront) || 'de',
        locale: normalizedLocale,
      });
      const top = sug.find((s) => s.is_leaf && s.id_category && s.id_category !== 46001);
      if (top) predictedIdCategory = top.id_category;
    }
  } catch (catErr) {
    // non-fatal — we proceed without the hint
    void catErr;
  }

  let writeMode = 'patch';
  await patchProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes, idCategory: predictedIdCategory || undefined });

  let storedProductData = null;
  let storedProductDataError = '';
  try {
    storedProductData = await getProductData(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    storedProductDataError = Number(error?.status) === 404 ? 'product-data=404 nach PATCH' : safeString(error?.message);
  }
  if (!storedProductData) {
    writeMode = 'patch+put';
    await putProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes, idCategory: predictedIdCategory || undefined });
    try {
      storedProductData = await getProductData(normalizedEan, { locale: normalizedLocale });
      storedProductDataError = '';
    } catch (error) {
      storedProductDataError = Number(error?.status) === 404 ? 'product-data=404 nach PUT' : safeString(error?.message);
    }
  }

  // Product-data processing may be async. Poll once shortly for a fresher status snapshot.
  await wait(900);
  let statusAfter = null;
  let statusAfterError = '';
  try {
    statusAfter = await getProductDataStatus(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    statusAfterError = Number(error?.status) === 404 ? 'product-data/status=404' : safeString(error?.message);
  }

  const beforeSummary = statusBefore
    ? `vorher: ready=${String(statusBefore?.product_ready)}, update=${safeString(statusBefore?.update_status) || 'unknown'}`
    : statusBeforeError
      ? `vorher: ${statusBeforeError}`
      : 'vorher: unbekannt';
  const beforeStorageSummary = productDataBefore
    ? `speicher vorher: keys=${Object.keys(productDataBefore?.attributes || {}).join(', ') || 'keine'}`
    : productDataBeforeError
      ? `speicher vorher: ${productDataBeforeError}`
      : 'speicher vorher: unbekannt';
  const storageSummary = storedProductData
    ? `speicher nachher: keys=${Object.keys(storedProductData?.attributes || {}).join(', ') || 'keine'}`
    : storedProductDataError
      ? `speicher nachher: ${storedProductDataError}`
      : 'speicher nachher: unbekannt';
  const afterSummary = statusAfter
    ? `nachher: ready=${String(statusAfter?.product_ready)}, update=${safeString(statusAfter?.update_status) || 'unknown'}`
    : statusAfterError
      ? `nachher: ${statusAfterError}`
      : 'nachher: unbekannt';

  return {
    attempted: true,
    patchedKeys,
    message: `Product-Data via ${writeMode} aktualisiert (${patchedKeys.join(', ')}). ${beforeStorageSummary}; ${storageSummary}; ${beforeSummary}; ${afterSummary}`,
  };
}

/**
 * Optional Kaufland-side aspect cap helper. Wraps `enforceAspectCap` so the
 * bulk publisher (or Agent B) can drop excess attributes deterministically
 * before submission. Pure function, no IO.
 *
 * @param {object|Array} attrs — Kaufland attributes record or array
 * @param {number} [max=45]
 * @returns {{ trimmed: object, removed: Array<{key,value}>, meta: object }}
 */
function capKauflandAttributes(attrs, max = 45) {
  // enforceAspectCap accepts either an object (key→value) or array;
  // it returns a normalised array. We re-shape back into an object record
  // so callers can drop the result straight into kaufland-api putProductData.
  const { trimmed, removed, meta } = enforceAspectCap(attrs, { maxCap: max });
  const out = {};
  for (const item of trimmed) {
    if (!item || !item.key) continue;
    out[item.key] = item.value;
  }
  return { trimmed: out, removed, meta };
}

module.exports = {
  tryRepairKauflandProductData,
  buildKauflandProductDataAttributes,
  buildKauflandComplianceContact,
  capKauflandAttributes,
  isLikelyImageUrl,
};
