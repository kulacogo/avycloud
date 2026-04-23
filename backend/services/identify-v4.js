'use strict';

/**
 * services/identify-v4.js
 *
 * Identify-V4 Orchestrator — koordiniert Domain-Worker in parallelen Waves mit
 * Critic-Feedback-Schleife. Baut auf dem Stage-1-Recognition von V3 auf (REUSE
 * 1:1) und delegiert pro Domain an einen Worker-Agent.
 *
 * Architektur (Phase B — Skeleton):
 *
 *   ┌─ Stage 1 (V3 Recognition) ──────────────┐
 *   │   OCR + EAN-DB + focused grounding      │
 *   └────────────────┬────────────────────────┘
 *                    │
 *             ┌──────▼──────┐
 *             │   Wave 1    │  parallel
 *             │ identity +  │
 *             │  category   │
 *             └──────┬──────┘
 *                    │
 *         ┌──────────▼──────────┐
 *         │  Wave 2 (Phase C)   │  TODO: attributes/seo/pricing/image/gpsr
 *         └──────────┬──────────┘
 *                    │
 *             ┌──────▼──────┐
 *             │   Critic    │  ebay_ready_score + issues + fix_hints
 *             └──────┬──────┘
 *                    │
 *         ┌──────────▼───────────┐
 *         │  assembleProductV4   │
 *         │      + Autosave      │
 *         └──────────────────────┘
 *
 * Feature-Flag: `IDENTIFY_V4=true` in der Route — der Orchestrator selbst
 * läuft nur wenn aufgerufen. Fehler bubble NICHT — wir liefern immer ein
 * Response-Objekt (ok:false + error + fallback-Hint).
 */

const crypto = require('crypto');
const { runStage1Recognition } = require('../lib/identify-v3-stage1');
const { crossReferenceProduct } = require('../lib/cross-reference');
const { aggregateProductConfidence } = require('../lib/confidence-scoring');
const { saveProductV2 } = require('../lib/product-store');

// --- Config / Flags --------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = parseInt(process.env.IDENTIFY_V4_MAX_ITERATIONS || '5', 10);
const DEFAULT_WAVE_TIMEOUT_MS = parseInt(process.env.IDENTIFY_V4_WAVE_TIMEOUT_MS || '60000', 10);
const DEFAULT_PIPELINE_TIMEOUT_MS = parseInt(process.env.IDENTIFY_V4_TIMEOUT_MS || '180000', 10);
const AUTOSAVE_DEFAULT = String(
  process.env.IDENTIFY_V4_AUTOSAVE == null ? 'true' : process.env.IDENTIFY_V4_AUTOSAVE
)
  .toLowerCase() !== 'false';

const AUTOSAVE_MIN_SCORE = 0.6;

function identifyV4Enabled() {
  const raw = String(process.env.IDENTIFY_V4 || '').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

// --- Worker-Registry -------------------------------------------------------

// Lazy require inside factory so tests can patch require.cache before load.
const WORKER_REGISTRY = Object.freeze({
  identity: () => require('../lib/identify-workers/identity-worker').runIdentityWorker,
  category: () => require('../lib/identify-workers/category-worker').runCategoryWorker,
  attributes: () => require('../lib/identify-workers/attributes-worker').runAttributesWorker,
  seo: () => require('../lib/identify-workers/seo-worker').runSeoWorker,
  pricing: () => require('../lib/identify-workers/pricing-worker').runPricingWorker,
  image: () => require('../lib/identify-workers/image-worker').runImageWorker,
  gpsr: () => require('../lib/identify-workers/gpsr-worker').runGpsrWorker,
  critic: () => require('../lib/identify-workers/critic-worker').runCriticWorker,
});

// Maps product fields to the worker-domain responsible for them. Used by the
// refinement loop to decide which workers to re-run when a field's confidence
// falls below threshold.
const FIELD_DOMAIN_MAP = Object.freeze({
  ean: 'identity',
  gtin: 'identity',
  upc: 'identity',
  mpn: 'identity',
  brand: 'identity',
  categoryId: 'category',
  category: 'category',
  requiredAspects: 'attributes',
  item_specifics: 'attributes',
  title: 'seo',
  description: 'seo',
  price: 'pricing',
  images: 'image',
  gpsr: 'gpsr',
});

const CONFIDENCE_THRESHOLD = 0.75;

// --- Utils -----------------------------------------------------------------

function makeTimeoutPromise(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`[identify-v4] ${label} timeout after ${ms}ms`)), ms);
  });
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

