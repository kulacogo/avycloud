'use strict';

// Image-Quality-Gate for product listings.
// Uses sharp for local analysis — no external API calls.
// Graceful fallback when sharp is not installed.

const MIN_WIDTH = 500;
const MIN_HEIGHT = 500;
const RECOMMENDED_WIDTH = 1200;
const RECOMMENDED_HEIGHT = 1200;
const MAX_IMAGES = 12;

/**
 * tryRequire — never throws, returns null if module is missing.
 */
function tryRequire(name) {
  try {
    return require(name);
  } catch (_e) {
    return null;
  }
}

/**
 * Analyze a single image buffer and return quality metrics.
 *
 * @param {Buffer} buffer
 * @param {object} [options] — { computeHash?: true }
 * @returns {Promise<object>}
 */
async function analyzeImage(buffer, options = {}) {
  const sharp = tryRequire('sharp');
  if (!sharp) {
    return {
      _noSharp: true,
      width: 0,
      height: 0,
      pixelCount: 0,
      aspectRatio: 0,
      meetsMinResolution: false,
      meetsRecommendedResolution: false,
      backgroundType: 'unknown',
      backgroundScore: 0,
      isLikelyStockPhoto: false,
      hash: '',
      qualityScore: 0,
      issues: ['sharp_not_installed'],
    };
  }

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      width: 0,
      height: 0,
      pixelCount: 0,
      aspectRatio: 0,
      meetsMinResolution: false,
      meetsRecommendedResolution: false,
      backgroundType: 'unknown',
      backgroundScore: 0,
      isLikelyStockPhoto: false,
      hash: '',
      qualityScore: 0,
      issues: ['invalid_buffer'],
    };
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    return {
      width: 0,
      height: 0,
      pixelCount: 0,
      aspectRatio: 0,
      meetsMinResolution: false,
      meetsRecommendedResolution: false,
      backgroundType: 'unknown',
      backgroundScore: 0,
      isLikelyStockPhoto: false,
      hash: '',
      qualityScore: 0,
      issues: ['decode_failed'],
      _error: err?.message || 'decode failed',
    };
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;

  // 1. Resolution checks
  const meetsMin = width >= MIN_WIDTH && height >= MIN_HEIGHT;
  const meetsRec = width >= RECOMMENDED_WIDTH && height >= RECOMMENDED_HEIGHT;

  // 2. Background analysis — downsample to 32x32 RGB raw for fast sampling
  let backgroundResult = { backgroundType: 'unknown', backgroundScore: 0, variance: 0 };
  try {
    const downsampled = await sharp(buffer)
      .resize(32, 32, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    backgroundResult = analyzeBackground(downsampled.data, downsampled.info);
  } catch (_e) {
    // keep default unknown background
  }

  // 3. Perceptual hash — aHash: 8x8 greyscale, bit per pixel vs mean
  let hash = '';
  if (options.computeHash !== false) {
    try {
      const small = await sharp(buffer)
        .resize(8, 8, { fit: 'fill' })
        .greyscale()
        .removeAlpha()
        .raw()
        .toBuffer();
      const avg = small.reduce((s, v) => s + v, 0) / small.length;
      const bits = Array.from(small).map((v) => (v > avg ? '1' : '0')).join('');
      try {
        hash = BigInt('0b' + bits).toString(16).padStart(16, '0');
      } catch (_bigIntErr) {
        hash = '';
      }
    } catch (_e) {
      hash = '';
    }
  }

  // 4. Stock-photo heuristic — loose match of typical stock dimensions combined with
  //    near-uniform white background. Precedence: operators use parens to prevent
  //    the `&&` / `||` surprise.
  const isStockDimension = (width === 1920 && height === 1280) || (width === 1500 && height === 1000);
  const isStock = Boolean(backgroundResult.backgroundScore > 0.85 && isStockDimension);

  // 5. Issues
  const issues = [];
  if (!meetsMin) issues.push('low_resolution');
  if (backgroundResult.backgroundType === 'colored') issues.push('colored_background');
  if (isStock) issues.push('likely_stock_photo');

  // 6. Overall quality score
  let score = 0;
  score += meetsMin ? 0.4 : 0.1;
  score += meetsRec ? 0.2 : 0;
  score += (backgroundResult.backgroundScore || 0) * 0.3;
  score += isStock ? 0 : 0.1;

  const aspectRatio = height > 0 ? width / height : 0;

  return {
    width,
    height,
    pixelCount: width * height,
    aspectRatio,
    meetsMinResolution: meetsMin,
    meetsRecommendedResolution: meetsRec,
    backgroundType: backgroundResult.backgroundType,
    backgroundScore: backgroundResult.backgroundScore,
    isLikelyStockPhoto: isStock,
    hash,
    qualityScore: Math.min(score, 1),
    issues,
  };
}

