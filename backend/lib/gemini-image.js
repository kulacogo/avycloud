const { uploadGeneratedProductImage } = require('./storage');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_API_ROOT =
  process.env.GEMINI_API_ROOT || 'https://generativelanguage.googleapis.com/v1beta';
const MAX_VARIANT_ATTEMPTS = parseInt(process.env.GEMINI_IMAGE_VARIANT_ATTEMPTS || '2', 10);
const VARIANT_DELAY_MS = parseInt(process.env.GEMINI_IMAGE_VARIANT_DELAY_MS || '3100', 10);

const VARIANT_PROMPTS = [
  {
    variant: 'studio_hero',
    template:
      'Detailed close-up 3/4 view product-style photo of ${productName} in ${productColor} color. Use a bright white gradient studio background with soft natural diffusion lighting. Include a subtle floor spotlight transition, gentle shadows, and emphasize ${detailFocus}. No props, no text, perfect color accuracy.',
  },
  {
    variant: 'studio_detail',
    template:
      'Macro studio shot of ${productName} that highlights premium materials and controls. Flat neutral grey background, diffused rim lighting, ultra-sharp focus, and rendered to preserve the ${productColor} finish and branded accents. No reflections, no humans.',
  },
  {
    variant: 'lifestyle_commute',
    template:
      'Realistic lifestyle scene featuring ${productName} being actively used by a young adult in ${usageEnvironment}. Show them moving along ${usageExamples}, natural daylight, and emphasize how the ${productName} handles ${detailFocus}.',
  },
  {
    variant: 'lifestyle_closeup',
    template:
      'Lifestyle scene with ${productName} parked near a bench or café table. Hands may rest on the controls but the product remains front-and-center. Capture the ${productColor} finish, textured grip, and premium branding with warm daylight and natural shadows.',
  },
];

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function pickAttribute(details, keys = []) {
  if (!details?.attributes || typeof details.attributes !== 'object') return null;
  for (const key of keys) {
    if (details.attributes[key]) {
      return details.attributes[key];
    }
  }
  return null;
}

function sanitizeString(value) {
  if (!value) return '';
  return String(value).trim();
}

function resolveProductColor(product) {
  const colorKeys = ['Farbe', 'farbe', 'Color', 'color', 'ColorName', 'colorName'];
  const raw = pickAttribute(product.details, colorKeys);
  if (raw) {
    return sanitizeString(raw);
  }
  return 'neutral metallic';
}

function resolveDetailFocus(product) {
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.filter(Boolean)
    : [];
  if (features.length) return sanitizeString(features[0]);
  const material = pickAttribute(product.details, ['Material', 'material', 'Finish']);
  if (material) {
    return `the ${sanitizeString(material)} surface`;
  }
  return 'premium surfaces';
}

function resolveUsageEnvironment(product) {
  const usageAttr = pickAttribute(product.details, ['Einsatzbereich', 'usageEnvironment', 'Usage']);
  if (usageAttr) {
    return sanitizeString(usageAttr);
  }
  const category = sanitizeString(product?.identification?.category).toLowerCase();
  if (category.includes('roller') || category.includes('scooter')) {
    return 'urban streets or modern plazas';
  }
  if (category.includes('vacuum') || category.includes('staubsauger')) {
    return 'clean, modern living spaces';
  }
  return 'urban streets or park pathways';
}

