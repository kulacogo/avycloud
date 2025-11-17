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
const IMAGE_PROBE_TIMEOUT_MS = parseInt(process.env.MARKETING_IMAGE_PROBE_TIMEOUT_MS || '5000', 10);
const IMAGE_PROBE_USER_AGENT = process.env.MARKETING_IMAGE_USER_AGENT || 'avystock-image-probe/1.0';

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_PROBE_TIMEOUT_MS);
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

    const response = await fetch(target.toString(), {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function verifyAccessibleUrl(url) {
  if (!url) return null;
  if (await probeImageUrl(url, 'HEAD')) return url;
  if (await probeImageUrl(url, 'GET')) return url;
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
  return null;
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
    for (const img of images) {
      if (collected.length >= desired) break;
      const accessibleUrl = await pickAccessibleUrl(img);
      if (!accessibleUrl) continue;
      const key = normalizeUrlKey(accessibleUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...img, url: accessibleUrl });
    }
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
    for (const img of images) {
      if (collected.length >= desired) break;
      const accessibleUrl = await pickAccessibleUrl(img);
      if (!accessibleUrl) continue;
      const key = normalizeUrlKey(accessibleUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...img, url: accessibleUrl });
    }
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

