const { callSerpApi, summarizeSerpEntries, extractImageMeta, isLowResImage } = require('./serpapi');

/** Grund der letzten Stoerung, damit ein Ausfall meldbar ist. */
let letzterFehler = null;

function lastImageSearchError() {
  return letzterFehler;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_WIDTH = 600;
const DEFAULT_MIN_HEIGHT = 600;

function isSerpApiLikelyConfigured() {
  if (process.env.SERPAPI_KEY) return true;
  // In Cloud environments the key is typically loaded via Secret Manager.
  return Boolean(
    process.env.GCP_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT
  );
}

/**
 * Baut aus einer Suchanfrage stufenweise breitere Varianten.
 *
 * Gemessen gegen die echte SerpAPI (2026-08-16):
 *   "LIVARNO home Relaxsessel-Auflage 4052916309858"  ->  0 Treffer
 *   "LIVARNO home Relaxsessel-Auflage"                -> 96 Treffer
 *
 * Der Chat baut die Anfrage aus Marke + Name + EAN. Steht die EAN mit drin,
 * findet Google haeufig NICHTS — und der Code gab kommentarlos auf. Fuer den
 * Bediener sah es so aus, als koenne der Assistent keine Produktbilder mehr
 * finden.
 *
 * Kurze Zahlen bleiben stehen: "12V", "8000", "IZ201EU" gehoeren zum
 * Produktnamen. Nur lange, zusammenhaengende Ziffernfolgen (8+) sind
 * Kennnummern.
 */
function broadenImageQuery(query) {
  const roh = String(query || '').trim();
  if (!roh) return [];

  const stufen = [roh];

  // Stufe 2: lange Ziffernfolgen (EAN/GTIN/UPC) raus.
  const ohneKennnummern = roh.replace(/\b\d{8,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (ohneKennnummern && ohneKennnummern !== roh) stufen.push(ohneKennnummern);

  // Stufe 3: auf die ersten Woerter kuerzen (Marke + Produktbezeichnung).
  const basis = stufen[stufen.length - 1];
  const woerter = basis.split(/\s+/).filter(Boolean);
  if (woerter.length > 5) {
    const gekuerzt = woerter.slice(0, 5).join(' ');
    if (gekuerzt && !stufen.includes(gekuerzt)) stufen.push(gekuerzt);
  }

  return stufen.filter((s, i) => s && stufen.indexOf(s) === i);
}

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
/**
 * Sucht Produktbilder — mit stufenweiser Verbreiterung.
 *
 * Findet Google fuer die enge Anfrage nichts (haeufig, sobald die EAN mit
 * drinsteht), wird eine Stufe breiter erneut gesucht statt kommentarlos
 * aufzugeben. Belegt am 2026-08-16: mit EAN 0 Treffer, ohne EAN 96.
 */
async function searchProductImages(product, options = {}) {
  const ausgangsAnfrage = options.query || buildImageQuery(product);
  const stufen = broadenImageQuery(ausgangsAnfrage);
  if (!stufen.length) return [];

  // "Dienst gestoert" und "es gibt keine Bilder" sahen bisher identisch aus:
  // beides ergab einen leeren Array. Das Modell (und damit der Bediener) konnte
  // einen Ausfall nicht von einem echten Null-Ergebnis unterscheiden. Der
  // letzte Stoerungsgrund haengt jetzt am Ergebnis.
  letzterFehler = null;

  for (let i = 0; i < stufen.length; i += 1) {
    const treffer = await searchImagesOnce(product, { ...options, query: stufen[i] });
    if (treffer.length > 0) {
      if (i > 0) {
        console.log(`[image-search] Stufe ${i + 1} erfolgreich: "${stufen[i]}" (${treffer.length} Bilder)`);
      }
      return treffer;
    }
    if (i < stufen.length - 1) {
      console.log(`[image-search] "${stufen[i]}" ohne Treffer — versuche breiter: "${stufen[i + 1]}"`);
    }
  }
  return [];
}

async function searchImagesOnce(product, options = {}) {
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
  if (!isSerpApiLikelyConfigured()) {
    letzterFehler = 'Bildsuche ist nicht eingerichtet (kein Zugang hinterlegt).';
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
    letzterFehler = err.message || String(err);
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

  // Google meldet "hasn't returned any results" als FELD, nicht als Ausnahme —
  // der Bing-Ausweichweg unten lief deshalb nie an. Jetzt schon.
  const leer = data.error || !Array.isArray(data.images_results) || data.images_results.length === 0;
  if (leer && engine === 'google_images') {
    try {
      const bing = await callSerpApi('bing_images', { q: query });
      if (bing && Array.isArray(bing.images_results) && bing.images_results.length) {
        data = { ...bing, _engine: 'bing_images' };
      }
    } catch (bingErr) {
      console.warn(`[image-search] Bing-Ausweichweg fehlgeschlagen: ${bingErr.message}`);
    }
  }

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
  broadenImageQuery,
  lastImageSearchError,
  isSerpApiLikelyConfigured,
};