/**
 * Analyze raw RGB buffer for background uniformity.
 * Samples 4 corners (10x10 each), computes mean + variance.
 */
function analyzeBackground(rgbBuffer, info) {
  const width = info?.width || 0;
  const height = info?.height || 0;
  const channels = info?.channels || 3;

  if (!rgbBuffer || width < 4 || height < 4) {
    return { backgroundType: 'unknown', backgroundScore: 0, meanRGB: [0, 0, 0], variance: 0 };
  }

  const cornerSize = Math.min(10, Math.floor(Math.min(width, height) / 3));
  const corners = [
    sampleRegion(rgbBuffer, 0, 0, cornerSize, cornerSize, width, channels),
    sampleRegion(rgbBuffer, width - cornerSize, 0, cornerSize, cornerSize, width, channels),
    sampleRegion(rgbBuffer, 0, height - cornerSize, cornerSize, cornerSize, width, channels),
    sampleRegion(rgbBuffer, width - cornerSize, height - cornerSize, cornerSize, cornerSize, width, channels),
  ];

  const meanR = corners.reduce((s, c) => s + c[0], 0) / corners.length;
  const meanG = corners.reduce((s, c) => s + c[1], 0) / corners.length;
  const meanB = corners.reduce((s, c) => s + c[2], 0) / corners.length;

  const variance = corners.reduce(
    (s, c) => s + Math.pow(c[0] - meanR, 2) + Math.pow(c[1] - meanG, 2) + Math.pow(c[2] - meanB, 2),
    0,
  ) / corners.length;

  const isWhite = meanR > 230 && meanG > 230 && meanB > 230;
  const isNeutral = meanR > 180 && meanG > 180 && meanB > 180
    && Math.abs(meanR - meanG) < 20
    && Math.abs(meanG - meanB) < 20;

  let type;
  let score;
  if (variance > 500) {
    type = 'colored';
    score = 0.3;
  } else if (isWhite) {
    type = 'white';
    score = 1.0;
  } else if (isNeutral) {
    type = 'neutral';
    score = 0.7;
  } else {
    type = 'colored';
    score = 0.4;
  }

  return {
    backgroundType: type,
    backgroundScore: score,
    meanRGB: [meanR, meanG, meanB],
    variance,
  };
}

function sampleRegion(buffer, x, y, w, h, imgWidth, channels) {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const yStart = Math.max(0, Math.floor(y));
  const xStart = Math.max(0, Math.floor(x));
  const yEnd = Math.max(yStart, Math.floor(y + h));
  const xEnd = Math.max(xStart, Math.floor(x + w));
  for (let j = yStart; j < yEnd; j++) {
    for (let i = xStart; i < xEnd; i++) {
      const idx = (j * imgWidth + i) * channels;
      sumR += buffer[idx] || 0;
      sumG += buffer[idx + 1] || 0;
      sumB += buffer[idx + 2] || 0;
      count++;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [sumR / count, sumG / count, sumB / count];
}

/**
 * Filters a list of images by quality, dedupes by perceptual hash, returns top N.
 *
 * @param {Array<{buffer?: Buffer, url?: string, source?: string, analysis?: object}>} images
 * @param {{maxImages?: number, minQualityScore?: number}} [opts]
 */
function filterImagesByQuality(images, opts = {}) {
  const maxImages = typeof opts.maxImages === 'number' ? opts.maxImages : MAX_IMAGES;
  const minQualityScore = typeof opts.minQualityScore === 'number' ? opts.minQualityScore : 0.4;

  if (!Array.isArray(images)) return [];

  // 1. Dedup by hash (keep first). Fallback to url / random when hash missing.
  const seen = new Set();
  const dedup = [];
  for (const img of images) {
    const hash = img?.analysis?.hash;
    const key = hash && hash.length > 0 ? `h:${hash}` : (img?.url ? `u:${img.url}` : `r:${Math.random()}`);
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(img);
    }
  }

  // 2. Quality filter
  const filtered = dedup.filter((img) => (img?.analysis?.qualityScore || 0) >= minQualityScore);

  // 3. Sort by quality score desc
  filtered.sort((a, b) => (b?.analysis?.qualityScore || 0) - (a?.analysis?.qualityScore || 0));

  // 4. Cap
  return filtered.slice(0, Math.max(0, maxImages));
}

module.exports = {
  analyzeImage,
  analyzeBackground,
  filterImagesByQuality,
  MIN_WIDTH,
  MIN_HEIGHT,
  RECOMMENDED_WIDTH,
  RECOMMENDED_HEIGHT,
  MAX_IMAGES,
};
