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
    'Photorealistic studio product photo, single product only. Use the provided reference image as strict visual ground truth: do not change shape, proportions, materials, color, labels, or attachments. No props, no packaging unless visible in the reference, no environment, no people, no hands. No text, no watermarks, no icons, no stickers, no overlays.';
  const studioFront = `A photo of ${subject} on ${studioBackground}. Centered straight-on front view. Soft, even studio lighting. ${baseRules}`;
  return {
    studio: {
      front: studioFront,
      angle: `A photo of ${subject} on ${studioBackground}. 45-degree three-quarter angle view. Soft, even studio lighting. ${baseRules}`,
      topdown: `A photo of ${subject} from a perfectly vertical top-down camera angle on ${studioBackground}. Centered. Soft, even studio lighting. ${baseRules}`,
      detail: `A photo of ${subject} on ${studioBackground}. Close-up detail shot of a key functional area. Tight crop, razor sharp detail. Soft, even studio lighting. ${baseRules}`,
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
