const {
  callSerpApi,
  summarizeSerpEntries,
  extractImageMeta,
  isLowResImage,
  MIN_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
} = require('./serpapi');
const { fetchWithUnlocker } = require('./web-unlocker');

const QUALITY_MIN_WIDTH = parseInt(process.env.MARKETING_IMAGE_MIN_WIDTH || `${MIN_IMAGE_WIDTH}`, 10);
const QUALITY_MIN_HEIGHT = parseInt(process.env.MARKETING_IMAGE_MIN_HEIGHT || `${MIN_IMAGE_HEIGHT}`, 10);
const DEFAULT_IMAGE_LIMIT = parseInt(process.env.MARKETING_IMAGE_LIMIT || '12', 10);
const IMAGE_PROBE_TIMEOUT_MS = parseInt(process.env.MARKETING_IMAGE_PROBE_TIMEOUT_MS || '5000', 10);
const IMAGE_PROBE_USER_AGENT = process.env.MARKETING_IMAGE_USER_AGENT || 'avystock-image-probe/1.0';
const IMAGE_VERIFY_MODE = (process.env.MARKETING_IMAGE_VERIFY_MODE || 'auto').toLowerCase(); // auto | strict | off

// Bright Data is optional; when it's not configured we must NOT drop all results.
let unlockerAvailable = null; // null unknown, true/false known

function normalizeUrlKey(url = '') {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase() || null;
  }
}

function meetsQuality(meta) {
  if (!meta?.url) return false;
  if (!meta.width && !meta.height) return true;
  if (meta.width && meta.width < QUALITY_MIN_WIDTH) return false;
  if (meta.height && meta.height < QUALITY_MIN_HEIGHT) return false;
  return true;
}

function mapEntryToImage(entry, fallbackSource) {
  const meta = entry.image_meta || extractImageMeta(entry);
  if (!meta?.url || isLowResImage(meta) || !meetsQuality(meta)) {
    return null;
  }
  return {
    url: meta.url,
    width: meta.width || null,
    height: meta.height || null,
    source: entry.source || fallbackSource,
    title: entry.title || entry.snippet || '',
    preview: entry.thumbnail || entry.image || null,
  };
}

async function querySerpImages(engine, params, limit, queryLabel) {
  const images = [];
  const trace = [];
  const data = await callSerpApi(engine, params);
  const summaries = summarizeSerpEntries(engine, data, limit * 3);
  summaries.forEach((entry) => {
    const image = mapEntryToImage(entry, engine);
    if (image) {
      images.push(image);
    }
  });

  if (images.length) {
    trace.push({
      engine,
      query: queryLabel || params.q || params.query || engine,
      images: images.slice(0, limit).map((img) => ({
        url: img.url,
        source: img.source,
        width: img.width,
        height: img.height,
      })),
    });
  }

  return { images, trace };
}

function buildReferer(url) {
  try {
    const target = new URL(url);
    return `${target.protocol}//${target.host}/`;
  } catch {
    return undefined;
  }
}

async function probeImageUrl(url, method = 'HEAD') {
  try {
    const target = new URL(url);
    const headers = {
      'User-Agent': IMAGE_PROBE_USER_AGENT,
      Accept: 'image/*,*/*;q=0.8',
    };
    const referer = buildReferer(url);
    if (referer) {
      headers.Referer = referer;
    }
    if (method === 'GET') {
      headers.Range = 'bytes=0-1023';
    }
    const result = await fetchWithUnlocker({
      url: target.toString(),
      method,
      format: 'raw',
      timeoutMs: IMAGE_PROBE_TIMEOUT_MS,
      headers,
    });
    if (!result.success) {
      return false;
    }
    unlockerAvailable = true;
    const contentType = result.contentType || '';
    if (!contentType.startsWith('image/')) {
      return false;
    }
    return true;
  } catch (error) {
    const msg = String(error?.message || '');
    // If BrightData is not configured, we must fail-open elsewhere (auto mode).
    if (msg.includes('BRIGHTDATA_API_TOKEN') || msg.includes('BRIGHTDATA_ZONE')) {
      unlockerAvailable = false;
    }
    return false;
  }
}

