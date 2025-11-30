const fetch = require('node-fetch');
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

  const identity = titleParts.join(' ').trim() || 'Produkt';
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
    `Product: ${identity}${sku ? ` (SKU ${sku})` : ''}`,
    descriptorParts ? `Physical details: ${descriptorParts}` : null,
    keyFeatures.length ? `Key features: ${keyFeatures.join('; ')}` : null,
    highlightAttributes.length ? `Important specs: ${highlightAttributes.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  const studioPrompt = [
    `Detailed close-up 3/4 view product-style photograph of ${identity}.`,
    'Fashion-studio aesthetic with a smooth neutral gray gradient backdrop and soft floor spotlight transition.',
    'Use large softbox overhead/front-left, gentle fill from front-right, subtle rim light to separate the product from the background.',
    'Emphasize material fidelity and micro-detail: visible texture, accurate specular highlights, soft specular falloff, crisp contact shadows beneath legs/edges.',
    'Elegant minimalist tone: no props, no logos, no text, no distractions, clean negative space.',
    sharedFacts,
  ]
    .filter(Boolean)
    .join(' ');

  const lifestylePrompt = [
    'Photorealistic lifestyle scene for e-commerce featuring the product in a real-world usage context.',
    'Show authentic people interacting with the product naturally (no alterations to product geometry).',
    'Balanced composition: subject occupies ~60% of frame, shallow depth of field with soft bokeh in background.',
    'Lighting: late afternoon daylight, warm soft highlights, true-to-life skin tones, accurate color balance and textures.',
    'Scene should convey quality and everyday utility; include subtle branded items (bags, cups) without obscuring the product.',
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
    { prompt: studioPrompt, type: 'studio', count: Math.max(1, Math.round(sampleCount)) },
    { prompt: lifestylePrompt, type: 'lifestyle', count: Math.max(1, Math.round(sampleCount)) },
  ];

  const uploaded = [];
  const promptMap = { studio: studioPrompt, lifestyle: lifestylePrompt };

  for (const run of runs) {
    const predictions = await generateProductImages({
      prompt: run.prompt,
      count: run.count,
      aspectRatio: options.aspectRatio || '1:1',
      referenceImageBase64: referenceDataUrl,
      editMode: options.editMode || 'EDIT_MODE_BGSWAP',
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
