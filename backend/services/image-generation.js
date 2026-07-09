const sharp = require('sharp');
const { generateProductImages } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');
const { generateVisualDescriptions } = require('./prompt-engine');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const { compositeOnGradient } = require('../lib/background-removal');

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

/**
 * Download a reference image with a plain GET. Our own GCS/CDN images are public
 * and don't need (nor reliably work through) the Web Unlocker proxy. Returns a
 * size-checked data URL, or throws on any non-2xx / non-image response.
 */
async function fetchReferenceDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERTEX_REFERENCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'avystock-vertex-ref/1.0',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new Error(`unexpected content-type ${mimeType || 'unknown'}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error('empty response body');
    }
    return normalizeReferenceBuffer(buffer, mimeType);
  } finally {
    clearTimeout(timer);
  }
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
    // Public/own images (GCS, CDNs) are directly fetchable — a plain GET works
    // and avoids the fragile + billed scraping proxy. Only fall back to the Web
    // Unlocker for hosts that actively block datacenter IPs (e.g. Amazon pages).
    try {
      return await fetchReferenceDirect(value);
    } catch (directErr) {
      console.warn(`Direct reference download failed (${directErr.message}); trying Web Unlocker: ${value}`);
    }

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
  // 4 studio packshots: hero 3/4, side angle, detail close-up, rear view
  { group: 'studio', key: 'front', type: 'studio_front' },
  { group: 'studio', key: 'angle', type: 'studio_angle' },
  { group: 'studio', key: 'detail', type: 'studio_detail' },
  { group: 'studio', key: 'back', type: 'studio_back' },
];

function normalizeImageKey(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // Keep it simple; we only need dedupe across identical URLs.
  return raw.replace(/\s+/g, '').toLowerCase();
}

function collectReferenceCandidates(product, primaryReference) {
  const out = [];
  const seen = new Set();

  const push = (img) => {
    const url = img?.url_or_base64;
    if (!url || typeof url !== 'string') return;
    const key = normalizeImageKey(url);
    if (!key || seen.has(key)) return;
    if (isLikelyAiImage(img)) return;
    seen.add(key);
    out.push(img);
  };

  // 1) User-selected/explicit reference first (if it's a real image)
  if (primaryReference && typeof primaryReference === 'object') {
    push(primaryReference);
  }

  // 2) Fill up from existing real product images (different perspectives come from real photos)
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  for (const img of images) {
    push(img);
    if (out.length >= 4) break;
  }

  return out;
}

function shouldIncludeVariant(mode, spec) {
  if (!mode || mode === 'all') return true;
  if (mode === 'studio') return spec.group === 'studio';
  if (mode === 'lifestyle') return spec.group === 'lifestyle';
  if (mode === 'detail') {
    return spec.key === 'detail' || spec.key === 'closeup';
  }
  return true;
}

/**
 * Detects gradient style based on product color (matches prompt-engine logic).
 */
function detectGradientStyle(product) {
  const attrs = product?.details?.attributes || {};
  const colorKeys = ['Color', 'Farbe', 'Colour', 'Primary Color', 'Hauptfarbe'];
  let color = '';
  for (const key of colorKeys) {
    if (attrs[key]) { color = String(attrs[key]).toLowerCase(); break; }
  }
  if (!color) {
    const fallback = Object.keys(attrs).find((k) => k.toLowerCase().includes('color') || k.toLowerCase().includes('farbe'));
    if (fallback) color = String(attrs[fallback]).toLowerCase();
  }
  const darkTokens = ['black', 'dark', 'anthracite', 'charcoal', 'graphite', 'navy', 'schwarz', 'dunkel'];
  return darkTokens.some((t) => color.includes(t)) ? 'white' : 'white';
}

/**
 * Primary method: Remove background from real photo → composite on studio gradient.
 * Returns a single hero image (studio_front variant).
 */
async function tryBackgroundRemoval(imageBuffer, product) {
  const gradientStyle = detectGradientStyle(product);
  const result = await compositeOnGradient(imageBuffer, {
    gradientStyle,
    outputWidth: 1024,
    outputHeight: 1024,
    padding: 0.08,
  });
  return result;
}

async function generateImagesForProduct(product, options = {}) {
  if (!product?.id) {
    throw new Error('Product ID is required');
  }

  const { referenceImage, skipBackgroundRemoval = false } = options;
  const referenceCandidates = collectReferenceCandidates(product, referenceImage).slice(0, 4);
  if (!referenceCandidates.length) {
    throw new Error('At least one real reference image is required');
  }

  // 1) Prompts (needed for Gemini fallback)
  const prompts = await generateVisualDescriptions(product);

  // 2) References → data URLs (PNG/JPEG, size-checked)
  const referenceDataUrls = [];
  const referenceBuffers = [];
  for (const img of referenceCandidates) {
    try {
      const dataUrl = await fetchImageAsDataUrl(img);
      if (dataUrl) {
        referenceDataUrls.push(dataUrl);
        // Extract buffer for background removal
        const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (match) referenceBuffers.push(Buffer.from(match[1], 'base64'));
      }
    } catch (e) {
      // best-effort: skip broken URLs, but surface WHY (this was silently
      // swallowed before, hiding the Web-Unlocker failure — Incident 2026-07-09).
      console.warn(`Reference download failed for ${img?.url_or_base64 || 'unknown'}: ${e.message}`);
    }
  }
  if (!referenceDataUrls.length) {
    throw new Error('Reference images could not be downloaded');
  }

  const generated = [];

  // 3a) PRIMARY: Background removal on hero image (studio_front)
  if (!skipBackgroundRemoval && referenceBuffers.length > 0) {
    try {
      const bgResult = await tryBackgroundRemoval(referenceBuffers[0], product);
      const base64DataUrl = `data:image/png;base64,${bgResult.buffer.toString('base64')}`;
      const uploaded = await uploadBase64Image(base64DataUrl, product.id, 'studio_front');
      generated.push({
        url_or_base64: uploaded.url,
        variant: 'studio_front',
        source: 'background_removal',
        notes: 'Background removed and composited on studio gradient',
        width: uploaded.width || bgResult.width,
        height: uploaded.height || bgResult.height,
        mimeType: 'image/png',
      });
      console.log(`Background removal succeeded for product ${product.id}`);
    } catch (bgErr) {
      console.warn(`Background removal failed for ${product.id}, falling back to Gemini:`, bgErr.message);
    }
  }

  // 3b) FALLBACK: Gemini generation for remaining variants (or all if BG removal failed)
  const primaryReferenceDataUrl = referenceDataUrls[0];
  const variants = VARIANT_SPECS;

  for (let i = 0; i < variants.length; i += 1) {
    const spec = variants[i];
    // Skip variants already generated by background removal
    if (generated.some((g) => g.variant === spec.type)) continue;

    const prompt =
      prompts?.[spec.group]?.[spec.key] ||
      prompts?.[spec.group]?.front ||
      prompts?.studio?.front;
    if (!prompt) continue;

    try {
      const images = await generateProductImages({
        prompt,
        count: 1,
        aspectRatio: '1:1',
        referenceImageBase64: primaryReferenceDataUrl,
      });

      for (const img of images) {
        if (!img?.base64) continue;
        const mimeType = img.mimeType || 'image/png';
        const base64DataUrl = `data:${mimeType};base64,${img.base64}`;
        const uploaded = await uploadBase64Image(base64DataUrl, product.id, spec.type);
        generated.push({
          url_or_base64: uploaded.url,
          variant: spec.type,
          source: 'generated',
          notes: 'Generated by Gemini image model',
          width: uploaded.width || null,
          height: uploaded.height || null,
          mimeType: uploaded.mimeType || mimeType,
        });
      }
    } catch (genErr) {
      console.warn(`Gemini generation failed for ${product.id} variant ${spec.type}:`, genErr.message);
    }
  }

  return { images: generated.slice(0, 4), prompts };
}

module.exports = {
  generateImagesForProduct,
  fetchImageAsDataUrl,
};
