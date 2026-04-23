'use strict';

/**
 * Atomic Product-Research Tools for Gemini Function-Calling.
 *
 * Rationale (Anthropic research): Hallucination rate scales with tool-catalog
 * size AND with generic-ness of tools. Replacing a single generic
 * `web_search(query)` tool with 7 atomic, Poka-Yoke-shaped tools (`lookup_gtin`,
 * `get_required_aspects`, etc.) reduces argument-mixing errors and makes LLM
 * behaviour more predictable.
 *
 * Each executor returns a uniform response shape:
 *   {
 *     ok: boolean,
 *     source: string,      // the tool name
 *     data: any,           // tool-specific payload
 *     confidence: number,  // 0..1 self-assessed
 *     meta: { durationMs, tokensUsed?, rateLimited? },
 *     error?: { code, message },
 *   }
 *
 * All executors:
 *   - never throw — return `{ ok: false, error }` instead
 *   - never take >15s (internal timeout wrapper)
 *   - only REQUIRE existing lib modules; when a dep is missing they degrade
 *     gracefully with code `NOT_IMPLEMENTED`.
 */

const EXECUTOR_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.ATOMIC_TOOLS_TIMEOUT_MS || '15000', 10)
);

// ---------------------------------------------------------------------------
// Lazy-require helpers — keeps this module load-safe even when optional deps
// (e.g. ean-database, gpsr-manufacturer-registry) are missing.
// ---------------------------------------------------------------------------
function tryRequire(modPath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(modPath);
  } catch (err) {
    console.warn(`[atomic-tools] optional dependency missing: ${modPath} — ${err.message}`);
    return null;
  }
}

function isValidGtinDigits(value) {
  if (!value) return false;
  const digits = String(value).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  // Light structural check — full checksum lives in lib/gtin.js when present.
  const gtinLib = tryRequire('../lib/gtin');
  if (gtinLib && typeof gtinLib.isValidGtin === 'function') {
    return gtinLib.isValidGtin(digits);
  }
  return /^\d+$/.test(digits);
}

