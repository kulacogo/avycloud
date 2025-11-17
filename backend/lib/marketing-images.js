const {
  callSerpApi,
  summarizeSerpEntries,
  extractImageMeta,
  isLowResImage,
  MIN_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
} = require('./serpapi');

const QUALITY_MIN_WIDTH = parseInt(process.env.MARKETING_IMAGE_MIN_WIDTH || `${MIN_IMAGE_WIDTH}`, 10);
const QUALITY_MIN_HEIGHT = parseInt(process.env.MARKETING_IMAGE_MIN_HEIGHT || `${MIN_IMAGE_HEIGHT}`, 10);
const DEFAULT_IMAGE_LIMIT = parseInt(process.env.MARKETING_IMAGE_LIMIT || '12', 10);

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

async function fetchMarketingImages({ brand, name, limit = DEFAULT_IMAGE_LIMIT, exclude = [] }) {
  const baseQuery = [brand, name].filter(Boolean).join(' ').trim();
  if (!baseQuery) {
    return { images: [], trace: [] };
  }

  const seen = new Set();
  exclude
    .map((url) => normalizeUrlKey(url))
    .filter(Boolean)
    .forEach((key) => seen.add(key));

  const collected = [];
  const trace = [];
  const desired = Math.max(1, limit);

  const googleQueries = [
    `${baseQuery} marketing photo`,
    `${baseQuery} lifestyle`,
    `${baseQuery} hero image`,
  ];

  for (const query of googleQueries) {
    if (collected.length >= desired) break;
    const params = {
      q: query,
      tbs: 'isz:l,itp:photo',
      num: 20,
      ijn: collected.length > 0 ? 1 : 0,
    };
    const { images, trace: engineTrace } = await querySerpImages('google_images', params, desired - collected.length, query);
    images.forEach((img) => {
      const key = normalizeUrlKey(img.url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      collected.push(img);
    });
    trace.push(...engineTrace);
  }

  if (collected.length < desired) {
    const amazonQuery = `${baseQuery} Produktfoto`;
    const { images, trace: engineTrace } = await querySerpImages(
      'amazon',
      { query: amazonQuery, search_type: 'images', num: 20 },
      desired - collected.length,
      amazonQuery
    );
    images.forEach((img) => {
      const key = normalizeUrlKey(img.url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      collected.push(img);
    });
    trace.push(...engineTrace);
  }

  return {
    images: collected.slice(0, desired),
    trace,
  };
}

module.exports = {
  fetchMarketingImages,
};

