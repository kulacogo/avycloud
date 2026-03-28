'use strict';

/**
 * AI Listing Pipeline — Orchestrates per-channel listing optimization.
 *
 * Generates marketplace-optimized titles and descriptions for eBay and Kaufland
 * by calling Gemini with product data, then validates listings against marketplace
 * requirements.
 *
 * This service ONLY reads existing services — it does NOT modify them.
 */

const { getProductV2 } = require('../lib/product-store');
const { callGeminiStructured } = require('../lib/gemini-structured');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { sanitizeDescriptionToHtml } = require('../lib/listing-sanitize');
const { applyEbayTaxonomy, applyKauflandTaxonomy } = require('./enrichment');

// ─── Constants ─────────────────────────────────────────────────────────────────

const EBAY_TITLE_MAX = 80;
const KAUFLAND_TITLE_MAX = 150;
const SUPPORTED_CHANNELS = ['ebay', 'kaufland'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function safeStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function buildProductContext(product) {
  const id = product.identification || {};
  const det = product.details || {};
  const attrs = det.attributes || {};
  const ids = det.identifiers || {};
  const pricing = det.pricing || {};

  const parts = [];
  if (id.brand) parts.push(`Brand: ${id.brand}`);
  if (id.name) parts.push(`Product: ${id.name}`);
  if (id.category) parts.push(`Category: ${id.category}`);
  if (ids.ean) parts.push(`EAN: ${Array.isArray(ids.ean) ? ids.ean[0] : ids.ean}`);
  if (ids.mpn) parts.push(`MPN: ${ids.mpn}`);
  if (attrs.condition) parts.push(`Condition: ${attrs.condition}`);
  if (det.short_description) parts.push(`Description: ${det.short_description}`);

  // Include key attributes
  const skipKeys = new Set(['condition', 'ebay_category_id', 'kaufland_category_id']);
  for (const [k, v] of Object.entries(attrs)) {
    if (skipKeys.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && v.trim()) {
      parts.push(`${k}: ${v}`);
    }
  }

  if (pricing.sellPrice) parts.push(`Price: ${pricing.sellPrice} EUR`);

  return parts.join('\n');
}

// ─── Gemini Listing Generation ─────────────────────────────────────────────────

const LISTING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ebay: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'description'],
    },
    kaufland: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'description'],
    },
  },
  required: ['ebay', 'kaufland'],
};

async function generateListingsViaGemini(product, channels) {
  const context = buildProductContext(product);

  const prompt = `Du bist ein erfahrener E-Commerce-Listing-Optimierer für den deutschen Markt (DACH).

Erstelle optimierte Listings für die folgenden Marktplätze basierend auf den Produktdaten.

PRODUKTDATEN:
${context}

REGELN:
- eBay Titel: Max ${EBAY_TITLE_MAX} Zeichen, SEO-optimiert, Marke + Modell + Zustand + wichtige Merkmale
- eBay Beschreibung: Professionelle HTML-Beschreibung mit <p>, <ul>, <li> Tags. Verkaufsfördernde Sprache. Keine Preisangaben im Text.
- Kaufland Titel: Max ${KAUFLAND_TITLE_MAX} Zeichen, klar und informativ, Marke + Modell + wichtige Merkmale
- Kaufland Beschreibung: Sachliche Produktbeschreibung ohne HTML. Keine Preisangaben im Text.
- Alle Texte auf Deutsch
- Keine Sonderzeichen wie Emojis
- Keine erfundenen Informationen — nur basierend auf den gegebenen Daten

Gib das Ergebnis als JSON zurück.`;

  try {
    const raw = await callGeminiStructured({
      parts: [{ text: prompt }],
      responseSchema: LISTING_RESPONSE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 2048,
    });

    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error('[listing-pipeline] Gemini generation failed:', err.message);
    return null;
  }
}

// ─── Channel Listing Builder ───────────────────────────────────────────────────

function buildEbayListing(product, geminiResult) {
  const id = product.identification || {};
  const det = product.details || {};
  const attrs = det.attributes || {};

  // Use Gemini result or fallback to existing data
  let title = safeStr(geminiResult?.ebay?.title) || safeStr(id.name);
  let description = safeStr(geminiResult?.ebay?.description) || safeStr(det.short_description);

  // Minimal title sanitization (max 80 chars, no schema rebuild)
  title = coerceTitleToPolicy(product, title, { minLen: 0, maxLen: EBAY_TITLE_MAX, forcePolicy: false }) || title;
  if (title.length > EBAY_TITLE_MAX) {
    title = title.slice(0, EBAY_TITLE_MAX - 1).trim() + '\u2026';
  }

  // Sanitize description to safe HTML
  if (description && !description.startsWith('<')) {
    description = sanitizeDescriptionToHtml(description) || description;
  }

  // Category from product (already mapped by enrichment pipeline)
  const categoryId = safeStr(det.categoryId) || safeStr(det.ebayCategoryId) || '';
  const categoryName = safeStr(det.ebayCategoryPath) || safeStr(id.category) || '';

  // Build attributes from product attributes
  const listingAttrs = {};
  if (id.brand) listingAttrs['Marke'] = id.brand;
  if (det.identifiers?.mpn) listingAttrs['Herstellernummer'] = det.identifiers.mpn;
  if (attrs.Modell) listingAttrs['Modell'] = attrs.Modell;
  if (attrs.Farbe) listingAttrs['Farbe'] = attrs.Farbe;

  return {
    title,
    description,
    categoryId,
    categoryName,
    attributes: listingAttrs,
  };
}

