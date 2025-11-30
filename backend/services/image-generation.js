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

function pickAttribute(product, candidates = []) {
  const attrs = product?.details?.attributes || {};
  const lowerMap = Object.keys(attrs).reduce((acc, key) => {
    acc[key.toLowerCase()] = attrs[key];
    return acc;
  }, {});
  for (const candidate of candidates) {
    const value = lowerMap[candidate.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function buildPromptTemplates(product) {
  const titleParts = [
    product.identification?.brand,
    product.identification?.name,
    product.identification?.category,
  ]
    .map(sanitizeSentence)
    .filter(Boolean);

  const identity = titleParts.join(' ').trim() || 'Product';
  const sku = product.identification?.sku || product.details?.identifiers?.sku;

  const keyFeatures = (product.details?.key_features || []).map(sanitizeSentence).filter(Boolean).slice(0, 4);

  const highlightAttributes = Object.entries(product.details?.attributes || {})
    .filter(([key, value]) => Boolean(key) && value !== null && value !== undefined)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${value}`);

  const color = pickAttribute(product, ['farbe', 'color', 'primary color']);
  const material = pickAttribute(product, ['material', 'werkstoff', 'material type']);
  const dimensions = pickAttribute(product, ['abmessungen', 'dimensions', 'size']);

  const descriptorParts = [
    color ? `color: ${color}` : null,
    material ? `material: ${material}` : null,
    dimensions ? `dimensions: ${dimensions}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const sharedFacts = [
    `Subject: ${identity}`,
    descriptorParts ? `Details: ${descriptorParts}` : null,
    keyFeatures.length ? `Features: ${keyFeatures.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  // Premium Studio Prompt (Variation/Detail focused)
  const studioPrompt = [
    `High-end close-up 3/4 product photo of ${identity}.`,
    'Studio lighting with softbox overhead and gentle rim light to separate from background.',
    'Matte finish, ultra-sharp edges, extreme high resolution, razor-clean surface detail and texture.',
    'Elegant minimalist tone: no props, no text, clean negative space, neutral gray gradient background.',
    'Camera styling: 85mm-equivalent medium-telephoto perspective, f/8.0 for balanced depth of field.',
    sharedFacts,
  ]
    .filter(Boolean)
    .join(' ');

  // Premium Lifestyle Prompt (Context focused)
  const lifestylePrompt = [
    `Photorealistic lifestyle product shot of ${identity} being actively used in a natural environment suitable for this product.`,
    'Keep the product design exactly as shown.',
    'Balanced composition: subject occupies ~60% of frame, shallow depth of field with soft bokeh.',
    'Lighting: Natural daytime lighting, soft directional sunlight, true-to-life color temperature.',
    'Scene should convey quality, comfort, and everyday utility.',
    sharedFacts,
  ]
    .filter(Boolean)
    .join(' ');

  return { studioPrompt, lifestylePrompt };
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
  const { studioPrompt, lifestylePrompt } = buildPromptTemplates(product);
  const sampleCount = Number.isFinite(options.sampleCount) ? Math.min(Math.max(options.sampleCount, 1), 4) : 2;

  console.log(
    `Generating Vertex AI edits for ${product.id} using reference image (${referenceImage.source || 'unknown'})`
  );

  const runs = [
    // Studio: Use 'null' editMode to trigger Image Variation (allows angle changes, detail shots)
    // Note: This relies on our vertex-ai.js logic to pick the right model for variation.
    { prompt: studioPrompt, type: 'studio', count: Math.max(1, Math.round(sampleCount)), editMode: null },

    // Lifestyle: Use 'EDIT_MODE_BGSWAP' to preserve product identity strictly in new context
    { prompt: lifestylePrompt, type: 'lifestyle', count: Math.max(1, Math.round(sampleCount)), editMode: 'EDIT_MODE_BGSWAP' },
  ];

  const uploaded = [];
  const promptMap = { studio: studioPrompt, lifestyle: lifestylePrompt };

  for (const run of runs) {
    const predictions = await generateProductImages({
      prompt: run.prompt,
      count: run.count,
      aspectRatio: options.aspectRatio || '1:1',
      referenceImageBase64: referenceDataUrl,
      editMode: run.editMode,
    });

    for (const [index, prediction] of predictions.entries()) {
      if (!prediction?.base64) {
        continue;
      }
      const mimeType = prediction.mimeType || 'image/png';
      const dataUrl = `data:${mimeType};base64,${prediction.base64}`;
      const upload = await uploadBase64Image(
        dataUrl,
        product.id,
        `vertex_edit_${run.type}_${Date.now()}_${index}`
      );
      uploaded.push({
        url_or_base64: upload.url,
        source: 'ai-derived',
        variant: run.type,
        notes: `Vertex AI ${run.type} based on ${referenceImage.source || 'reference'} (${referenceImage.notes || 'user selected'})`,
        width: upload.width,
        height: upload.height,
        mimeType: upload.mimeType,
      });
    }
  }

  return { images: uploaded, prompts: promptMap };
}

module.exports = {
  generateImagesForProduct,
};
