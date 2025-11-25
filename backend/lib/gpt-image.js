const { getOpenAIClient } = require('./openai-client');
const { resolveModel } = require('./model-select');
const { uploadGeneratedProductImage } = require('./storage');

const IMAGE_HOST_MODEL = process.env.IMAGE_HOST_MODEL || 'gpt-image-1';
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

async function generateVariantImage({
  client,
  product,
  basePrompt,
  variant,
  referenceContent = [],
}) {
  try {
    const targetModel = resolveModel(null, 'IMAGE_HOST_MODEL', IMAGE_HOST_MODEL);
    const response = await client.responses.create({
      model: targetModel,
      input: [
        {
          role: 'user',
          content: [
            ...referenceContent,
            {
              type: 'input_text',
              text: buildPrompt(basePrompt, product),
            },
          ],
        },
      ],
      tool_choice: { type: 'image_generation' },
      tools: [
        {
          type: 'image_generation',
          image_generation: IMAGE_GENERATION_PARAMS,
        },
      ],
    });

    const generationCall = response.output?.find(
      (item) => item.type === 'image_generation_call'
    );
    const rawResult = generationCall?.result;
    const base64Payload = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    if (!base64Payload || typeof base64Payload !== 'string') {
      throw new Error('Image generation returned no result payload');
    }
    const normalizedBase64 = base64Payload.startsWith('data:')
      ? base64Payload
      : `data:image/png;base64,${base64Payload}`;
    const upload = await uploadGeneratedProductImage(normalizedBase64, product.id, variant);
    return {
      source: 'generated',
      variant,
      url_or_base64: upload.url,
      width: upload.width,
      height: upload.height,
      notes: `GPT Image 1 ${variant} render`,
    };
  } catch (error) {
    console.warn(
      `Failed to generate ${variant} image for ${product?.id}:`,
      error?.message || error
    );
    if (error?.response?.body) {
      console.warn('Image generation response body:', error.response.body);
    }
    return null;
  }
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
      product.details.images = [...existingImages, ...generated];
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

