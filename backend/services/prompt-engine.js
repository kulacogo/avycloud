/**
 * Generates strict, photorealistic studio packshot prompts.
 * @param {Object} product - The product object
 * @returns {Promise<{studio: {front: string, angle: string, topdown: string, detail: string}}>}
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
    return {
      background: 'a pure white seamless background (#FFFFFF)',
      directive: 'Detected a dark-toned product; use pure white (#FFFFFF) for maximum contrast.',
    };
  }
  if (lightTokens.some((token) => value.includes(token))) {
    return {
      background: 'a very light neutral gray seamless background (#F4F4F4)',
      directive: 'Detected a light-toned product; use light neutral gray (#F4F4F4) to avoid blending with white.',
    };
  }
  return {
    background: 'a very light neutral gray seamless background (#F4F4F4)',
    directive: 'Product color is unspecified or mid-tone; default to neutral light gray (#F4F4F4).',
  };
}

function buildDefaultPromptSet(identity, studioBackground) {
  const subject = identity ? `the exact product (${identity})` : 'the exact product';
  const baseRules =
    [
      'IMAGE EDITING TASK (do not invent): Use the provided reference image as strict visual ground truth.',
      'eBay listing compliance: hero image must show the complete product clearly, with no crop of critical parts.',
      'Keep the exact product identity and perspective. Do NOT change shape, proportions, materials, color, labels, logos, screws, cables, attachments, or included parts.',
      `Allowed edits ONLY: replace background with ${studioBackground}, neutralize lighting to soft even studio light, and do minimal cleanup (dust/noise).`,
      'Forbidden: adding/removing parts, changing viewpoint/perspective, adding props/packaging (unless already visible), adding environment/lifestyle, people/hands, frames, text/watermarks/icons/stickers/overlays.',
      'If unsure, preserve the reference image details exactly.',
    ].join(' ');
  const studioFront = `Edit the provided reference image into a photorealistic studio packshot of ${subject} on ${studioBackground}. Main/hero shot: full front view of the complete product, centered, clean edges, no decorative elements, soft even studio lighting. ${baseRules}`;
  return {
    studio: {
      front: studioFront,
      angle: `Edit the provided reference image into a photorealistic studio packshot of ${subject} on ${studioBackground}. Keep the original camera perspective (do not invent angles). Soft even studio lighting. ${baseRules}`,
      topdown: `Edit the provided reference image into a photorealistic studio packshot of ${subject} on ${studioBackground}. Keep the original camera perspective (do not invent angles). Soft even studio lighting. ${baseRules}`,
      detail: `Edit the provided reference image into a photorealistic studio packshot detail shot of ${subject} on ${studioBackground}. Tight crop on a key functional area that is visible in the reference image. Do not invent hidden details. Soft even studio lighting. ${baseRules}`,
    },
  };
}

async function generateVisualDescriptions(product) {
  const identity = [
    product.identification?.brand,
    product.identification?.name,
    product.identification?.category,
  ]
    .filter(Boolean)
    .join(' ')
    .trim() || 'the product';

  const attributes = product.details?.attributes || {};
  const colorDescriptor = detectPrimaryColor(attributes) || 'unknown';
  const { background: studioBackground } = pickStudioBackground(colorDescriptor);

  // Deterministic (non-LLM) prompt generation to avoid hallucinated scenes/props.
  // Background selection is still data-driven via color heuristics.
  return buildDefaultPromptSet(identity, studioBackground);
}

module.exports = {
    generateVisualDescriptions,
};