async function verifyAccessibleUrl(url) {
  if (!url) return null;
  if (IMAGE_VERIFY_MODE === 'off') return url;
  // In auto mode: when BrightData isn't configured, do NOT verify – return unverified URL.
  if (IMAGE_VERIFY_MODE === 'auto' && unlockerAvailable === false) return url;
  if (await probeImageUrl(url, 'HEAD')) return url;
  if (await probeImageUrl(url, 'GET')) return url;
  // If the probe set unlockerAvailable=false (token missing), fail-open in auto mode.
  if (IMAGE_VERIFY_MODE === 'auto' && unlockerAvailable === false) return url;
  return null;
}

async function pickAccessibleUrl(candidate) {
  const primary = await verifyAccessibleUrl(candidate.url);
  if (primary) {
    return primary;
  }
  if (candidate.preview) {
    const fallback = await verifyAccessibleUrl(candidate.preview);
    if (fallback) {
      return fallback;
    }
  }
  // Fail-open in AUTO mode: return the original candidate URL even when we can't probe it
  // (e.g. BrightData not configured or HEAD blocked). The UI can still preview it.
  if (IMAGE_VERIFY_MODE === 'auto') {
    return candidate.url || candidate.preview || null;
  }
  return null;
}

/**
 * Build a set of lowercase tokens from product name + category for relevance filtering.
 * Used to reject image results that clearly don't match the product (e.g. garden boxes for a recliner).
 */
