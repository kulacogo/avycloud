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
 * @param {object} product
 * @param {object} [opts]
 * @param {string[]} [opts.missingAttributes=[]]       — from product-data/status
 * @param {string[]} [opts.minOneMissingAttributes=[]] — from product-data/status
 * @returns {object} attributes ready for putProductData/patchProductData.
 */
function buildKauflandProductDataAttributes(product, { missingAttributes = [], minOneMissingAttributes = [] } = {}) {
  const attributes = {};

  const title = safeString(product?.identification?.name).replace(/\s+/g, ' ').trim();
  if (title) attributes.title = [title.slice(0, 250)];

  const descriptionRaw = safeString(product?.details?.short_description || product?.details?.description);
  const description = stripHtmlToPlainText(descriptionRaw);
  if (description) attributes.description = [description.slice(0, 4000)];

  const pictureUrls = Array.from(
    new Set(
      (Array.isArray(product?.details?.images) ? product.details.images : [])
        .map((entry) => pickImageUrl(entry))
        .filter((url) => /^https?:\/\//i.test(url))
    )
  );
  if (pictureUrls.length) attributes.picture = pictureUrls.slice(0, 20);

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
  if (brand) attributes.manufacturer = [brand];
  const complianceContact = buildKauflandComplianceContact(product, brand);
  if (complianceContact) attributes.product_safety_contact = complianceContact;

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
    if ((requiredToken === 'hersteller' || requiredToken.includes('manufacturer')) && brand) {
      attributes[requiredName] = [brand];
      return;
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

  const attributes = buildKauflandProductDataAttributes(product, {
    missingAttributes: statusBefore?.missing_attributes || [],
    minOneMissingAttributes: statusBefore?.min_one_missing_attributes || [],
  });
  const patchedKeys = Object.keys(attributes);
  if (!patchedKeys.length) {
    return {
      attempted: false,
      patchedKeys,
      message: 'Keine geeigneten Product-Data-Felder aus dem Datensatz ableitbar.',
    };
  }

  let writeMode = 'patch';
  await patchProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes });

  let storedProductData = null;
  let storedProductDataError = '';
  try {
    storedProductData = await getProductData(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    storedProductDataError = Number(error?.status) === 404 ? 'product-data=404 nach PATCH' : safeString(error?.message);
  }
  if (!storedProductData) {
    writeMode = 'patch+put';
    await putProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes });
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
};
