const { generateProductImages } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');
const { generateVisualDescriptions } = require('./prompt-engine');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

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

// Removed static buildPromptTemplates function in favor of prompt-engine.js

const VERTEX_REFERENCE_TIMEOUT_MS = parseInt(process.env.VERTEX_REFERENCE_TIMEOUT_MS || '20000', 10);

async function fetchImageAsDataUrl(image) {
  const value = image?.url_or_base64;
  if (!value) {
    throw new Error('Reference image payload is missing.');
  }

  if (value.startsWith('data:')) {
    return value;
  }

  if (/^https?:\/\//i.test(value)) {
    console.log(`Downloading reference image via Web Unlocker from ${value}`);
    const result = await fetchWithUnlocker({
      url: value,
      method: 'GET',
      format: 'raw',
      timeoutMs: VERTEX_REFERENCE_TIMEOUT_MS,
      headers: {
        'User-Agent': 'avystock-vertex-ref/1.0',
        Accept: 'image/*,*/*;q=0.8',
        Referer: '',
      },
    });
    if (!result.success) {
      throw new Error(result.error || 'Failed to download reference image');
    }
    const mimeType = result.contentType || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new Error(`Unexpected reference content-type ${mimeType}`);
    }
    const buffer = result.body_base64
      ? Buffer.from(result.body_base64, 'base64')
      : Buffer.from(result.body || '', 'binary');
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

  // Generate rich prompts using Gemini
  console.log(`Generating visual descriptions for ${product.id}...`);
  const prompts = await generateVisualDescriptions(product);

  const sampleCount = Number.isFinite(options.sampleCount) ? Math.min(Math.max(options.sampleCount, 1), 4) : 2;

  console.log(
    `Generating Vertex AI edits for ${product.id} using reference image (${referenceImage.source || 'unknown'})`
  );

  // Determine runs based on requested mode (default to studio + lifestyle if not specified)
  const requestedMode = options.mode || 'all'; // 'studio', 'lifestyle', 'detail', 'all'

  const runs = [];

  if (requestedMode === 'all' || requestedMode === 'studio') {
    runs.push({
      prompt: prompts.studio,
      type: 'studio',
      count: sampleCount,
      editMode: null // Variation (Imagen 2)
    });
  }

  if (requestedMode === 'all' || requestedMode === 'lifestyle') {
    runs.push({
      prompt: prompts.lifestyle,
      type: 'lifestyle',
      count: sampleCount,
      editMode: 'EDIT_MODE_BGSWAP' // Revert to BGSWAP to guarantee product identity (shape/design)
    });
  }

  if (requestedMode === 'detail') {
    runs.push({
      prompt: prompts.detail,
      type: 'detail',
      count: sampleCount,
      editMode: null // Variation (Imagen 2)
    });
  }

  const uploaded = [];
  // Map prompts to return object
  const promptMap = {
    studio: prompts.studio,
    lifestyle: prompts.lifestyle,
    detail: prompts.detail
  };

  for (const run of runs) {
    // We use the reference image for ALL modes to ensure product identity (shape/design) is preserved.
    // Imagen 2 (Variation) will use this as a strong guide while adapting the lighting/background.
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