function buildRelevanceTokens(name, category) {
  const raw = [name, category].filter(Boolean).join(' ');
  // Split on spaces, punctuation, special chars — keep tokens ≥ 3 chars
  const tokens = raw
    .toLowerCase()
    .split(/[\s,;>\/&°×+\-–—()[\]{}]+/)
    .map((t) => t.replace(/[^a-zäöüß0-9]/g, ''))
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

/**
 * Score how relevant an image result is to the product.
 * Returns 0..1 where 0 = no match, 1 = perfect match.
 * An image with score < threshold will be rejected.
 */
function scoreImageRelevance(imageTitle, relevanceTokens) {
  if (!imageTitle || relevanceTokens.size === 0) return 1; // No data → don't filter
  const titleLower = imageTitle.toLowerCase();
  const titleTokens = titleLower
    .split(/[\s,;>\/&°×+\-–—()[\]{}]+/)
    .map((t) => t.replace(/[^a-zäöüß0-9]/g, ''))
    .filter((t) => t.length >= 3);
  if (titleTokens.length === 0) return 0.5; // No parseable title → neutral

  let matches = 0;
  for (const token of relevanceTokens) {
    if (titleLower.includes(token)) matches++;
  }
  return relevanceTokens.size > 0 ? matches / relevanceTokens.size : 0.5;
}

const RELEVANCE_THRESHOLD = parseFloat(process.env.MARKETING_IMAGE_RELEVANCE_THRESHOLD || '0.15');

/**
 * Deduplicate brand from product name to avoid queries like "Upgrade4Cars Upgrade4Cars Autoabdeckung..."
 * If brand appears at the start of the name, strip it.
 */
function deduplicateBrandFromName(brand, name) {
  if (!brand || !name) return [brand, name].filter(Boolean).join(' ').trim();
  const brandLower = brand.toLowerCase().trim();
  const nameLower = name.toLowerCase().trim();
  // If name already starts with brand (exact or with separator), use name only
  if (nameLower.startsWith(brandLower)) {
    const rest = name.slice(brand.length).trim();
    // If stripping brand leaves a meaningful name, use brand + rest
    if (rest.length > 3) return `${brand} ${rest}`;
    // Otherwise just use name as-is (brand IS the name essentially)
    return name;
  }
  return `${brand} ${name}`.trim();
}

/**
 * Build a shorter query variant by stripping size/variant suffixes.
 * E.g. "Autoabdeckung Outdoor Vollgarage alle Jahreszeiten Universal Gr. L" → "Autoabdeckung Outdoor Vollgarage"
 * Strips: Gr. X, Größe X, Size X, Universal, Roman numerals as sizes, dimensions like 100x200
 */
function buildShortenedQuery(query) {
  if (!query) return '';
  let shortened = query
    // Strip size indicators: "Gr. L", "Gr. XL", "Größe 42", "Size M", etc.
    .replace(/\b(Gr\.?\s*[A-Z0-9]+|Größe\s*\S+|Size\s*\S+)\b/gi, '')
    // Strip dimension patterns: "86×80×107cm", "100x200", "50-60 l", "24 x 120 ml"
    .replace(/\b\d+\s*[x×]\s*\d+(\s*[x×]\s*\d+)?\s*(cm|mm|m|ml|l)?\b/gi, '')
    .replace(/\b\d+\s*-\s*\d+\s*(l|ml|cm|mm|kg|g)\b/gi, '')
    .replace(/\b\d+\s*(l|ml|cm|mm|kg|g|W|Watt)\b/gi, '')
    // Strip generic filler words: "Universal", "alle Jahreszeiten", "alle Farben"
    .replace(/\b(Universal|alle\s+\w+)\b/gi, '')
    // Strip set descriptions: "Set mit 24 x 120 ml", "3,00 l Schüssel"
    .replace(/\bSet\s+mit\s+[\d\s,x.]+\s*\w{0,3}\b/gi, '')
    // Clean up multiple spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Only return if meaningfully shorter than original (at least 20% shorter and > 5 chars)
  if (shortened.length < query.length * 0.85 && shortened.length > 5) {
    return shortened;
  }
  return '';
}

async function fetchMarketingImages({
  brand,
  name,
  category = '',
  identifiers = [],
  mpn = '',
  limit = DEFAULT_IMAGE_LIMIT,
  exclude = [],
} = {}) {
  // Deduplicate brand from name (prevents "Upgrade4Cars Upgrade4Cars Autoabdeckung...")
  const baseQuery = deduplicateBrandFromName(brand, name);
  if (!baseQuery) {
    return { images: [], trace: [] };
  }

  // Build shortened query variant for fallback (strips sizes, dimensions, filler)
  const shortQuery = buildShortenedQuery(baseQuery);

  // Category-enriched query: append category to disambiguate generic brands
  // e.g. "Bader Relaxsessel" → "Bader Relaxsessel Sofas & Sessel"
  const categoryClean = category ? String(category).trim() : '';
  const categoryQuery = categoryClean ? `${baseQuery} ${categoryClean}`.trim() : '';

  // Build relevance tokens from product name + category for filtering results
  const relevanceTokens = buildRelevanceTokens(name, categoryClean);

  const seen = new Set();
  exclude
    .map((url) => normalizeUrlKey(url))
    .filter(Boolean)
    .forEach((key) => seen.add(key));

  const collected = [];
  const trace = [];
  const desired = Math.max(1, limit);

  const uniq = (list) => Array.from(new Set(list.filter((v) => typeof v === 'string' && v.trim()))).map((v) => v.trim());

  const cleanIds = uniq(
    (Array.isArray(identifiers) ? identifiers : [])
      .map((v) => (v ? String(v).trim() : ''))
      .filter(Boolean)
  ).slice(0, 3);

  const mpnClean = mpn ? String(mpn).trim() : '';

  // Prefer very specific queries first (EAN/GTIN/MPN usually yields the most accurate product pages/images).
  // Category-enriched queries come before plain brand+name to get more relevant results.
  // Shortened query variants act as fallback when full title is too specific for Google Images.
  const googleQueries = uniq([
    ...cleanIds,
    ...(mpnClean ? [`${mpnClean}`, `${brand || ''} ${mpnClean}`.trim(), `${baseQuery} ${mpnClean}`.trim()] : []),
    ...(categoryQuery ? [categoryQuery] : []),
    baseQuery,
    ...(shortQuery ? [shortQuery] : []),
    ...(categoryQuery ? [`${categoryQuery} Produktfoto`] : []),
    `${baseQuery} Produktfoto`,
    ...(shortQuery ? [`${shortQuery} Produktfoto`] : []),
    `${baseQuery} Produktbilder`,
    `${baseQuery} Pressefoto`,
    `${baseQuery} marketing photo`,
    ...(shortQuery ? [`${shortQuery} marketing photo`] : []),
    `${baseQuery} lifestyle`,
    `${baseQuery} hero image`,
  ]);

  // ─── PERF: Parallel query batches + parallel URL probes ───
  // Helper: run a single SerpAPI query and probe all result URLs in parallel
  const SERP_BATCH_SIZE = parseInt(process.env.MARKETING_IMAGE_BATCH_SIZE || '3', 10);

  async function runQueryBatch(queries, engine, buildParams) {
    // Fire up to SERP_BATCH_SIZE queries in parallel
    const batchResults = await Promise.all(
      queries.map(async (query) => {
        try {
          const params = typeof buildParams === 'function' ? buildParams(query) : { q: query, num: 20 };
          const { images, trace: engineTrace } = await querySerpImages(engine, params, desired * 2, query);
          // Parallel URL probes for this batch
          const probed = await Promise.all(
            images.map(async (img) => {
              const relevance = scoreImageRelevance(img.title, relevanceTokens);
              if (relevance < RELEVANCE_THRESHOLD) return null;
              const accessibleUrl = await pickAccessibleUrl(img);
              if (!accessibleUrl) return null;
              return { ...img, url: accessibleUrl, relevance };
            })
          );
          return { images: probed.filter(Boolean), trace: engineTrace };
        } catch { return { images: [], trace: [] }; }
      })
    );
    // Collect results respecting dedup + desired limit
    for (const result of batchResults) {
      for (const img of result.images) {
        if (collected.length >= desired) break;
        const key = normalizeUrlKey(img.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(img);
      }
      trace.push(...result.trace);
    }
  }

  // Google Images: process in batches of SERP_BATCH_SIZE
  // First batch: strict quality (large photos), then relaxed
  for (let i = 0; i < googleQueries.length && collected.length < desired; i += SERP_BATCH_SIZE) {
    const batch = googleQueries.slice(i, i + SERP_BATCH_SIZE);
    await runQueryBatch(batch, 'google_images', (query) => ({
      q: query, tbs: 'isz:l,itp:photo', num: 20,
    }));
    if (collected.length >= desired) break;
    // Relaxed fallback for same batch
    await runQueryBatch(batch, 'google_images', (query) => ({
      q: query, tbs: 'itp:photo', num: 20,
    }));
  }

  if (collected.length < desired) {
    // Fallback: Bing Images — fire all queries in one batch
    const bingQueries = uniq([
      ...cleanIds,
      ...(mpnClean ? [`${brand || ''} ${mpnClean}`.trim(), `${baseQuery} ${mpnClean}`.trim()] : []),
      baseQuery,
    ]);
    await runQueryBatch(bingQueries, 'bing_images', (query) => ({
      q: query, count: 35,
    }));
  }

  if (collected.length < desired) {
    const amazonQuery = `${baseQuery} Produktfoto`;
    await runQueryBatch([amazonQuery], 'amazon', () => ({
      query: amazonQuery, search_type: 'images', num: 20,
    }));
  }

  // Sort by relevance (highest first) before returning
  collected.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  return {
    images: collected.slice(0, desired),
    trace,
  };
}

module.exports = {
  fetchMarketingImages,
  // Exported for testing
  buildRelevanceTokens,
  scoreImageRelevance,
  deduplicateBrandFromName,
  buildShortenedQuery,
};