function buildUsageExamples(env) {
  if (!env) return 'a city street or a park pathway';
  const parts = env
    .split(/,|or|\/|·/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]} or ${parts[1]}`;
  }
  return `${env} or a nearby plaza`;
}

function buildProductContext(product) {
  const productName = `${sanitizeString(product?.identification?.brand)} ${sanitizeString(
    product?.identification?.name
  )}`.trim() || 'product';
  const productColor = resolveProductColor(product);
  const detailFocus = resolveDetailFocus(product);
  const usageEnvironment = resolveUsageEnvironment(product);
  const usageExamples = buildUsageExamples(usageEnvironment);
  return {
    productName,
    productColor,
    detailFocus,
    usageEnvironment,
    usageExamples,
  };
}

function buildPrompt(template, product) {
  const context = buildProductContext(product);
  return Object.entries(context).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value),
    template
  );
}

async function callGeminiImage(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const endpoint = `${GEMINI_API_ROOT}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error?.message || response.statusText;
    throw new Error(`Gemini image generation failed: ${message}`);
  }

  const candidates = payload?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        return inline.data;
      }
    }
  }
  throw new Error('Gemini image response contained no inline image data.');
}

async function uploadGeneratedResult(base64Payload, productId, variant) {
  if (!base64Payload || typeof base64Payload !== 'string') {
    throw new Error('Image generation returned empty payload');
  }
  const normalizedBase64 = base64Payload.startsWith('data:')
    ? base64Payload
    : `data:image/png;base64,${base64Payload}`;
  const upload = await uploadGeneratedProductImage(normalizedBase64, productId, variant);
  return {
    source: 'generated',
    variant,
    url_or_base64: upload.url,
    width: upload.width,
    height: upload.height,
    notes: `Gemini ${variant} render`,
  };
}

async function generateProductImageVariants(products = []) {
  if (!Array.isArray(products) || !products.length) return;

  for (const product of products) {
    if (!product?.id) continue;
    const generated = [];
    for (const def of VARIANT_PROMPTS) {
      let attempt = 0;
      let image = null;
      while (attempt < MAX_VARIANT_ATTEMPTS && !image) {
        try {
          const prompt = buildPrompt(def.template, product);
          const base64Payload = await callGeminiImage(prompt);
          image = await uploadGeneratedResult(base64Payload, product.id, def.variant);
        } catch (error) {
          attempt += 1;
          if (attempt >= MAX_VARIANT_ATTEMPTS) {
            console.warn(
              `Failed to generate ${def.variant} for ${product.id} after ${attempt} attempts:`,
              error?.message || error
            );
            break;
          }
          console.warn(
            `Retrying image generation for ${product.id} (${def.variant}) – attempt ${attempt + 1}`
          );
          if (VARIANT_DELAY_MS > 0) {
            await delay(VARIANT_DELAY_MS);
          }
        }
      }
      if (image) {
        generated.push(image);
      }
      if (VARIANT_DELAY_MS > 0) {
        await delay(VARIANT_DELAY_MS);
      }
    }

    const requiredVariants = new Set(VARIANT_PROMPTS.map((entry) => entry.variant));
    const producedVariants = new Set(generated.map((img) => img.variant));
    const missing = Array.from(requiredVariants).filter((variant) => !producedVariants.has(variant));
    if (missing.length) {
      throw new Error(
        `Missing Gemini images for product ${product.id}: ${missing.join(', ')}. Aborting improve run.`
      );
    }

    if (generated.length) {
      product.details = product.details || {};
      const existingImages = Array.isArray(product.details.images)
        ? product.details.images
        : [];
      const nonGenerated = existingImages.filter(
        (img) => !/(generated|gemini|gpt)/i.test(img?.source || '') && !/(generated|gemini|gpt)/i.test(img?.notes || '')
      );
      product.details.images = [...generated, ...nonGenerated].slice(0, 10);
    }
  }
}

async function regenerateProductImage({ product, variant = 'studio_hero' }) {
  if (!product?.id) {
    throw new Error('Product id required for image regeneration');
  }
  const promptDef =
    VARIANT_PROMPTS.find((entry) => entry.variant === variant) || VARIANT_PROMPTS[0];
  const prompt = buildPrompt(promptDef.template, product);
  const base64Payload = await callGeminiImage(prompt);
  return uploadGeneratedResult(base64Payload, product.id, promptDef.variant);
}

module.exports = {
  generateProductImageVariants,
  regenerateProductImage,
};