// --- Wave runner -----------------------------------------------------------

/**
 * Run a list of workers in parallel with a per-wave timeout.
 * Each worker runs inside a Promise.race against the wave timeout so a slow
 * worker never blocks its peers. Errors NEVER bubble — always returns an
 * Array of result-objects (one per worker-name in the same order).
 *
 * @param {string[]} workerNames e.g. ['identity','category']
 * @param {object} context
 * @returns {Promise<Array<{ok, domain, resolved, confidence, sources, meta}>>}
 */
async function runWave(workerNames, context) {
  const list = Array.isArray(workerNames) ? workerNames : [];
  const waveTimeout = Number(context?._waveTimeoutMs) || DEFAULT_WAVE_TIMEOUT_MS;

  const tasks = list.map(async (name) => {
    const factory = WORKER_REGISTRY[name];
    if (typeof factory !== 'function') {
      return {
        ok: false,
        domain: name,
        resolved: {},
        confidence: {},
        sources: [],
        meta: {
          durationMs: 0,
          error: `no worker registered for "${name}"`,
        },
      };
    }
    let runner;
    try {
      runner = factory();
    } catch (err) {
      return {
        ok: false,
        domain: name,
        resolved: {},
        confidence: {},
        sources: [],
        meta: {
          durationMs: 0,
          error: `require-error: ${err?.message || String(err)}`,
        },
      };
    }
    if (typeof runner !== 'function') {
      return {
        ok: false,
        domain: name,
        resolved: {},
        confidence: {},
        sources: [],
        meta: {
          durationMs: 0,
          error: `worker "${name}" is not a function`,
        },
      };
    }
    const started = Date.now();
    try {
      const result = await Promise.race([
        runner(context),
        makeTimeoutPromise(waveTimeout, `worker:${name}`),
      ]);
      // Normalize minimal shape defensively.
      return {
        ok: Boolean(result?.ok),
        domain: result?.domain || name,
        resolved: (result && result.resolved) || {},
        confidence: (result && result.confidence) || {},
        sources: Array.isArray(result?.sources) ? result.sources : [],
        meta: (result && result.meta) || { durationMs: Date.now() - started },
        retriesRequested: Array.isArray(result?.retriesRequested) ? result.retriesRequested : [],
      };
    } catch (err) {
      return {
        ok: false,
        domain: name,
        resolved: {},
        confidence: {},
        sources: [],
        meta: {
          durationMs: Date.now() - started,
          error: err?.message || String(err),
        },
      };
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map((entry, idx) => {
    if (entry.status === 'fulfilled') return entry.value;
    return {
      ok: false,
      domain: list[idx],
      resolved: {},
      confidence: {},
      sources: [],
      meta: {
        durationMs: 0,
        error: entry.reason?.message || String(entry.reason || 'unknown'),
      },
    };
  });
}

// --- Wave merge ------------------------------------------------------------

/**
 * Merge an array of wave-results back into the orchestrator context.
 *
 *  - writes resolved fields to `context.product` via crossReferenceProduct
 *    (multi-source consensus)
 *  - updates `context.workerResults[domain] = result`
 *  - appends sources to `context.additionalSources`
 *
 * @param {object} context
 * @param {Array} results
 * @returns {object} context (mutated in place + returned for chaining)
 */
function mergeWaveResults(context, results) {
  if (!context || typeof context !== 'object') return context;
  if (!Array.isArray(results) || !results.length) return context;

  context.workerResults = context.workerResults || {};
  context.additionalSources = context.additionalSources || [];
  context.product = context.product || {};

  // Build a flat source-result list for cross-reference.
  const crossRefEntries = [];

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const domain = result.domain || 'unknown';
    context.workerResults[domain] = result;

    if (Array.isArray(result.sources)) {
      for (const s of result.sources) {
        if (s) context.additionalSources.push({ domain, ...s });
      }
    }

    if (!result.resolved || typeof result.resolved !== 'object') continue;

    for (const [field, value] of Object.entries(result.resolved)) {
      if (value == null) continue;
      // Confidence may be a number (worker-specific) or an object
      const rawConf = result.confidence && result.confidence[field];
      const conf = typeof rawConf === 'number' ? rawConf : (rawConf && rawConf.score) || undefined;
      crossRefEntries.push({
        field,
        source: `worker:${domain}`,
        value,
        confidence: typeof conf === 'number' ? conf : undefined,
      });
    }
  }

  // Seed draft from current product identification/details so cross-ref can
  // keep existing values when no worker overrides.
  const draft = {};
  try {
    const ident = context.product.identification || {};
    const details = context.product.details || {};
    if (ident.brand) draft.brand = ident.brand;
    if (ident.name) draft.title = ident.name;
    if (ident.category) draft.category = ident.category;
    if (details.categoryId) draft.categoryId = details.categoryId;
    if (details.identifiers?.ean) draft.ean = details.identifiers.ean;
    if (details.identifiers?.gtin) draft.gtin = details.identifiers.gtin;
    if (details.identifiers?.upc) draft.upc = details.identifiers.upc;
    if (details.identifiers?.mpn) draft.mpn = details.identifiers.mpn;
  } catch (_err) {
    // draft stays {}
  }

  const { resolved, confidence, conflicts } = crossReferenceProduct(draft, crossRefEntries);
  context._crossRefResolved = resolved;
  context._crossRefConfidence = confidence;
  context._crossRefConflicts = Array.isArray(conflicts) ? conflicts : [];

  // Persist consensus confidence map on context for the Critic + assembly step.
  context.confidence = context.confidence || {};
  for (const [field, entry] of Object.entries(confidence || {})) {
    if (entry && typeof entry.score === 'number') {
      context.confidence[field] = entry;
    }
  }

  return context;
}

// --- Refinement helpers ----------------------------------------------------

/**
 * Scans context.confidence (set by mergeWaveResults via crossReferenceProduct)
 * and returns the unique set of worker-domains responsible for fields whose
 * confidence is below CONFIDENCE_THRESHOLD. Skips 'identity' and 'category'
 * which are locked in from Wave 1.
 */
function findLowConfidenceWorkers(context) {
  const workersToRerun = new Set();
  const confMap = context.confidence || {};

  for (const [field, entry] of Object.entries(confMap)) {
    const score = entry && typeof entry.score === 'number' ? entry.score : null;
    if (score == null || score >= CONFIDENCE_THRESHOLD) continue;
    const domain = FIELD_DOMAIN_MAP[field];
    if (!domain) continue;
    // Wave 1 workers are not re-run in refinement — they're the foundation
    if (domain === 'identity' || domain === 'category') continue;
    workersToRerun.add(domain);
  }

  // Also rerun any worker that returned ok:false on its previous turn and has
  // low-confidence outputs (gives the worker another chance with augmented ctx)
  const wr = context.workerResults || {};
  for (const [domain, r] of Object.entries(wr)) {
    if (r && r.ok === false && !['identity', 'category', 'critic'].includes(domain)) {
      workersToRerun.add(domain);
    }
  }

  return [...workersToRerun];
}

/**
 * Compares refinement results against the pre-refinement confidence map.
 * Returns true if the total confidence score across affected fields improved
 * by at least MIN_IMPROVEMENT. Used to break out of the refinement loop early
 * when retries stop delivering value.
 */
function hasConfidenceImproved(context, refinementResults) {
  const MIN_IMPROVEMENT = 0.05;
  if (!Array.isArray(refinementResults) || refinementResults.length === 0) {
    return false;
  }

  const before = context.confidence || {};
  let delta = 0;

  for (const result of refinementResults) {
    if (!result || !result.ok || !result.confidence) continue;
    // Compare on confidence keys directly (not resolved keys — worker outputs
    // like { title_ebay, description_ebay } don't match their confidence keys
    // { title, description }). Iterating confidence-side is authoritative.
    for (const [confField, entry] of Object.entries(result.confidence)) {
      const newScore = typeof entry === 'number' ? entry : (entry && entry.score) || 0;
      const oldEntry = before[confField];
      const oldScore = typeof oldEntry === 'number' ? oldEntry : (oldEntry && oldEntry.score) || 0;
      if (newScore > oldScore) {
        delta += newScore - oldScore;
      }
    }
  }

  return delta >= MIN_IMPROVEMENT;
}

// --- Product assembly ------------------------------------------------------

/**
 * Build the final V4 product from context (Stage-1 identity + worker results
 * + cross-ref consensus). Result matches the V2/V3 Product interface so it
 * can be saved via saveProductV2.
 *
 * @param {object} context
 * @returns {object} product
 */
function assembleProductV4(context) {
  const ctx = context || {};
  const identity = ctx.identity || {};
  const workerResults = ctx.workerResults || {};
  const identityResult = workerResults.identity || {};
  const categoryResult = workerResults.category || {};
  const criticResult = workerResults.critic || {};
  const identityResolved = identityResult.resolved || {};
  const categoryResolved = categoryResult.resolved || {};
  const crossRef = ctx._crossRefResolved || {};

  const id = (ctx.product && ctx.product.id) || crypto.randomUUID();

  const brand = crossRef.brand || identityResolved.brand || identity.brand || '';
  const name = identity.brand || identity.model
    ? [identity.brand, identity.model, identity.variant].filter(Boolean).join(' ').trim()
    : '';
  const finalName = name || 'Unbekanntes Produkt';

  const ean = crossRef.ean || identityResolved.ean || '';
  const gtin = crossRef.gtin || identityResolved.gtin || '';
  const upc = crossRef.upc || identityResolved.upc || '';
  const mpn = crossRef.mpn || identityResolved.mpn || identity.mpn || '';

  const categoryId = categoryResolved.categoryId || crossRef.categoryId || '';
  const breadcrumb = categoryResolved.breadcrumb || categoryResolved.categoryName
    || identity.internalCategory || 'Unkategorisiert';
  const categorySource = categoryResolved.categorySource || undefined;

  // Start with identity-derived attributes, required-aspects skeleton
  const attributes = {};
  if (identity.brand) attributes.Marke = identity.brand;
  if (identity.model) attributes.Modell = identity.model;
  if (identity.color) attributes.Farbe = identity.color;
  if (Array.isArray(categoryResolved.requiredAspects)) {
    for (const a of categoryResolved.requiredAspects) {
      if (a && a.name && attributes[a.name] == null) attributes[a.name] = 'Unbekannt';
    }
  }
  // Wave 2: overlay attributes-worker output (Array<{key,value,confidence}>)
  const attributesResolved = workerResults.attributes?.resolved || {};
  if (Array.isArray(attributesResolved.item_specifics)) {
    for (const spec of attributesResolved.item_specifics) {
      if (spec && spec.key && spec.value) {
        attributes[spec.key] = spec.value;
      }
    }
  }

  // Wave 2: seo-worker output
  const seoResolved = workerResults.seo?.resolved || {};
  const titleEbay = seoResolved.title_ebay || '';
  const titleKaufland = seoResolved.title_kaufland || '';
  const descEbay = seoResolved.description_ebay || '';
  const descKaufland = seoResolved.description_kaufland || '';
  const mobileSnippet = seoResolved.mobile_snippet || '';
  const keyFeatures = Array.isArray(seoResolved.key_features) ? seoResolved.key_features : [];

  // Wave 2: pricing-worker output
  const pricingResolved = workerResults.pricing?.resolved || {};
  const pricingAmount = typeof pricingResolved.price_suggested === 'number'
    ? pricingResolved.price_suggested
    : 0;
  const pricingSources = Array.isArray(pricingResolved.sources) ? pricingResolved.sources : [];
  const pricingConfidence = workerResults.pricing?.confidence?.price || 0;

  // Wave 2: image-worker output (URL + meta, no buffers)
  const imageResolved = workerResults.image?.resolved || {};
  const workerImages = Array.isArray(imageResolved.images) ? imageResolved.images : [];
  const imagesOut = workerImages
    .filter((i) => i && (i.url || i.source === 'upload'))
    .map((i, idx) => ({
      url_or_base64: i.url || `inline://upload-${idx}`,
      source: i.source || 'upload',
      variant: i.angle || 'reference',
      quality: typeof i.quality === 'number' ? i.quality : undefined,
    }));
  // Fallback: Stage-1 upload-placeholders if image-worker returned nothing
  const images = imagesOut.length > 0
    ? imagesOut
    : (ctx.imageParts || []).map((_p, idx) => ({
        url_or_base64: `inline://image-${idx}`,
        source: 'upload',
        variant: 'reference',
      }));

  // Wave 2: gpsr-worker output
  const gpsrResolved = workerResults.gpsr?.resolved || {};
  const gpsrOut = gpsrResolved.gpsr && Object.keys(gpsrResolved.gpsr).length > 0
    ? gpsrResolved.gpsr
    : null;

  // Field-score map for aggregate confidence.
  const confidenceMap = {};
  for (const [field, entry] of Object.entries(ctx.confidence || {})) {
    if (entry && typeof entry.score === 'number') {
      confidenceMap[field] = entry;
    }
  }
  const aggregate = aggregateProductConfidence(confidenceMap);

  const criticResolved = criticResult.resolved || {};
  const ebayReadyScore = typeof criticResolved.ebay_ready_score === 'number'
    ? criticResolved.ebay_ready_score
    : null;

  const dataQualityV4 = {
    checked_at_iso: new Date().toISOString(),
    waves: ctx._waveHistory || [],
    confidence: {
      aggregate: aggregate.score,
      readyForPublish: aggregate.readyForPublish,
      missingCritical: aggregate.missingCritical,
      fields: confidenceMap,
    },
    critic: criticResolved.critiqued
      ? {
          ebay_ready_score: ebayReadyScore,
          issues: criticResolved.issues || [],
          fix_hints: criticResolved.fix_hints || [],
          aspect_cap_applied: Boolean(criticResolved.aspect_cap_applied),
          refinement_needed_workers: criticResolved.refinement_needed_workers || [],
        }
      : null,
    worker_meta: Object.fromEntries(
      Object.entries(workerResults).map(([domain, r]) => [domain, r?.meta || null])
    ),
    conflicts: ctx._crossRefConflicts || [],
  };

  return {
    id,
    locale: ctx.locale || 'de-DE',
    identification: {
      method: (ean || gtin || upc) ? 'barcode' : 'image',
      barcodes: [ean, gtin, upc].filter(Boolean),
      name: finalName,
      brand: brand || '',
      category: breadcrumb,
      confidence: typeof aggregate.score === 'number' ? aggregate.score : 0,
    },
    details: {
      categoryId: categoryId || undefined,
      categorySource,
      short_description: mobileSnippet || '',
      key_features: keyFeatures,
      attributes,
      identifiers: {
        ean: ean || undefined,
        gtin: gtin || undefined,
        upc: upc || undefined,
        mpn: mpn || undefined,
      },
      images,
      pricing: {
        lowest_price: {
          amount: pricingAmount,
          currency: 'EUR',
          sources: pricingSources,
        },
        price_confidence: pricingConfidence,
        ...(pricingResolved.price_min != null ? { price_min: pricingResolved.price_min } : {}),
        ...(pricingResolved.price_max != null ? { price_max: pricingResolved.price_max } : {}),
        ...(pricingResolved.fee_breakdown ? { fee_breakdown: pricingResolved.fee_breakdown } : {}),
      },
      ...(gpsrOut ? { gpsr: gpsrOut } : {}),
      title_ebay: titleEbay,
      title_kaufland: titleKaufland,
      description_ebay: descEbay,
      description_kaufland: descKaufland,
    },
    marketplace: {
      ebay: {
        title: titleEbay,
        description: descEbay,
        mobile_snippet: mobileSnippet,
      },
      kaufland: {
        title: titleKaufland,
        description: descKaufland,
      },
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      pending_intake_quantity: 0,
      weight_grams: identity.weight_grams || null,
      identify_pipeline: 'v4',
      sourcePalette: ctx.paletteCode || null,
      sourcePaletteAt: ctx.paletteCode ? new Date().toISOString() : null,
      data_quality: {
        identify_v4: dataQualityV4,
      },
    },
    inventory: {
      quantity: 0,
      inventoryId: ctx.inventoryId || null,
      inventoryName: null,
    },
    notes: {},
  };
}

// --- Main orchestrator -----------------------------------------------------

/**
 * identifyProductV4 — entry point.
 *
 * @param {object} args
 * @param {Array<{buffer:Buffer,mimetype:string}>} [args.files]
 * @param {string} [args.barcodes] space/comma-separated
 * @param {string} [args.locale] default 'de-DE'
 * @param {string} [args.hint] free-text hint
 * @param {string} [args.paletteCode]
 * @param {string} [args.inventoryId]
 * @param {string} [args.tenantId]
 * @param {string} [args.userId]
 * @param {object} [args.aiClient] @google/genai client (forwarded to workers)
 * @param {boolean} [args.autosave] override AUTOSAVE_DEFAULT
 * @returns {Promise<{ok:boolean, product?:object, meta:object, error?:string, fallback?:string}>}
 */
async function identifyProductV4({
  files = [],
  barcodes = '',
  locale = 'de-DE',
  hint = null,
  paletteCode = null,
  inventoryId = null,
  tenantId = null,
  userId = null,
  aiClient = null,
  autosave = AUTOSAVE_DEFAULT,
} = {}) {
  const pipelineStartedAt = Date.now();
  const waveHistory = [];

  const mainPromise = (async () => {
    // --- 1. Stage 1 Recognition (REUSE V3) ------------------------------
    let stage1;
    try {
      stage1 = await runStage1Recognition({ files, barcodes, hint, locale, paletteCode });
    } catch (err) {
      console.warn(`[identify-v4] stage1 failed: ${err?.message || err}`);
      return {
        ok: false,
        error: err?.message || String(err),
        fallback: 'v3',
        meta: {
          pipeline: 'v4',
          totalDurationMs: Date.now() - pipelineStartedAt,
          stage1_failed: true,
        },
      };
    }

    // --- 2. Build orchestrator context ----------------------------------
    const context = {
      product: null,
      files,
      barcodes,
      hint,
      locale,
      paletteCode,
      inventoryId,
      tenantId,
      userId,
      imageParts: stage1.imageParts || [],
      identity: stage1.identity || {},
      ocrPayload: stage1.ocrPayload || {},
      workerResults: {},
      iteration: 0,
      additionalSources: [],
      aiClient,
      confidence: {},
      _waveTimeoutMs: DEFAULT_WAVE_TIMEOUT_MS,
      _waveHistory: waveHistory,
    };

    // Seed initial product draft for category-worker's context.product check.
    context.product = {
      identification: {
        brand: context.identity.brand || '',
        name: [context.identity.brand, context.identity.model].filter(Boolean).join(' ').trim(),
        category: context.identity.internalCategory || '',
      },
      details: { identifiers: {} },
    };

    // --- 3. Wave 1: identity + category in parallel ---------------------
    const wave1Start = Date.now();
    const wave1Results = await runWave(['identity', 'category'], context);
    waveHistory.push({
      wave: 1,
      workers: ['identity', 'category'],
      durationMs: Date.now() - wave1Start,
      results: wave1Results.map((r) => ({ domain: r.domain, ok: r.ok, error: r.meta?.error })),
    });
    mergeWaveResults(context, wave1Results);

    // --- 4. Wave 2: 5 domain workers in parallel ----------------------
    const WAVE2_WORKERS = ['attributes', 'seo', 'pricing', 'image', 'gpsr'];
    const wave2Start = Date.now();
    const wave2Results = await runWave(WAVE2_WORKERS, context);
    waveHistory.push({
      wave: 2,
      workers: WAVE2_WORKERS,
      durationMs: Date.now() - wave2Start,
      results: wave2Results.map((r) => ({
        domain: r.domain,
        ok: r.ok,
        error: r.meta?.error,
      })),
    });
    mergeWaveResults(context, wave2Results);

    // --- 5. Refinement-Loop (aggressive, up to DEFAULT_MAX_ITERATIONS) --
    for (let iter = 1; iter <= DEFAULT_MAX_ITERATIONS; iter++) {
      context.iteration = iter;
      const lowConfWorkers = findLowConfidenceWorkers(context);
      if (lowConfWorkers.length === 0) break;

      const refinementStart = Date.now();
      const refinementResults = await runWave(lowConfWorkers, context);
      waveHistory.push({
        wave: 2 + iter,
        workers: lowConfWorkers,
        refinement: true,
        durationMs: Date.now() - refinementStart,
        results: refinementResults.map((r) => ({
          domain: r.domain,
          ok: r.ok,
          error: r.meta?.error,
        })),
      });

      const improved = hasConfidenceImproved(context, refinementResults);
      mergeWaveResults(context, refinementResults);
      if (!improved) break;
    }

    // --- 6. Critic ------------------------------------------------------
    const criticStart = Date.now();
    const criticContext = {
      product: assembleProductV4(context),
      aiClient,
      requiredAspects: (context.workerResults.category?.resolved?.requiredAspects || [])
        .map((a) => a && a.name)
        .filter(Boolean),
      recommendedAspects: (context.workerResults.category?.resolved?.recommendedAspects || [])
        .map((a) => a && a.name)
        .filter(Boolean),
    };
    let criticResult;
    try {
      const criticRunner = WORKER_REGISTRY.critic();
      criticResult = await Promise.race([
        criticRunner(criticContext),
        makeTimeoutPromise(DEFAULT_WAVE_TIMEOUT_MS, 'critic'),
      ]);
    } catch (err) {
      console.warn(`[identify-v4] critic failed: ${err?.message || err}`);
      criticResult = {
        ok: true,
        domain: 'critic',
        resolved: {
          critiqued: false,
          issues: [],
          fix_hints: [],
          ebay_ready_score: 0,
          refinement_needed_workers: [],
        },
        confidence: { ebay_ready: 0 },
        sources: [],
        meta: { error: err?.message || String(err), durationMs: Date.now() - criticStart },
      };
    }
    context.workerResults.critic = criticResult;

    // --- 7. Assemble final product -------------------------------------
    const finalProduct = assembleProductV4(context);

    // --- 8. Autosave ----------------------------------------------------
    const ebayReadyScore = Number(criticResult?.resolved?.ebay_ready_score) || 0;
    const identityOk = Boolean(context.workerResults.identity?.ok);
    const categoryOk = Boolean(context.workerResults.category?.ok);
    const meetsAutosaveThreshold = ebayReadyScore >= AUTOSAVE_MIN_SCORE;

    let saved = null;
    let needsHumanReview = false;
    if (autosave && meetsAutosaveThreshold && identityOk && categoryOk) {
      try {
        saved = await saveProductV2(finalProduct, {
          mode: 'system',
          tenantId,
          userId,
        });
      } catch (err) {
        console.warn(`[identify-v4] autosave failed: ${err?.message || err}`);
        saved = null;
        needsHumanReview = true;
        finalProduct.ops = finalProduct.ops || {};
        finalProduct.ops.data_quality = finalProduct.ops.data_quality || {};
        finalProduct.ops.data_quality.identify_v4 = finalProduct.ops.data_quality.identify_v4 || {};
        finalProduct.ops.data_quality.identify_v4.autosave_error = err?.message || String(err);
      }
    } else {
      if (autosave) needsHumanReview = true;
    }

    return {
      ok: true,
      product: finalProduct,
      meta: {
        pipeline: 'v4',
        totalDurationMs: Date.now() - pipelineStartedAt,
        waves: waveHistory,
        confidence: {
          aggregate: finalProduct?.ops?.data_quality?.identify_v4?.confidence?.aggregate || 0,
          readyForPublish: Boolean(
            finalProduct?.ops?.data_quality?.identify_v4?.confidence?.readyForPublish
          ),
        },
        critic: criticResult?.resolved || null,
        workerReports: { ...context.workerResults },
        saved: saved ? { id: saved.id || finalProduct.id, ok: true } : null,
        needs_human_review: needsHumanReview,
        timedOut: false,
      },
    };
  })();

  // --- Pipeline-wide timeout: never throw, best-effort return --------------
  let timedOut = false;
  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, DEFAULT_PIPELINE_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([mainPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut || !result) {
      console.warn(`[identify-v4] pipeline timeout after ${DEFAULT_PIPELINE_TIMEOUT_MS}ms`);
      return {
        ok: false,
        error: `pipeline-timeout after ${DEFAULT_PIPELINE_TIMEOUT_MS}ms`,
        fallback: 'v3',
        meta: {
          pipeline: 'v4',
          totalDurationMs: Date.now() - pipelineStartedAt,
          timedOut: true,
          waves: waveHistory,
        },
      };
    }
    return result;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Defensive — mainPromise should already catch, but belt + braces.
    console.error(`[identify-v4] orchestrator error: ${err?.message || err}`);
    return {
      ok: false,
      error: err?.message || String(err),
      fallback: 'v3',
      meta: {
        pipeline: 'v4',
        totalDurationMs: Date.now() - pipelineStartedAt,
        waves: waveHistory,
      },
    };
  }
}

module.exports = {
  identifyProductV4,
  identifyV4Enabled,
  _testables: {
    runWave,
    mergeWaveResults,
    assembleProductV4,
    findLowConfidenceWorkers,
    hasConfidenceImproved,
    WORKER_REGISTRY,
    FIELD_DOMAIN_MAP,
    CONFIDENCE_THRESHOLD,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_WAVE_TIMEOUT_MS,
    DEFAULT_PIPELINE_TIMEOUT_MS,
    AUTOSAVE_MIN_SCORE,
    safeClone,
  },
};