function buildKauflandListing(product, geminiResult) {
  const id = product.identification || {};
  const det = product.details || {};
  const ids = det.identifiers || {};

  // Use Gemini result or fallback
  let title = safeStr(geminiResult?.kaufland?.title) || safeStr(id.name);
  let description = safeStr(geminiResult?.kaufland?.description) || safeStr(det.short_description);

  // Enforce title max length
  if (title.length > KAUFLAND_TITLE_MAX) {
    title = title.slice(0, KAUFLAND_TITLE_MAX - 1).trim() + '\u2026';
  }

  // Strip HTML from Kaufland description (plain text only)
  description = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Category from product
  const kauflandCatId = safeStr(det.kauflandCategoryId) || '';
  const kauflandCatName = safeStr(det.kauflandCategoryPath) || '';

  // Build attributes
  const listingAttrs = {};
  if (id.brand) listingAttrs['brand'] = id.brand;
  const ean = Array.isArray(ids.ean) ? ids.ean[0] : ids.ean;
  if (ean) listingAttrs['ean'] = safeStr(ean);

  return {
    title,
    description,
    categoryId: kauflandCatId,
    categoryName: kauflandCatName,
    attributes: listingAttrs,
  };
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validateEbayListing(listing) {
  const issues = [];

  if (!listing.title || listing.title.length < 5) {
    issues.push({ severity: 'error', message: 'eBay-Titel fehlt oder ist zu kurz' });
  } else if (listing.title.length > EBAY_TITLE_MAX) {
    issues.push({ severity: 'warning', message: `eBay-Titel ist zu lang (${listing.title.length}/${EBAY_TITLE_MAX} Zeichen)` });
  }

  if (!listing.description || listing.description.length < 20) {
    issues.push({ severity: 'warning', message: 'eBay-Beschreibung fehlt oder ist sehr kurz' });
  }

  if (!listing.categoryId) {
    issues.push({ severity: 'error', message: 'eBay-Kategorie fehlt' });
  }

  const ready = issues.every((i) => i.severity !== 'error');
  return { ready, issues };
}

function validateKauflandListing(listing) {
  const issues = [];

  if (!listing.title || listing.title.length < 5) {
    issues.push({ severity: 'error', message: 'Kaufland-Titel fehlt oder ist zu kurz' });
  }

  if (!listing.description || listing.description.length < 20) {
    issues.push({ severity: 'warning', message: 'Kaufland-Beschreibung fehlt oder ist sehr kurz' });
  }

  if (!listing.attributes?.ean) {
    issues.push({ severity: 'error', message: 'EAN fehlt (Pflicht f\u00fcr Kaufland)' });
  }

  if (!listing.categoryId) {
    issues.push({ severity: 'warning', message: 'Kaufland-Kategorie fehlt' });
  }

  const ready = issues.every((i) => i.severity !== 'error');
  return { ready, issues };
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────────

/**
 * Generate channel-optimized listings for a product.
 *
 * @param {string} productId - The product ID to generate listings for
 * @param {object} [options]
 * @param {string[]} [options.channels] - Channels to generate for (default: all)
 * @returns {Promise<{productId, listings, generated_at}>}
 */
async function generateChannelListings(productId, options = {}) {
  if (!productId) {
    throw Object.assign(new Error('productId is required'), { code: 'VALIDATION_ERROR', status: 400 });
  }

  const product = await getProductV2(productId);
  if (!product) {
    throw Object.assign(new Error('Product not found'), { code: 'NOT_FOUND', status: 404 });
  }

  const channels = Array.isArray(options.channels) && options.channels.length
    ? options.channels.filter((c) => SUPPORTED_CHANNELS.includes(c))
    : SUPPORTED_CHANNELS;

  // Apply taxonomy mapping (mutates product in-place, same pattern as enrichment.js)
  if (channels.includes('ebay')) {
    try { applyEbayTaxonomy(product); } catch (e) {
      console.error('[listing-pipeline] eBay taxonomy failed:', e.message);
    }
  }
  if (channels.includes('kaufland')) {
    try { applyKauflandTaxonomy(product); } catch (e) {
      console.error('[listing-pipeline] Kaufland taxonomy failed:', e.message);
    }
  }

  // Generate optimized listings via Gemini
  const geminiResult = await generateListingsViaGemini(product, channels);

  const listings = {};

  if (channels.includes('ebay')) {
    const ebayListing = buildEbayListing(product, geminiResult);
    ebayListing.validation = validateEbayListing(ebayListing);
    listings.ebay = ebayListing;
  }

  if (channels.includes('kaufland')) {
    const kauflandListing = buildKauflandListing(product, geminiResult);
    kauflandListing.validation = validateKauflandListing(kauflandListing);
    listings.kaufland = kauflandListing;
  }

  return {
    productId,
    listings,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  generateChannelListings,
  buildEbayListing,
  buildKauflandListing,
  validateEbayListing,
  validateKauflandListing,
  EBAY_TITLE_MAX,
  KAUFLAND_TITLE_MAX,
  SUPPORTED_CHANNELS,
  // exported for testing
  __test: {
    buildProductContext,
    generateListingsViaGemini,
  },
};
