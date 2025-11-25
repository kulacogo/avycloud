const { getOpenAIClient } = require('./openai-client');
const { resolveModel } = require('./model-select');
const { uploadGeneratedProductImage } = require('./storage');

const IMAGE_HOST_MODEL = process.env.IMAGE_HOST_MODEL || 'gpt-image-1';
const IMAGE_PROMPT_MODEL = process.env.IMAGE_PROMPT_MODEL || 'gpt-4.1-mini';
const IMAGE_GENERATION_PARAMS = {
  size: process.env.GPT_IMAGE_SIZE || '1024x1024',
  quality: process.env.GPT_IMAGE_QUALITY || 'high',
  background: process.env.GPT_IMAGE_BACKGROUND || 'auto',
};

const VARIANT_PROMPTS = [
  {
    variant: 'studio',
    basePrompt:
      'High-end studio product photo of the same item from the reference image. 3/4 angle, soft gradient background, premium lighting, no props, no text.',
  },
  {
    variant: 'lifestyle',
    basePrompt:
      'Realistic lifestyle scene featuring the same item from the reference image, used by a person in a modern home setting. Natural daylight, wooden floor, photorealistic textures, clean shadows.',
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

function buildProductContext(product) {
  if (!product) return '';
  const parts = [];
  const brand = product?.identification?.brand;
  const name = product?.identification?.name;
  const category = product?.identification?.category;
  const color = product?.details?.attributes?.Farbe || product?.details?.attributes?.Color;

  if (brand || name) {
    parts.push(`Product: ${[brand, name].filter(Boolean).join(' ')}`);
  } else if (category) {
    parts.push(`Product category: ${category}`);
  }
  if (color) {
    parts.push(`Color: ${color}`);
  }

  const attributes = extractAttributes(product.details).slice(0, 4);
  if (attributes.length) {
    parts.push(`Attributes: ${attributes.join(', ')}`);
  }

  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.slice(0, 4)
    : [];
  if (features.length) {
    parts.push(`Key features: ${features.join('; ')}`);
  }

  return parts.join('. ');
}

function buildPrompt(basePrompt, product) {
  const context = buildProductContext(product);
  if (!context) return basePrompt;
  return `${basePrompt}\nProduct details: ${context}`;
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
      image_url: {
        url,
        detail: 'high',
      },
    }));
}

function getReferenceImages(hostedImages = []) {
  return hostedImages.slice(0, 2).map((img) => ({
    type: 'input_image',
    image_url: {
      url: img.url,
      detail: 'high',
    },
  }));
}

function buildReferenceContentFromUrl(url) {
  if (!url) return [];
  return [
    {
      type: 'input_image',
      image_url: {
        url,
        detail: 'high',
      },
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
  basePrompt,
  variant,
  referenceContent = [],
}) {
  const instructionModel = resolveModel(null, 'IMAGE_PROMPT_MODEL', IMAGE_PROMPT_MODEL);
  const targetImageModel = resolveModel(null, 'IMAGE_HOST_MODEL', IMAGE_HOST_MODEL);
  const prompt = buildPrompt(basePrompt, product);

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
          image_generation: {
            ...IMAGE_GENERATION_PARAMS,
          },
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
      response_format: 'b64_json',
    });
    const base64Payload = fallback?.data?.[0]?.b64_json || null;
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
      const image = await generateVariantImage({
        client,
        product,
        basePrompt: def.basePrompt,
        variant: def.variant,
        referenceContent,
      });
      if (image) {
        generated.push(image);
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
    basePrompt: promptDef.basePrompt,
    variant: promptDef.variant,
    referenceContent,
  });
  return image;
}

module.exports = {
  generateProductImageVariants,
  regenerateProductImage,
};