async function withTimeout(promise, ms, label) {
  let timer;
  // Attach a .catch to the source promise BEFORE racing — this ensures that
  // if `promise` rejects AFTER the timeout already won the race, the late
  // rejection is silently absorbed rather than bubbling as UnhandledPromise-
  // Rejection. Without this, repeated late-rejections cascade through Node's
  // rejection handler and produce "RangeError: Maximum call stack size
  // exceeded" in PromiseRejectCallback.
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // handle orphan rejection without blocking
  try {
    return await Promise.race([
      guarded,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function success(source, data, { confidence = 0.8, meta = {} } = {}) {
  return {
    ok: true,
    source,
    data,
    confidence,
    meta,
  };
}

function failure(source, code, message, { meta = {} } = {}) {
  return {
    ok: false,
    source,
    data: null,
    confidence: 0,
    meta,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Function Declarations (Gemini @google/genai compatible shape)
// ---------------------------------------------------------------------------

const lookupGtinDeclaration = {
  name: 'lookup_gtin',
  description:
    'Look up product information by GTIN/EAN/UPC barcode. Returns brand, ' +
    'model, category, images, specifications from multiple product databases. ' +
    'Use when you have a barcode and need structured product data.',
  parameters: {
    type: 'object',
    properties: {
      gtin: {
        type: 'string',
        description: 'The GTIN/EAN/UPC barcode (8, 12, 13, or 14 digits)',
      },
      locale: {
        type: 'string',
        description: 'Optional locale hint (e.g. "de-DE")',
      },
    },
    required: ['gtin'],
  },
};

const searchEbayCatalogDeclaration = {
  name: 'search_ebay_catalog',
  description:
    'Search eBay Catalog by GTIN or title. Returns eBay category id, ' +
    'suggested title, existing catalog entry, sample aspects. Use when you ' +
    'need eBay-specific structured data.',
  parameters: {
    type: 'object',
    properties: {
      gtin: {
        type: 'string',
        description: 'GTIN/EAN for exact match',
      },
      query: {
        type: 'string',
        description: 'Free-text query for fuzzy match',
      },
      marketplace: {
        type: 'string',
        enum: ['EBAY_DE', 'EBAY_COM'],
        default: 'EBAY_DE',
      },
    },
  },
};

const getRequiredAspectsDeclaration = {
  name: 'get_required_aspects',
  description:
    'Get the list of required/recommended/optional Item Specifics for a ' +
    'specific eBay category. Use BEFORE filling item_specifics to know which ' +
    'fields are mandatory.',
  parameters: {
    type: 'object',
    properties: {
      categoryId: {
        type: 'string',
        description: 'eBay category id (leaf node)',
      },
      marketplace: {
        type: 'string',
        default: 'EBAY_DE',
      },
    },
    required: ['categoryId'],
  },
};

const verifyBrandDeclaration = {
  name: 'verify_brand',
  description:
    'Verify that brand name + MPN combination exists (GS1 / manufacturer ' +
    'registry). Returns canonical brand name, manufacturer address, GPSR ' +
    'data if available. Use to resolve typos or aliases.',
  parameters: {
    type: 'object',
    properties: {
      brand: { type: 'string' },
      mpn: { type: 'string' },
    },
    required: ['brand'],
  },
};

const searchAmazonProductDeclaration = {
  name: 'search_amazon_product',
  description:
    'Search Amazon for a product by ASIN, GTIN, or title. Returns Amazon ' +
    'product page, price, reviews count, specifications. Use for ' +
    'cross-referencing pricing and completeness.',
  parameters: {
    type: 'object',
    properties: {
      asin: {
        type: 'string',
        description: 'Amazon ASIN (e.g. B08L5WHFT9)',
      },
      gtin: { type: 'string' },
      query: { type: 'string' },
      region: {
        type: 'string',
        enum: ['DE', 'COM'],
        default: 'DE',
      },
    },
  },
};

const searchManufacturerSiteDeclaration = {
  name: 'search_manufacturer_site',
  description:
    "Search the manufacturer's official website for product specifications. " +
    'Use to get authoritative specs, manual PDFs, warranty info. Falls back ' +
    'to Google site: query if manufacturer site not known.',
  parameters: {
    type: 'object',
    properties: {
      brand: { type: 'string' },
      model: { type: 'string' },
      mpn: { type: 'string' },
    },
    required: ['brand'],
  },
};

const fetchUrlContentDeclaration = {
  name: 'fetch_url_content',
  description:
    'Fetch and extract main text content from a URL. Use when Google Search ' +
    'returned a promising URL. Supports HTML, PDF, JSON. Max 34MB per URL.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'HTTPS URL',
      },
      extractImages: {
        type: 'boolean',
        default: false,
      },
    },
    required: ['url'],
  },
};

const searchEbaySoldDeclaration = {
  name: 'search_ebay_sold',
  description:
    'Search eBay completed/sold listings for price discovery. Returns the ' +
    'recent SOLD prices for a product (by GTIN preferred, or free-text query). ' +
    'Use this for sweet-spot pricing analysis — SOLD data reflects real market ' +
    'demand, not ask prices.',
  parameters: {
    type: 'object',
    properties: {
      gtin: { type: 'string', description: 'GTIN/EAN/UPC for exact match (preferred)' },
      query: { type: 'string', description: 'Free-text fallback query' },
      categoryId: { type: 'string', description: 'Optional eBay category id to narrow search' },
      marketplaceId: {
        type: 'string',
        enum: ['EBAY_DE', 'EBAY_COM'],
        default: 'EBAY_DE',
      },
      limit: { type: 'number', default: 20 },
    },
  },
};

const searchIdealoDeclaration = {
  name: 'search_idealo',
  description:
    'Search idealo.de (German price-comparison portal) for competitor pricing. ' +
    'Uses SerpAPI Google Shopping with site-restriction. Returns offer-prices ' +
    'from multiple retailers for a product. Use for cross-marketplace pricing.',
  parameters: {
    type: 'object',
    properties: {
      gtin: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number', default: 10 },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Hand-picked aliases for well-known brands. Everything else falls back to the
// heuristic `<slug>.de`. Intentionally conservative — this is a best-guess
// used as a Google `site:` hint, not a source of truth.
const BRAND_DOMAIN_MAP = {
  philips: 'philips.de',
  samsung: 'samsung.com',
  sony: 'sony.de',
  bosch: 'bosch.de',
  siemens: 'siemens.de',
  miele: 'miele.de',
  lg: 'lg.com',
  apple: 'apple.com',
  google: 'store.google.com',
  microsoft: 'microsoft.com',
  dell: 'dell.com',
  hp: 'hp.com',
  lenovo: 'lenovo.com',
  logitech: 'logitech.com',
  braun: 'braun.com',
  aeg: 'aeg.de',
  bauknecht: 'bauknecht.de',
  beurer: 'beurer.com',
  gardena: 'gardena.com',
  stihl: 'stihl.de',
  makita: 'makita.de',
  'de-longhi': 'delonghi.com',
  delonghi: 'delonghi.com',
  krups: 'krups.de',
  moulinex: 'moulinex.de',
  tefal: 'tefal.de',
  rowenta: 'rowenta.de',
  severin: 'severin.de',
  wmf: 'wmf.com',
  zwilling: 'zwilling.com',
  fissler: 'fissler.com',
};

function brandDomainGuess(brand) {
  if (!brand || typeof brand !== 'string') return null;
  const raw = brand.trim().toLowerCase();
  if (!raw) return null;
  // Strip corporate suffixes.
  const cleaned = raw
    .replace(/\s+(gmbh|ag|se|inc|ltd|llc|kg|bv|sa|co|corp|corporation)\.?\s*$/i, '')
    .trim();
  const slug = cleaned.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;
  if (BRAND_DOMAIN_MAP[slug]) return BRAND_DOMAIN_MAP[slug];
  // Heuristic: prefer .de for AvyCloud (DE marketplace default).
  return `${slug.replace(/-/g, '')}.de`;
}

function buildToolList({
  includeAmazon = true,
  includeManufacturer = true,
  includePricing = true,
} = {}) {
  const list = [
    lookupGtinDeclaration,
    searchEbayCatalogDeclaration,
    getRequiredAspectsDeclaration,
    verifyBrandDeclaration,
    fetchUrlContentDeclaration,
  ];
  if (includeAmazon) list.push(searchAmazonProductDeclaration);
  if (includeManufacturer) list.push(searchManufacturerSiteDeclaration);
  if (includePricing) {
    list.push(searchEbaySoldDeclaration);
    list.push(searchIdealoDeclaration);
  }
  return list;
}

function buildToolExecutorMap() {
  return {
    lookup_gtin: executeLookupGtin,
    search_ebay_catalog: executeSearchEbayCatalog,
    get_required_aspects: executeGetRequiredAspects,
    verify_brand: executeVerifyBrand,
    search_amazon_product: executeSearchAmazonProduct,
    search_manufacturer_site: executeSearchManufacturerSite,
    fetch_url_content: executeFetchUrlContent,
    search_ebay_sold: executeSearchEbaySold,
    search_idealo: executeSearchIdealo,
  };
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function executeLookupGtin({ gtin, locale } = {}) {
  const started = Date.now();
  const source = 'lookup_gtin';

  if (!gtin || typeof gtin !== 'string') {
    return failure(source, 'INVALID_GTIN', 'gtin is required and must be a string', {
      meta: { durationMs: Date.now() - started },
    });
  }
  if (!isValidGtinDigits(gtin)) {
    return failure(
      source,
      'INVALID_GTIN',
      `Not a valid GTIN/EAN/UPC checksum: ${gtin}`,
      { meta: { durationMs: Date.now() - started } }
    );
  }

  const eanLib = tryRequire('../lib/ean-database');
  if (!eanLib || typeof eanLib.lookupEan !== 'function') {
    return failure(
      source,
      'NOT_IMPLEMENTED',
      'ean-database module not available',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  try {
    const result = await withTimeout(
      eanLib.lookupEan(gtin),
      EXECUTOR_TIMEOUT_MS,
      'lookup_gtin'
    );
    const found = Boolean(result && result.found);
    const sources = [];
    if (found) {
      sources.push({
        provider: result.source || 'ean_database',
        data: result,
        confidence: result.source === 'open_ean_db' ? 0.7 : 0.65,
      });
    }
    return success(
      source,
      {
        sources,
        summary: found
          ? `${result.productName || 'Product'} (${result.brand || 'brand unknown'})`
          : 'No record found in connected EAN databases',
        locale: locale || null,
      },
      {
        confidence: found ? 0.7 : 0.1,
        meta: { durationMs: Date.now() - started },
      }
    );
  } catch (err) {
    return failure(source, 'LOOKUP_FAILED', err.message || String(err), {
      meta: { durationMs: Date.now() - started },
    });
  }
}

async function executeSearchEbayCatalog({ gtin, query, marketplace } = {}) {
  const started = Date.now();
  const source = 'search_ebay_catalog';
  const marketplaceId = (marketplace || 'EBAY_DE').toString();

  if (!gtin && !query) {
    return failure(source, 'MISSING_ARGUMENT', 'either gtin or query is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const remote = tryRequire('../lib/ebay-taxonomy-remote');
  if (!remote) {
    return failure(
      source,
      'NOT_IMPLEMENTED',
      'ebay-taxonomy-remote module not available',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  try {
    if (gtin && isValidGtinDigits(gtin) && typeof remote.searchCatalogByGtin === 'function') {
      const catalog = await withTimeout(
        remote.searchCatalogByGtin(gtin, { marketplaceId }),
        EXECUTOR_TIMEOUT_MS,
        'search_ebay_catalog'
      );
      return success(
        source,
        {
          mode: 'gtin',
          marketplace: marketplaceId,
          gtin,
          catalog,
        },
        {
          confidence: catalog && catalog.categoryId ? 0.9 : 0.3,
          meta: { durationMs: Date.now() - started },
        }
      );
    }

    if (query && typeof remote.getCategorySuggestions === 'function') {
      const suggestions = await withTimeout(
        remote.getCategorySuggestions(query, { marketplaceId }),
        EXECUTOR_TIMEOUT_MS,
        'search_ebay_catalog'
      );
      return success(
        source,
        {
          mode: 'query',
          marketplace: marketplaceId,
          query,
          suggestions,
        },
        {
          confidence: Array.isArray(suggestions) && suggestions.length ? 0.75 : 0.25,
          meta: { durationMs: Date.now() - started },
        }
      );
    }

    return failure(source, 'NOT_IMPLEMENTED', 'No compatible remote handler found', {
      meta: { durationMs: Date.now() - started },
    });
  } catch (err) {
    return failure(source, 'EBAY_LOOKUP_FAILED', err.message || String(err), {
      meta: { durationMs: Date.now() - started },
    });
  }
}

async function executeGetRequiredAspects({ categoryId, marketplace } = {}) {
  const started = Date.now();
  const source = 'get_required_aspects';

  if (!categoryId) {
    return failure(source, 'MISSING_ARGUMENT', 'categoryId is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const taxonomy = tryRequire('../lib/ebay-taxonomy');
  if (!taxonomy || typeof taxonomy.getCategoryAspectCatalog !== 'function') {
    return failure(
      source,
      'NOT_IMPLEMENTED',
      'ebay-taxonomy.getCategoryAspectCatalog not available',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  try {
    const catalog = taxonomy.getCategoryAspectCatalog(String(categoryId));
    const hasAny = Boolean(
      catalog &&
        (catalog.requiredAspects?.length ||
          catalog.recommendedAspects?.length ||
          catalog.optionalAspects?.length ||
          catalog.aspects?.length)
    );
    return success(
      source,
      {
        categoryId: String(categoryId),
        marketplace: (marketplace || 'EBAY_DE').toString(),
        required: catalog?.requiredAspects || [],
        recommended: catalog?.recommendedAspects || [],
        optional: catalog?.optionalAspects || [],
        all: catalog?.allAspects || [],
        aspects: catalog?.aspects || [],
        hasCatalogEntry: Boolean(catalog?.hasCatalogEntry),
      },
      {
        confidence: hasAny ? 0.95 : 0.1,
        meta: { durationMs: Date.now() - started },
      }
    );
  } catch (err) {
    return failure(source, 'ASPECT_LOOKUP_FAILED', err.message || String(err), {
      meta: { durationMs: Date.now() - started },
    });
  }
}

async function executeVerifyBrand({ brand, mpn } = {}) {
  const started = Date.now();
  const source = 'verify_brand';

  if (!brand || typeof brand !== 'string') {
    return failure(source, 'MISSING_ARGUMENT', 'brand is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const gpsr = tryRequire('../lib/gpsr-manufacturer-registry');
  if (gpsr && typeof gpsr.getManufacturerGpsrByName === 'function') {
    try {
      const record = await withTimeout(
        gpsr.getManufacturerGpsrByName(brand),
        EXECUTOR_TIMEOUT_MS,
        'verify_brand'
      );
      if (record && record.manufacturer_name) {
        return success(
          source,
          {
            resolved: true,
            via: 'gpsr_registry',
            brand: record.manufacturer_name,
            mpn: mpn || null,
            gpsr: record.gpsr || null,
            sources: record.sources || [],
          },
          {
            confidence: typeof record.confidence === 'number' ? record.confidence : 0.8,
            meta: { durationMs: Date.now() - started },
          }
        );
      }
    } catch (err) {
      // Fall through to domain-guess fallback; never crash verify_brand.
      console.warn(`[atomic-tools] verify_brand gpsr lookup failed: ${err.message}`);
    }
  }

  // Fallback: heuristic domain guess so downstream tools at least have a hint.
  const domain = brandDomainGuess(brand);
  return success(
    source,
    {
      resolved: false,
      via: 'domain_guess',
      brand,
      mpn: mpn || null,
      guess: {
        domain,
        impressum_query: `${brand} GmbH Impressum`,
      },
    },
    {
      confidence: domain ? 0.3 : 0.1,
      meta: { durationMs: Date.now() - started },
    }
  );
}

async function executeSearchAmazonProduct({ asin, gtin, query, region } = {}) {
  const started = Date.now();
  const source = 'search_amazon_product';
  const regionCode = (region || 'DE').toString().toUpperCase();

  if (!asin && !gtin && !query) {
    return failure(
      source,
      'MISSING_ARGUMENT',
      'at least one of asin, gtin, or query is required',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  const toolkit = tryRequire('./toolkit');
  if (!toolkit) {
    return failure(source, 'NOT_IMPLEMENTED', 'toolkit module not available', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const amazonDomain = regionCode === 'COM' ? 'amazon.com' : 'amazon.de';

  // Prefer SerpAPI engine=amazon when available.
  if (typeof toolkit.executeSerpapiToolCall === 'function') {
    try {
      const queryText = query || asin || gtin;
      const args = {
        engine: 'amazon',
        query: queryText,
        amazon_domain: amazonDomain,
      };
      if (asin) args.product_id = asin;
      const result = await withTimeout(
        toolkit.executeSerpapiToolCall({ arguments: JSON.stringify(args) }),
        EXECUTOR_TIMEOUT_MS,
        'search_amazon_product'
      );
      if (result && !result.error) {
        return success(
          source,
          {
            region: regionCode,
            provider: 'serpapi',
            query: queryText,
            domain: amazonDomain,
            result,
          },
          {
            confidence: Array.isArray(result.summary) && result.summary.length ? 0.75 : 0.3,
            meta: { durationMs: Date.now() - started },
          }
        );
      }
      // SerpAPI returned an error payload — fall through to brightdata.
    } catch (err) {
      console.warn(`[atomic-tools] serpapi amazon failed: ${err.message}`);
    }
  }

  // Fallback: BrightData search with site: hint.
  if (typeof toolkit.executeBrightdataSearchToolCall === 'function') {
    try {
      const queryText = query || asin || gtin;
      const args = {
        query: `${queryText}`,
        sites: [amazonDomain],
        limit: 8,
      };
      const result = await withTimeout(
        toolkit.executeBrightdataSearchToolCall({ arguments: JSON.stringify(args) }),
        EXECUTOR_TIMEOUT_MS,
        'search_amazon_product'
      );
      if (result && result.ok !== false) {
        return success(
          source,
          {
            region: regionCode,
            provider: 'brightdata',
            query: queryText,
            domain: amazonDomain,
            result,
          },
          {
            confidence: Array.isArray(result.results) && result.results.length ? 0.6 : 0.25,
            meta: { durationMs: Date.now() - started },
          }
        );
      }
      return failure(
        source,
        'NO_RESULTS',
        result && result.error ? result.error : 'brightdata returned no results',
        { meta: { durationMs: Date.now() - started } }
      );
    } catch (err) {
      return failure(source, 'SEARCH_FAILED', err.message || String(err), {
        meta: { durationMs: Date.now() - started },
      });
    }
  }

  return failure(source, 'NOT_IMPLEMENTED', 'no compatible search backend found', {
    meta: { durationMs: Date.now() - started },
  });
}

async function executeSearchManufacturerSite({ brand, model, mpn } = {}) {
  const started = Date.now();
  const source = 'search_manufacturer_site';

  if (!brand) {
    return failure(source, 'MISSING_ARGUMENT', 'brand is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const domain = brandDomainGuess(brand);
  const terms = [];
  if (model) terms.push(`"${model}"`);
  if (mpn) terms.push(`"${mpn}"`);
  const baseQuery = terms.length ? terms.join(' ') : `"${brand}"`;
  const queryWithSite = domain ? `${baseQuery} site:${domain}` : `"${brand}" ${baseQuery} specifications`;

  const toolkit = tryRequire('./toolkit');
  if (!toolkit || typeof toolkit.executeBrightdataSearchToolCall !== 'function') {
    return failure(
      source,
      'NOT_IMPLEMENTED',
      'toolkit.executeBrightdataSearchToolCall not available',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  try {
    const args = {
      query: queryWithSite,
      limit: 8,
    };
    if (domain) args.sites = [domain];
    const result = await withTimeout(
      toolkit.executeBrightdataSearchToolCall({ arguments: JSON.stringify(args) }),
      EXECUTOR_TIMEOUT_MS,
      'search_manufacturer_site'
    );
    const hasResults = result && Array.isArray(result.results) && result.results.length > 0;
    return success(
      source,
      {
        brand,
        model: model || null,
        mpn: mpn || null,
        domain,
        query: queryWithSite,
        result,
      },
      {
        confidence: hasResults ? 0.7 : 0.25,
        meta: { durationMs: Date.now() - started },
      }
    );
  } catch (err) {
    return failure(source, 'SEARCH_FAILED', err.message || String(err), {
      meta: { durationMs: Date.now() - started },
    });
  }
}

async function executeFetchUrlContent({ url, extractImages } = {}) {
  const started = Date.now();
  const source = 'fetch_url_content';

  if (!url || typeof url !== 'string') {
    return failure(source, 'MISSING_ARGUMENT', 'url is required', {
      meta: { durationMs: Date.now() - started },
    });
  }
  if (!/^https?:\/\//i.test(url)) {
    return failure(source, 'INVALID_URL', `URL must start with http(s)://: ${url}`, {
      meta: { durationMs: Date.now() - started },
    });
  }

  const toolkit = tryRequire('./toolkit');
  if (!toolkit || typeof toolkit.executeWebFetchToolCall !== 'function') {
    return failure(
      source,
      'NOT_IMPLEMENTED',
      'toolkit.executeWebFetchToolCall not available',
      { meta: { durationMs: Date.now() - started } }
    );
  }

  try {
    const args = {
      url,
      method: 'GET',
      format: 'raw',
      timeout_ms: EXECUTOR_TIMEOUT_MS,
    };
    const result = await withTimeout(
      toolkit.executeWebFetchToolCall({ arguments: JSON.stringify(args) }),
      EXECUTOR_TIMEOUT_MS,
      'fetch_url_content'
    );
    const ok = Boolean(result && result.success !== false && !result.error);
    return {
      ok,
      source,
      data: {
        url,
        extractImages: Boolean(extractImages),
        result,
      },
      confidence: ok ? 0.8 : 0.2,
      meta: { durationMs: Date.now() - started },
      ...(ok ? {} : { error: { code: 'FETCH_FAILED', message: (result && result.error) || 'fetch failed' } }),
    };
  } catch (err) {
    return failure(source, 'FETCH_FAILED', err.message || String(err), {
      meta: { durationMs: Date.now() - started },
    });
  }
}

// ---------------------------------------------------------------------------
// Pricing executors (V4 additions) — wrap ebay-sold-listings + SerpAPI-idealo
// ---------------------------------------------------------------------------

async function executeSearchEbaySold({ gtin, query, categoryId, marketplaceId, limit } = {}) {
  const started = Date.now();
  const source = 'search_ebay_sold';

  if (!gtin && !query) {
    return failure(source, 'MISSING_ARGUMENT', 'gtin or query is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const soldLib = tryRequire('../lib/ebay-sold-listings');
  if (!soldLib || typeof soldLib.searchSoldListings !== 'function') {
    return failure(source, 'NOT_IMPLEMENTED', 'ebay-sold-listings module missing', {
      meta: { durationMs: Date.now() - started },
    });
  }

  try {
    const result = await withTimeout(
      soldLib.searchSoldListings({
        gtin,
        query,
        categoryId,
        marketplaceId: marketplaceId || 'EBAY_DE',
        limit: Math.min(Number(limit) || 20, 50),
      }),
      EXECUTOR_TIMEOUT_MS,
      source
    );

    const items = Array.isArray(result?.items) ? result.items : [];
    const signals =
      typeof soldLib.extractPricingSignals === 'function'
        ? soldLib.extractPricingSignals(items)
        : { count: items.length };

    const confidence = items.length >= 5 ? 0.8 : items.length >= 2 ? 0.6 : 0.3;

    return success(source, { items, signals, meta: result?.meta }, {
      confidence,
      meta: { durationMs: Date.now() - started, itemCount: items.length },
    });
  } catch (err) {
    return failure(source, 'EXECUTOR_ERROR', err.message, {
      meta: { durationMs: Date.now() - started },
    });
  }
}

async function executeSearchIdealo({ gtin, query, limit } = {}) {
  const started = Date.now();
  const source = 'search_idealo';

  if (!gtin && !query) {
    return failure(source, 'MISSING_ARGUMENT', 'gtin or query is required', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const serp = tryRequire('../lib/serpapi');
  if (!serp || typeof serp.fetchSerpApi !== 'function') {
    return failure(source, 'NOT_IMPLEMENTED', 'serpapi module missing', {
      meta: { durationMs: Date.now() - started },
    });
  }

  const searchTerm = gtin ? `${gtin}` : query;
  const fullQuery = `${searchTerm} site:idealo.de`;

  try {
    const result = await withTimeout(
      serp.fetchSerpApi({
        engine: 'google_shopping',
        q: fullQuery,
        gl: 'de',
        hl: 'de',
        num: Math.min(Number(limit) || 10, 20),
      }),
      EXECUTOR_TIMEOUT_MS,
      source
    );

    const shoppingResults = Array.isArray(result?.shopping_results) ? result.shopping_results : [];
    const offers = shoppingResults
      .map((o) => ({
        title: String(o?.title || '').slice(0, 200),
        price: typeof o?.extracted_price === 'number' ? o.extracted_price : null,
        source: String(o?.source || '').slice(0, 80),
        link: String(o?.link || '').slice(0, 500),
      }))
      .filter((o) => o.price != null && o.title);

    const confidence = offers.length >= 3 ? 0.75 : offers.length >= 1 ? 0.5 : 0.2;

    return success(source, { offers, count: offers.length }, {
      confidence,
      meta: { durationMs: Date.now() - started, offerCount: offers.length },
    });
  } catch (err) {
    return failure(source, 'EXECUTOR_ERROR', err.message, {
      meta: { durationMs: Date.now() - started },
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  declarations: {
    lookupGtin: lookupGtinDeclaration,
    searchEbayCatalog: searchEbayCatalogDeclaration,
    getRequiredAspects: getRequiredAspectsDeclaration,
    verifyBrand: verifyBrandDeclaration,
    searchAmazonProduct: searchAmazonProductDeclaration,
    searchManufacturerSite: searchManufacturerSiteDeclaration,
    fetchUrlContent: fetchUrlContentDeclaration,
    searchEbaySold: searchEbaySoldDeclaration,
    searchIdealo: searchIdealoDeclaration,
  },
  executors: {
    executeLookupGtin,
    executeSearchEbayCatalog,
    executeGetRequiredAspects,
    executeVerifyBrand,
    executeSearchAmazonProduct,
    executeSearchManufacturerSite,
    executeFetchUrlContent,
    executeSearchEbaySold,
    executeSearchIdealo,
  },
  buildToolList,
  buildToolExecutorMap,
  brandDomainGuess,
  // exposed for tests
  _internal: {
    EXECUTOR_TIMEOUT_MS,
    isValidGtinDigits,
  },
};
