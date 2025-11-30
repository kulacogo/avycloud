const { generateProductImages } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');

const GENERATED_IMAGE_PATTERN = /(generated|gpt|gemini|vertex|ai[-\s]?image|ai[-\s]?render)/i;
const MAX_REFERENCE_BYTES = parseInt(process.env.VERTEX_REFERENCE_MAX_BYTES || '12000000', 10);

function isLikelyAiImage(image = {}) {
  const source = String(image.source || '').toLowerCase();
  const notes = String(image.notes || '').toLowerCase();
  return GENERATED_IMAGE_PATTERN.test(source) || GENERATED_IMAGE_PATTERN.test(notes);
}

function sanitizeSentence(value) {
  if (!value) return null;
  return value
    .toString()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildProductPrompt(product) {
  const titleParts = [
    product.identification?.brand,
    product.identification?.name,
    product.identification?.category,
  ]
    .map(sanitizeSentence)
    .filter(Boolean);

  const identity = titleParts.join(' ').trim() || 'Produkt';
  const lines = [
    `Exact product photo of ${identity}.`,
    'Preserve the real-world proportions, colors, textures, and branding identical to the reference image.',
    'Pure white background, studio lighting, soft shadows, no props, no text overlays, no reflections, no hands.',
  ];

  const sku = product.identification?.sku || product.details?.identifiers?.sku;
  if (sku) {
    lines.push(`SKU: ${sku}.`);
  }

  const keyFeatures = (product.details?.key_features || []).map(sanitizeSentence).filter(Boolean).slice(0, 4);
  if (keyFeatures.length) {
    lines.push(`Key features: ${keyFeatures.join('; ')}.`);
  }

  const highlightAttributes = Object.entries(product.details?.attributes || {})
    .filter(([key, value]) => Boolean(key) && value !== null && value !== undefined)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${value}`);

  if (highlightAttributes.length) {
    lines.push(`Important specs: ${highlightAttributes.join('; ')}.`);
  }

  return lines.join(' ');
}

async function fetchImageAsDataUrl(image) {
  const value = image?.url_or_base64;
  if (!value) {
    throw new Error('Reference image payload is missing.');
  }

  if (value.startsWith('data:')) {
    return value;
  }

  if (/^https?:\/\//i.test(value)) {
    console.log(`Downloading reference image from ${value}`);
    const response = await fetch(value);
    if (!response.ok) {
      throw new Error(`Failed to download reference image (${response.status})`);
    }
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_REFERENCE_BYTES) {
      throw new Error(`Reference image exceeds ${Math.floor(MAX_REFERENCE_BYTES / (1024 * 1024))} MB limit`);
    }
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  throw new Error('Unsupported reference image format.');
}

async function generateImagesForProduct(product, options = {}) {
  if (!product?.id) {
    throw new Error('Product ID is required');
  }

  const referenceImage = options.referenceImage;
  if (!referenceImage) {
    throw new Error('Reference image must be provided');
  }

  if (isLikelyAiImage(referenceImage)) {
    throw new Error('AI-generated images cannot be used as reference material');
  }

  const referenceDataUrl = await fetchImageAsDataUrl(referenceImage);
  const prompt = buildProductPrompt(product);
  const sampleCount = Number.isFinite(options.sampleCount) ? Math.min(Math.max(options.sampleCount, 1), 4) : 2;

  console.log(
    `Generating Vertex AI edits for ${product.id} using reference image (${referenceImage.source || 'unknown'})`
  );

  const predictions = await generateProductImages({
    prompt,
    count: sampleCount,
    aspectRatio: options.aspectRatio || '1:1',
    referenceImageBase64: referenceDataUrl,
    editMode: options.editMode || 'EDIT_MODE_BGSWAP',
  });

  const uploaded = [];
  for (const [index, prediction] of predictions.entries()) {
    if (!prediction?.base64) {
      continue;
    }
    const mimeType = prediction.mimeType || 'image/png';
    const dataUrl = `data:${mimeType};base64,${prediction.base64}`;
    const upload = await uploadBase64Image(
      dataUrl,
      product.id,
      `vertex_edit_${Date.now()}_${index}`
    );
    uploaded.push({
      url_or_base64: upload.url,
      source: 'ai-derived',
      variant: referenceImage.variant || 'other',
      notes: `Vertex AI edit based on ${referenceImage.source || 'reference'} (${referenceImage.notes || 'user selected'})`,
      width: upload.width,
      height: upload.height,
      mimeType: upload.mimeType,
    });
  }

  return uploaded;
}

module.exports = {
  generateImagesForProduct,
};
