const { callSerpApi, summarizeSerpEntries, extractImageMeta, isLowResImage } = require('./serpapi');

const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_WIDTH = 600;
const DEFAULT_MIN_HEIGHT = 600;

/**
 * Builds a search query from product identification data.
 * Uses brand + name + barcode for best specificity.
 */
function buildImageQuery(product) {
  const parts = [];
  const brand = (product?.identification?.brand || '').trim();
  const name = (product?.identification?.name || '').trim();
  const barcodes = product?.identification?.barcodes || [];
  const mpn = (product?.details?.identifiers?.mpn || '').trim();

  if (brand) parts.push(brand);
  if (name) parts.push(name);

  // Add barcode/MPN for specificity if name is generic
  if (barcodes.length && name.split(/\s+/).length <= 3) {
    parts.push(barcodes[0]);
  } else if (mpn && !parts.some((p) => p.includes(mpn))) {
    parts.push(mpn);
  }

  return parts.join(' ').trim() || null;
}

/**
 * Normalizes a URL for deduplication.
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\s+/g, '');
  }
}

/**
 * Searches for product images using SerpAPI Google Images engine.
 *
 * @param {Object} product - Product object with identification data
 * @param {Object} options
 * @param {string} options.query - Override search query
 * @param {string} options.engine - SerpAPI engine ('google_images' | 'bing_images', default: 'google_images')
 * @param {number} options.limit - Max results (default 8)
 * @param {number} options.minWidth - Min image width (default 600)
 * @param {number} options.minHeight - Min image height (default 600)
 * @param {string} options.locale - Locale for search (default 'de')
 * @returns {Promise<Array<{url: string, width: number|null, height: number|null, source: string, title: string}>>}
 */
async function searchProductImages(product, options = {}) {
  const {
    query: queryOverride,
    engine = 'google_images',
    limit = DEFAULT_LIMIT,
    minWidth = DEFAULT_MIN_WIDTH,
    minHeight = DEFAULT_MIN_HEIGHT,
    locale = 'de',
  } = options;

  const query = queryOverride || buildImageQuery(product);
  if (!query) {
    return [];
  }

  const params = {
    q: query,
    gl: locale === 'de' || locale === 'de-DE' ? 'de' : 'us',
    hl: locale === 'de' || locale === 'de-DE' ? 'de' : 'en',
  };

  // For google_images, request large images only
  if (engine === 'google_images') {
    params.tbs = 'isz:l';
  }

  let data;
  try {
    data = await callSerpApi(engine, params);
  } catch (err) {
    console.error(`[image-search] SerpAPI ${engine} failed for "${query}":`, err.message);
    // Fallback to bing_images if google fails
    if (engine === 'google_images') {
      try {
        data = await callSerpApi('bing_images', { q: query });
      } catch (fallbackErr) {
        console.error(`[image-search] Bing fallback also failed:`, fallbackErr.message);
        return [];
      }
    } else {
      return [];
    }
  }

  if (!data) return [];

  // Extract image results
  const usedEngine = data._engine || engine;
  const entries = summarizeSerpEntries(usedEngine === 'bing_images' ? 'bing_images' : engine, data, limit * 2);

  // Filter & deduplicate
  const seen = new Set();
  const results = [];

  for (const entry of entries) {
    if (results.length >= limit) break;

    const url = entry.image_meta?.url || entry.url || entry.thumbnail;
    if (!url || typeof url !== 'string') continue;
    if (!/^https?:\/\//i.test(url)) continue;

    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);

    const width = entry.image_meta?.width || null;
    const height = entry.image_meta?.height || null;

    // Skip low-res images
    if (width && width < minWidth) continue;
    if (height && height < minHeight) continue;

    results.push({
      url,
      width,
      height,
      source: entry.source || 'web_search',
      title: entry.title || '',
      snippet: entry.snippet || '',
    });
  }

  return results;
}

module.exports = {
  searchProductImages,
  buildImageQuery,
};
