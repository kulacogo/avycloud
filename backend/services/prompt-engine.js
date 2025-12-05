const { generateText } = require('../lib/gemini');

/**
 * Generates detailed visual descriptions for product photography using Gemini.
 * @param {Object} product - The product object
 * @returns {Promise<{studio: string, lifestyle: string, detail: string}>}
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

function buildDefaultPromptSet(identity, backgroundLight, backgroundDark) {
  const studioFront = `A photo of ${identity} on a seamless background (${backgroundLight}). Centered straight-on front view, soft studio lighting, ultra clean ecommerce aesthetic.`;
  return {
    studio: {
      front: studioFront,
      detail: `A photo of ${identity} focusing on the main feature. Tight crop, razor sharp material detail, ${backgroundLight}.`,
      topdown: `A photo of ${identity} from a perfectly vertical top-down camera angle on ${backgroundLight}.`,
    },
    lifestyle: {
      front: `A photo of ${identity} placed in a realistic environment appropriate for its use. The product remains the hero in the frame.`,
      closeup: `A photo of ${identity} showing a close-up section in context, highlighting how the material or interface feels when touched or used.`,
      inuse: `A photo of ${identity} being actively used in a natural scenario that matches its purpose. Humans or accessories may appear but the product design stays unchanged.`,
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
  const features = product.details?.key_features || [];
  const colorDescriptor = detectPrimaryColor(attributes) || 'unknown';
  const materialDescriptor = attributes.Material || attributes['Materialtyp'] || 'standard material';
  const backgroundLight = 'very light neutral gray background (#F4F4F4)';
  const backgroundDark = 'pure white background (#FFFFFF)';

  const context = `
Product Identity: ${identity}
Attributes: ${JSON.stringify(attributes)}
Key Features: ${features.join(', ')}
Dominant Color: ${colorDescriptor}
Material: ${materialDescriptor}
  `;

  const prompt = `
You are a professional product photographer and art director.
Your task is to generate 6 high-end image generation prompts for the following product:

${context}

First, extract the **Core Object Type** from the description (e.g., “Yoga Mat”, “Router”, “Water Pump”, “LED Floodlight”).
Every generated image prompt MUST begin with:

"A photo of [Core Object Type]…"

------------------------------------------------------------
GLOBAL IMAGE RULES (APPLY TO ALL 6 PROMPTS):
- The final generated images must always be exactly 1:1 aspect ratio and 1024 × 1024 px resolution.
- The Main product must remain unchanged in its design, proportions, details, and color.
- Never add text, watermarks, icons, labels, stickers, or artificial overlays.
- No gradients, no vignettes, no reflections, no color casts.
- Composition must be centered, clean, and suitable for ecommerce marketplaces.
- Lighting must always be soft, even, realistic, and not overly dramatic.

------------------------------------------------------------
BACKGROUND AUTO-SELECTION LOGIC:
Analyze the provided product color information ("${colorDescriptor}") and follow these strict rules:
If the Main product appears light-colored (white, silver, beige, light gray) → use a very light neutral gray seamless background (#F4F4F4).
If the Main product appears dark-colored (black, charcoal, deep blue, dark green) → use a pure white seamless background (#FFFFFF).
Never deviate from these options. Mention the appropriate background directly in each studio prompt.

------------------------------------------------------------
You must now generate **six separate prompts**, grouped exactly as follows:

STUDIO IMAGES (3 TOTAL):
1. studio_front:
   A clean, centered straight-on front view of the Main product using the studio background rules above.
2. studio_detail:
   A close-up view focusing on the front section or key functional detail of the Main product.
3. studio_topdown:
   A perfectly vertical top-down shot of the Main product, centered, clean, evenly lit.

LIFESTYLE IMAGES (3 TOTAL):
4. lifestyle_front:
   A realistic lifestyle scene showing the Main product clearly from the front in an authentic real-world environment appropriate to its use.
5. lifestyle_closeup:
   A lifestyle close-up showing a detail of the product in context, focusing on texture, function, or interaction.
6. lifestyle_inuse:
   A realistic in-use scene where the Main product is actively operated or interacted with in a natural environment. The product design must remain unchanged.

Return ONLY the following JSON structure (with fully populated strings):
{
  "studio": {
    "front": "",
    "detail": "",
    "topdown": ""
  },
  "lifestyle": {
    "front": "",
    "closeup": "",
    "inuse": ""
  }
}
Do not wrap the JSON in markdown or prose.
  `;

  const defaultPrompts = buildDefaultPromptSet(identity, backgroundLight, backgroundDark);

  try {
    const responseText = await generateText(prompt, { temperature: 0.6 });
    const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      studio: {
        front: parsed?.studio?.front || defaultPrompts.studio.front,
        detail: parsed?.studio?.detail || defaultPrompts.studio.detail,
        topdown: parsed?.studio?.topdown || defaultPrompts.studio.topdown,
      },
      lifestyle: {
        front: parsed?.lifestyle?.front || defaultPrompts.lifestyle.front,
        closeup: parsed?.lifestyle?.closeup || defaultPrompts.lifestyle.closeup,
        inuse: parsed?.lifestyle?.inuse || defaultPrompts.lifestyle.inuse,
      },
    };
  } catch (error) {
    console.error('Prompt generation failed:', error);
    return defaultPrompts;
  }
}

module.exports = {
    generateVisualDescriptions,
};
