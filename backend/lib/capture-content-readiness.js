'use strict';

const { evaluateEbayReady } = require('./datasheet-quality');
const { normalizeHighlightsStrict } = require('./highlights-policy');
const { coerceTitleToPolicy, getTitleRequiredTokens } = require('./title-policy');
const { sanitizeDescriptionProse } = require('./listing-sanitize');
const { sanitizeCaptureGpsr } = require('./capture-content-contract');
const { isNonEuManufacturer } = require('./gpsr-eu-rep');

function isKnownValue(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !/^(unbekannt|unknown|n\/?a|k\.?\s?a\.?|keine angabe|nicht bekannt|nicht zutreffend)$/i.test(text);
}

// Use the same canonical field names and policies as the persisted datasheet.
// A write-tool call is a draft: its mere presence is not proof of completeness.
function evaluateCaptureContent(content = {}, context = {}) {
  const { identity = {}, enrichment = {}, imageParts = [] } = context;
  const attributes = Object.fromEntries((content.item_specifics || [])
    .filter(row => row?.key && isKnownValue(row.value)).map(row => [row.key, row.value]));
  if (isKnownValue(identity.brand) && !attributes.Marke) attributes.Marke = identity.brand;
  if (isKnownValue(identity.model) && !attributes.Modell) attributes.Modell = identity.model;
  if (isKnownValue(identity.color) && !attributes.Farbe) attributes.Farbe = identity.color;
  const product = {
    identification: { name: content.title_ebay || '', brand: identity.brand || '',
      category: enrichment.category?.ebayBreadcrumb || identity.internalCategory || '' },
    details: {
      short_description: sanitizeDescriptionProse(content.description_ebay || ''),
      attributes, categoryId: enrichment.category?.ebayId || '',
      images: imageParts.filter(image => image?.data).map(() => ({ url_or_base64: 'capture-input' })),
    },
  };
  const normalizedTitle = coerceTitleToPolicy(product, product.identification.name);
  product.identification.name = normalizedTitle;
  const highlights = normalizeHighlightsStrict(product, content.key_features || []);
  product.details.key_features = highlights.highlights;
  const quality = evaluateEbayReady(product, { force: true, ignorePrice: true });
  const issues = [...quality.issues];
  const keys = new Map(Object.entries(attributes).map(([key, value]) => [key.trim().toLowerCase(), value]));
  for (const aspect of enrichment.requiredAspects || []) {
    const name = typeof aspect === 'string' ? aspect : aspect?.name || aspect?.localizedName;
    if (name && !isKnownValue(keys.get(name.trim().toLowerCase()))) issues.push(`missing_required_aspect:${name}`);
  }
  if (!String(content.title_kaufland || '').trim()) issues.push('kaufland_title_missing');
  if (String(content.description_kaufland || '').length < 260) issues.push('kaufland_description_too_short');

  // Do not build a fictitious legal entity by mixing independently researched
  // addresses. The generation loop must resolve a complete manufacturer record.
  const gpsr = sanitizeCaptureGpsr(content.gpsr);
  if (!isKnownValue(gpsr.manufacturer_name || content.gpsr_manufacturer_name)) issues.push('gpsr_manufacturer_name_missing');
  if (!isKnownValue(gpsr.manufacturer_address) || !isKnownValue(gpsr.manufacturer_city) ||
      !isKnownValue(gpsr.manufacturer_postalcode) || !isKnownValue(gpsr.entity_country || gpsr.country_code)) {
    issues.push('gpsr_manufacturer_address_missing');
  }
  if (!isKnownValue(gpsr.email) && !isKnownValue(gpsr.url)) issues.push('gpsr_manufacturer_contact_missing');
  if (isNonEuManufacturer(gpsr) && (!isKnownValue(gpsr.eu_responsible_name) ||
      !isKnownValue(gpsr.eu_responsible_address) || !isKnownValue(gpsr.eu_responsible_city) ||
      !isKnownValue(gpsr.eu_responsible_country || gpsr.eu_responsible_country_code) ||
      !isKnownValue(gpsr.eu_responsible_email))) issues.push('gpsr_eu_responsible_missing');

  return { ok: issues.length === 0, issues: [...new Set(issues)],
    titleRequirements: getTitleRequiredTokens(product),
    titleSuggestion: coerceTitleToPolicy(product, normalizedTitle, { forcePolicy: true }),
    normalizedTitle, normalizedHighlights: highlights.highlights };
}

module.exports = { evaluateCaptureContent, isKnownValue };
