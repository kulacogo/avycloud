const sharp = require('sharp');
const { generateProductImages } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');
const { generateVisualDescriptions } = require('./prompt-engine');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

const GENERATED_IMAGE_PATTERN = /(generated|gpt|gemini|vertex|ai[-\s]?image|ai[-\s]?render)/i;
const MAX_REFERENCE_BYTES = parseInt(process.env.VERTEX_REFERENCE_MAX_BYTES || '12000000', 10);
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

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

async function normalizeReferenceBuffer(buffer, mimeType = 'image/png') {
  let targetBuffer = buffer;
  let targetMime = (mimeType || '').toLowerCase();

  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(targetMime)) {
    // Convert unsupported formats (e.g., webp, gif) to PNG via sharp
    targetBuffer = await sharp(buffer).png({ quality: 92 }).toBuffer();
    targetMime = 'image/png';
  }

  if (targetBuffer.length > MAX_REFERENCE_BYTES) {
    throw new Error(`Reference image exceeds ${Math.floor(MAX_REFERENCE_BYTES / (1024 * 1024))} MB limit`);
  }

  return `data:${targetMime};base64,${targetBuffer.toString('base64')}`;
}

async function fetchImageAsDataUrl(image) {
  const value = image?.url_or_base64;
  if (!value) {
    throw new Error('Reference image payload is missing.');
  }

  if (value.startsWith('data:')) {
    const match = value.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
    if (!match?.groups?.data) {
      throw new Error('Invalid data URL reference image.');
    }
    const buffer = Buffer.from(match.groups.data, 'base64');
    return normalizeReferenceBuffer(buffer, match.groups.mime);
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
    return normalizeReferenceBuffer(buffer, mimeType);
  }

  throw new Error('Unsupported reference image format.');
}

const VARIANT_SPECS = [
  { group: 'studio', key: 'front', type: 'studio_front' },
  { group: 'studio', key: 'detail', type: 'studio_detail' },
  { group: 'studio', key: 'topdown', type: 'studio_topdown' },
  { group: 'lifestyle', key: 'front', type: 'lifestyle_front' },
  { group: 'lifestyle', key: 'closeup', type: 'lifestyle_closeup' },
  { group: 'lifestyle', key: 'inuse', type: 'lifestyle_inuse' },
];

function shouldIncludeVariant(mode, spec) {
  if (!mode || mode === 'all') return true;
  if (mode === 'studio') return spec.group === 'studio';
  if (mode === 'lifestyle') return spec.group === 'lifestyle';
  if (mode === 'detail') {
    return spec.key === 'detail' || spec.key === 'closeup';
  }
  return true;
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

  const sampleCount = Number.isFinite(options.sampleCount) ? Math.min(Math.max(options.sampleCount, 1), 4) : 1;

  console.log(
    `Generating Gemini renders for ${product.id} using reference image (${referenceImage.source || 'unknown'})`
  );

  const requestedMode = options.mode || 'all'; // 'studio', 'lifestyle', 'detail', 'all'

  const runs = VARIANT_SPECS.map((spec) => ({
    ...spec,
    prompt: prompts?.[spec.group]?.[spec.key],
    count: sampleCount,
    editMode: null,
  }))
    .filter((run) => Boolean(run.prompt) && shouldIncludeVariant(requestedMode, run));

  const uploaded = [];
  const promptMap = prompts;

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
        `gemini_render_${run.type}_${Date.now()}_${index}`
      );
      uploaded.push({
        url_or_base64: upload.url,
        source: 'ai-derived',
        variant: run.type,
        notes: `Gemini ${run.type} (${run.group}/${run.key}) based on ${referenceImage.source || 'reference'} (${referenceImage.notes || 'user selected'})`,
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
