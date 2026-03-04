/**
 * Generates strict, photorealistic studio packshot prompts.
 * Uses the reference image as EXACT product identity — Gemini must reproduce
 * the same product, not generate a similar one.
 *
 * @param {Object} product - The product object
 * @returns {Promise<{studio: {front: string, angle: string, detail: string, back: string}}>}
 */
function detectPrimaryColor(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') return null;
  const directKeys = ['Color', 'Farbe', 'Colour', 'Primary Color', 'Hauptfarbe'];
  for (const key of directKeys) {
    if (attributes[key]) {
      return attributes[key];
    }
  }
  const fallbackKey = Object.keys(attributes).find((key) => key.toLowerCase().includes('color') || key.toLowerCase().includes('farbe'));
  if (fallbackKey) {
    return attributes[fallbackKey];
  }
  return null;
}

function pickStudioBackground(colorDescriptor) {
  const value = (colorDescriptor || '').toString().toLowerCase();
  const darkTokens = ['black', 'dark', 'anthracite', 'charcoal', 'graphite', 'navy', 'schwarz', 'dunkel', 'grau', 'gray'];
  const lightTokens = ['white', 'light', 'silver', 'ivory', 'cream', 'beige', 'weiß', 'hell', 'silber'];

  if (darkTokens.some((token) => value.includes(token))) {
    return 'premium white e-commerce gradient background';
  }
  if (lightTokens.some((token) => value.includes(token))) {
    return 'premium light neutral gray e-commerce gradient background';
  }
  return 'premium white e-commerce gradient background';
}

/**
 * Builds a concise product descriptor from identification fields.
 */
function buildProductDescriptor(product) {
  const parts = [
    product.identification?.brand,
    product.identification?.name,
    product.identification?.category,
  ].filter(Boolean);
  return parts.length ? parts.join(' ').trim() : 'the product shown in the reference image';
}

/**
 * Collects key visual attributes to anchor the prompt to the real product.
 */
function buildVisualAnchors(product) {
  const attrs = product?.details?.attributes || {};
  const anchors = [];
  const keys = ['Material', 'Farbe', 'Color', 'Größe', 'Size', 'Maße', 'Dimensions', 'Stil', 'Style'];
  for (const key of keys) {
    if (attrs[key]) {
      anchors.push(`${key}: ${attrs[key]}`);
    }
  }
  return anchors.length ? anchors.join(', ') : '';
}

/**
 * Core identity anchor — instructs Gemini to treat the reference image as
 * the EXACT product, not as inspiration.
 */
function buildIdentityAnchor(productDescriptor, visualAnchors) {
  const lines = [
    'CRITICAL: The attached reference image shows the EXACT product to photograph.',
    'You MUST reproduce this IDENTICAL product — same shape, same proportions, same materials, same color, same design details, same labels, same hardware.',
    'Do NOT generate a similar or generic product. Do NOT change ANY physical detail of the product.',
  ];
  if (visualAnchors) {
    lines.push(`Known product attributes: ${visualAnchors}.`);
  }
  return lines.join(' ');
}

function buildDefaultPromptSet(productDescriptor, background, visualAnchors) {
  const anchor = buildIdentityAnchor(productDescriptor, visualAnchors);

  const basePrompt = (perspective) =>
    `High-end ${perspective} product photo of a ${productDescriptor}. ` +
    `Shot on a ${background} (eBay-style), ` +
    'with soft directional studio lighting that produces clean, natural shadows and perfect color accuracy. ' +
    'Ultra-sharp edges, high resolution, glossy-matte material rendering, no reflections, no props, no text. ' +
    'Fully marketplace-ready composition with strong visual depth and premium retail aesthetic. ' +
    anchor;

  return {
    studio: {
      front: basePrompt('close-up 3/4'),
      angle: basePrompt('45-degree side angle'),
      detail: basePrompt('macro detail close-up of the key functional area of'),
      back: basePrompt('rear/back view'),
    },
  };
}

async function generateVisualDescriptions(product) {
  const productDescriptor = buildProductDescriptor(product);
  const attributes = product.details?.attributes || {};
  const colorDescriptor = detectPrimaryColor(attributes) || 'unknown';
  const background = pickStudioBackground(colorDescriptor);
  const visualAnchors = buildVisualAnchors(product);

  return buildDefaultPromptSet(productDescriptor, background, visualAnchors);
}

module.exports = {
  generateVisualDescriptions,
};
