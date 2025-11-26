const { getOpenAIClient } = require('./openai-client');
const { resolveModel } = require('./model-select');
const { uploadGeneratedProductImage } = require('./storage');

const IMAGE_HOST_MODEL = process.env.IMAGE_HOST_MODEL || 'gpt-image-1';
const IMAGE_PROMPT_MODEL = process.env.IMAGE_PROMPT_MODEL || 'gpt-5-mini-2025-08-07';
const IMAGE_GENERATION_PARAMS = {
  size: process.env.GPT_IMAGE_SIZE || '1024x1024',
  quality: process.env.GPT_IMAGE_QUALITY || 'high',
  background: process.env.GPT_IMAGE_BACKGROUND || 'auto',
};
const MAX_VARIANT_ATTEMPTS = parseInt(process.env.GPT_IMAGE_VARIANT_ATTEMPTS || '2', 10);

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

function extractAttributes(details) {
  if (!details?.attributes) return [];
  if (Array.isArray(details.attributes)) {
    return details.attributes
      .map((entry) => `${entry?.key}: ${entry?.value}`)
      .filter(Boolean);
  }
  return Object.entries(details.attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .filter(Boolean);
}

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

function collectProductImageReferences(product) {
  if (!Array.isArray(product?.details?.images)) {
    return [];
  }
  return product.details.images
    .map((img) => img?.url_or_base64 || img?.url)
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .slice(0, 2)
    .map((url) => ({
      type: 'input_image',
      image_url: url,
    }));
}

function getReferenceImages(hostedImages = []) {
  return hostedImages.slice(0, 2).map((img) => ({
    type: 'input_image',
    image_url: img.url,
  }));
}

function buildReferenceContentFromUrl(url) {
  if (!url) return [];
  return [
    {
      type: 'input_image',
      image_url: url,
    },
  ];
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
    notes: `GPT Image 1 ${variant} render`,
  };
}

async function generateVariantImage({
  client,
  product,
  template,
  variant,
  referenceContent = [],
}) {
  const instructionModel = resolveModel(null, 'IMAGE_PROMPT_MODEL', IMAGE_PROMPT_MODEL);
  const targetImageModel = resolveModel(null, 'IMAGE_HOST_MODEL', IMAGE_HOST_MODEL);
  const prompt = buildPrompt(template, product);

  // Primary attempt: Responses API with image_generation tool (allows vision references)
  try {
    const response = await client.responses.create({
      model: instructionModel,
      input: [
        {
          role: 'user',
          content: [
            ...referenceContent,
            {
              type: 'input_text',
              text: prompt,
            },
          ],
        },
      ],
      tool_choice: { type: 'image_generation' },
      tools: [
        {
          type: 'image_generation',
          quality:
            IMAGE_GENERATION_PARAMS.quality === 'auto' ? undefined : IMAGE_GENERATION_PARAMS.quality,
          background:
            IMAGE_GENERATION_PARAMS.background === 'auto' ? undefined : IMAGE_GENERATION_PARAMS.background,
        },
      ],
    });

    const generationCall = response.output?.find(
      (item) => item.type === 'image_generation_call'
    );
    const rawResult = generationCall?.result;
    const base64Payload = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    if (base64Payload) {
      return await uploadGeneratedResult(base64Payload, product.id, variant);
    }
    console.warn(`Image tool returned no payload for product ${product?.id}, variant ${variant}`);
  } catch (error) {
    console.warn(
      `Primary GPT image generation failed for ${product?.id} (${variant}):`,
      error?.message || error
    );
    if (error?.response?.body) {
      console.warn('Image generation response body:', error.response.body);
    }
  }

  // Fallback: direct Images API (text-only prompt)
  try {
    const fallback = await client.images.generate({
      model: targetImageModel,
      prompt,
      size: IMAGE_GENERATION_PARAMS.size || '1024x1024',
      quality: IMAGE_GENERATION_PARAMS.quality === 'auto' ? undefined : IMAGE_GENERATION_PARAMS.quality,
      background:
        IMAGE_GENERATION_PARAMS.background === 'auto' ? undefined : IMAGE_GENERATION_PARAMS.background,
      n: 1,
    });
    const imageData = fallback?.data?.[0] || {};
    const base64Payload = imageData.b64_json || imageData.base64 || null;
    if (base64Payload) {
      return await uploadGeneratedResult(base64Payload, product.id, variant);
    }
    console.warn(
      `Fallback image generation returned no payload for ${product?.id} (${variant}).`
    );
  } catch (fallbackError) {
    console.warn(
      `Fallback GPT image generation failed for ${product?.id} (${variant}):`,
      fallbackError?.message || fallbackError
    );
  }

  return null;
}

async function generateProductImageVariants(products = [], hostedImages = []) {
  if (!Array.isArray(products) || !products.length) return;
  const client = await getOpenAIClient();
  const hasHosted = Array.isArray(hostedImages) && hostedImages.length > 0;
  const sharedReferenceContent = hasHosted ? getReferenceImages(hostedImages) : [];
  if (!sharedReferenceContent.length) {
    console.warn(
      'GPT image generation: no hosted reference images available, falling back to product metadata/text prompts.'
    );
  }

  for (const product of products) {
    if (!product?.id) continue;
    const referenceContent =
      sharedReferenceContent.length > 0 ? sharedReferenceContent : collectProductImageReferences(product);
    if (!referenceContent.length) {
      console.warn(
        `GPT image generation: product ${product.id} has no reference imagery; generating from prompt context only.`
      );
    }
    const generated = [];
    for (const def of VARIANT_PROMPTS) {
      let attempt = 0;
      let image = null;
      while (attempt < MAX_VARIANT_ATTEMPTS && !image) {
        image = await generateVariantImage({
          client,
          product,
          template: def.template,
          variant: def.variant,
          referenceContent,
        });
        if (!image && attempt < MAX_VARIANT_ATTEMPTS - 1) {
          console.warn(
            `Retrying image generation for ${product.id} (${def.variant}) – attempt ${attempt + 2}`
          );
        }
        attempt += 1;
      }
      if (image) {
        generated.push(image);
      } else {
        console.warn(`Failed to generate ${def.variant} for ${product.id} after ${MAX_VARIANT_ATTEMPTS} attempts.`);
      }
    }

    if (generated.length) {
      product.details = product.details || {};
      const existingImages = Array.isArray(product.details.images)
        ? product.details.images
        : [];
      const nonGenerated = existingImages.filter(
        (img) => !/(generated|gpt)/i.test(img?.source || '') && !/(generated|gpt)/i.test(img?.notes || '')
      );
      product.details.images = [...generated, ...nonGenerated].slice(0, 10);
    }
  }
}

async function regenerateProductImage({ product, referenceUrl, variant = 'studio' }) {
  if (!product?.id) {
    throw new Error('Product id required for image regeneration');
  }
  if (!referenceUrl) {
    throw new Error('Reference image URL is required for regeneration');
  }
  const promptDef =
    VARIANT_PROMPTS.find((entry) => entry.variant === variant) || VARIANT_PROMPTS[0];
  const client = await getOpenAIClient();
  const referenceContent = buildReferenceContentFromUrl(referenceUrl);
  const image = await generateVariantImage({
    client,
    product,
    template: promptDef.template,
    variant: promptDef.variant,
    referenceContent,
  });
  return image;
}

module.exports = {
  generateProductImageVariants,
  regenerateProductImage,
};

