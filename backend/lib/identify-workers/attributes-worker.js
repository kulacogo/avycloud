'use strict';

/**
 * attributes-worker.js — Identify-V4 Worker-Agent for the ATTRIBUTES domain.
 *
 * Füllt die eBay Item Specifics (required + recommended Aspects) für eine
 * zuvor aufgelöste Kategorie. Nutzt drei parallele Source-Calls
 * (eBay-Katalog, Amazon, Hersteller-Seite), cross-referenziert die Werte mit
 * `lib/cross-reference.js`, optional erweitert um einen Gemini-Finalisierungs-
 * Call (forced finalization via mode=ANY). Am Ende wird der eBay-45-Hard-Cap
 * mit `lib/aspect-cap-enforcer.js` durchgesetzt.
 *
 * Contract:
 *   async function runAttributesWorker(context) -> {
 *     ok, domain: 'attributes',
 *     resolved: {
 *       item_specifics: [{ key, value, confidence, sources }],
 *       requiredAspectsCoverage: 0..1,
 *       aspectCap: { applied, removedCount },
 *     },
 *     confidence: { item_specifics, requiredAspects },
 *     sources: [...],
 *     retriesRequested: [],
 *     meta: { durationMs, toolsCalled, geminiCalls, error }
 *   }
 *
 * NEVER throws — errors surface in `meta.error`.
 */

const atomicTools = require('../../services/atomic-tools');
const { scoreField } = require('../confidence-scoring');
const { resolveConsensus } = require('../cross-reference');
const { enforceAspectCap } = require('../aspect-cap-enforcer');
const {
  resolveChatModel,
  defaultThinkingConfig,
  defaultSafetySettings,
  DEFAULT_CHAT_TEMPERATURE,
} = require('../gemini-config');

const DOMAIN = 'attributes';
const MAX_WORKER_ITERATIONS = 3;
const MAX_OUTPUT_TOKENS = 4096;
const ASPECT_HARD_CAP = 45;
const FINALIZE_TOOL = 'finalize_attributes';

// Graceful degradation when @google/genai isn't loadable (tests).
let FunctionCallingConfigMode;
try {
  // eslint-disable-next-line global-require
  ({ FunctionCallingConfigMode } = require('@google/genai'));
} catch (err) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}
if (!FunctionCallingConfigMode || !FunctionCallingConfigMode.ANY) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}

// ---------------------------------------------------------------------------
// Source-Weight Mapping
// ---------------------------------------------------------------------------

const ATOMIC_SOURCE_TO_WEIGHT_KEY = Object.freeze({
  lookup_gtin: 'ean_db',
  search_ebay_catalog: 'ebay_catalog',
  verify_brand: 'gs1_verified',
  search_amazon_product: 'amazon_product',
  search_manufacturer_site: 'manufacturer_website',
  fetch_url_content: 'url_context',
});

function mapToolSourceWeight(source) {
  return ATOMIC_SOURCE_TO_WEIGHT_KEY[source] || 'web_search_broad';
}

// ---------------------------------------------------------------------------
// Finalize-tool declaration (Gemini finalization)
// ---------------------------------------------------------------------------

const FINALIZE_ATTRIBUTES_DECLARATION = {
  name: 'finalize_attributes',
  description:
    'Finalize the eBay item specifics. Return an array of {key, value, confidence, sources} ' +
    'objects covering every required aspect (and as many recommended aspects as possible). ' +
    'Use value="Unbekannt" with confidence=0 when no source can supply the value.',
  parameters: {
    type: 'object',
    properties: {
      aspects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            confidence: { type: 'number' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['key', 'value'],
        },
      },
    },
    required: ['aspects'],
  },
};

const SYSTEM_PROMPT = [
  'Du bist ein eBay-Item-Specifics-Füller.',
  'Du erhältst eine Liste von requiredAspects + recommendedAspects und Rohdaten aus',
  'bis zu 3 Quellen (eBay-Katalog, Amazon, Hersteller-Seite).',
  'Fülle JEDEN required Aspect mit dem BESTEN Wert aus den Quellen.',
  'Cross-referenziere mindestens 2 Quellen, wenn möglich. Markiere Confidence (0..1).',
  'Wenn keine Quelle einen Wert liefert: value="Unbekannt", confidence=0.',
  'Niemals halluzinieren. Antworte am ENDE mit einem function_call an finalize_attributes.',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function aspectName(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'object') {
    return safeString(entry.name || entry.localizedName || entry.key || entry.aspect || '');
  }
  return '';
}

function toAspectNameList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(aspectName).filter(Boolean);
}

function normKey(value) {
  return safeString(value).toLowerCase();
}

function pickGtinFromContext(context) {
  const barcodes = context?.barcodes || {};
  const identityResolved =
    context?.workerResults?.identity?.resolved || context?.identity || {};
  const candidates = [
    barcodes.ean,
    barcodes.gtin,
    barcodes.upc,
    identityResolved.gtin,
    identityResolved.ean,
    identityResolved.upc,
    context?.product?.identification?.ean,
    context?.product?.identification?.gtin,
    context?.product?.details?.identifiers?.ean,
    context?.product?.details?.identifiers?.gtin,
  ];
  for (const raw of candidates) {
    const digits = safeString(raw).replace(/\D/g, '');
    if (digits && [8, 12, 13, 14].includes(digits.length)) return digits;
  }
  return '';
}

function pickIdentityHints(context) {
  const identityResolved =
    context?.workerResults?.identity?.resolved || context?.identity || {};
  const product = context?.product || {};
  return {
    brand:
      safeString(identityResolved.brand) ||
      safeString(product?.identification?.brand) ||
      '',
    model:
      safeString(identityResolved.model) ||
      safeString(identityResolved.mpn) ||
      safeString(product?.identification?.model) ||
      '',
    mpn: safeString(identityResolved.mpn) || '',
    name:
      safeString(identityResolved.name) ||
      safeString(product?.identification?.name) ||
      '',
  };
}

// ---------------------------------------------------------------------------
// Safe executor wrapper — never throws
// ---------------------------------------------------------------------------

async function safeExecute(executor, args, name, toolsCalled) {
  if (typeof executor !== 'function') {
    return {
      ok: false,
      source: name,
      data: null,
      confidence: 0,
      meta: { durationMs: 0 },
      error: { code: 'EXECUTOR_MISSING', message: `no executor for ${name}` },
    };
  }
  const started = Date.now();
  try {
    const res = await executor(args);
    toolsCalled.push({ name, ok: Boolean(res?.ok), durationMs: Date.now() - started });
    return res;
  } catch (err) {
    toolsCalled.push({ name, ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      source: name,
      data: null,
      confidence: 0,
      meta: { durationMs: Date.now() - started },
      error: { code: 'EXECUTOR_THREW', message: err?.message || String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Extracting aspect-value candidates from executor results
// ---------------------------------------------------------------------------

function extractAspectsFromCatalogResult(result) {
  const out = [];
  if (!result || !result.ok || !result.data) return out;
  const data = result.data;

  // eBay-Catalog via executeSearchEbayCatalog (gtin mode)
  const catalog = data.catalog || data;
  const pools = [];
  if (catalog && Array.isArray(catalog.aspects)) pools.push(catalog.aspects);
  if (Array.isArray(data.suggestions)) {
    for (const suggestion of data.suggestions) {
      if (suggestion && Array.isArray(suggestion.aspects)) pools.push(suggestion.aspects);
    }
  }
  if (Array.isArray(data.aspects)) pools.push(data.aspects);

  for (const pool of pools) {
    for (const a of pool) {
      if (!a) continue;
      const key = safeString(a.key || a.name || a.localizedName);
      const value = safeString(
        a.value ?? (Array.isArray(a.values) ? a.values[0] : a.values) ?? ''
      );
      if (key && value) out.push({ key, value });
    }
  }
  return out;
}

function extractAspectsFromAmazonResult(result) {
  const out = [];
  if (!result || !result.ok || !result.data) return out;
  const data = result.data;
  const payload = data.result || data;
  const specs =
    payload?.specifications ||
    payload?.product?.specifications ||
    payload?.technical_details ||
    payload?.product_information;
  if (specs && typeof specs === 'object') {
    for (const [k, v] of Object.entries(specs)) {
      const key = safeString(k);
      const value = safeString(typeof v === 'object' ? v?.value : v);
      if (key && value) out.push({ key, value });
    }
  }
  if (Array.isArray(payload?.specs)) {
    for (const row of payload.specs) {
      const key = safeString(row?.key || row?.name);
      const value = safeString(row?.value);
      if (key && value) out.push({ key, value });
    }
  }
  return out;
}

function extractAspectsFromManufacturerResult(result) {
  const out = [];
  if (!result || !result.ok || !result.data) return out;
  const data = result.data;
  const payload = data.result || data;
  if (Array.isArray(payload?.specs)) {
    for (const row of payload.specs) {
      const key = safeString(row?.key || row?.name);
      const value = safeString(row?.value);
      if (key && value) out.push({ key, value });
    }
  }
  if (payload?.specifications && typeof payload.specifications === 'object') {
    for (const [k, v] of Object.entries(payload.specifications)) {
      const key = safeString(k);
      const value = safeString(typeof v === 'object' ? v?.value : v);
      if (key && value) out.push({ key, value });
    }
  }
  return out;
}

function extractAspectsByTool(sourceName, result) {
  switch (sourceName) {
    case 'search_ebay_catalog':
      return extractAspectsFromCatalogResult(result);
    case 'search_amazon_product':
      return extractAspectsFromAmazonResult(result);
    case 'search_manufacturer_site':
      return extractAspectsFromManufacturerResult(result);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Alias-Matcher: map a source-provided aspect-key to a required/recommended
// aspect-key when they differ only by case/whitespace/punctuation.
// ---------------------------------------------------------------------------

function buildAspectMatcher(requiredNames, recommendedNames) {
  const canonMap = new Map();
  const addMapping = (name) => {
    const canon = name;
    const norm = normKey(canon);
    if (!norm) return;
    if (!canonMap.has(norm)) canonMap.set(norm, canon);
  };
  for (const n of requiredNames) addMapping(n);
  for (const n of recommendedNames) addMapping(n);

  return function matchCanonical(raw) {
    const norm = normKey(raw);
    if (!norm) return null;
    if (canonMap.has(norm)) return canonMap.get(norm);
    // Very lightweight fallback: substring match
    for (const [k, v] of canonMap.entries()) {
      if (k.length >= 3 && (norm.includes(k) || k.includes(norm))) return v;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Build evidence rows from the three atomic-tool source results
// ---------------------------------------------------------------------------

function collectEvidenceFromSources(sourceResults, matchCanonical) {
  const evidence = []; // { key, value, source, confidence }
  for (const res of sourceResults) {
    if (!res || !res.ok) continue;
    const weightKey = mapToolSourceWeight(res.source);
    const conf = typeof res.confidence === 'number' ? res.confidence : 0.5;
    const aspects = extractAspectsByTool(res.source, res);
    for (const a of aspects) {
      const canonical = matchCanonical(a.key) || a.key;
      evidence.push({
        key: canonical,
        value: a.value,
        source: weightKey,
        confidence: conf,
      });
    }
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Pure cross-reference path (no Gemini)
// ---------------------------------------------------------------------------

function crossReferenceAspects({
  requiredNames,
  recommendedNames,
  evidence,
}) {
  const allAspectKeys = [...requiredNames, ...recommendedNames];
  const seen = new Set();
  const result = [];

  for (const key of allAspectKeys) {
    const kNorm = normKey(key);
    if (!kNorm || seen.has(kNorm)) continue;
    seen.add(kNorm);
    const candidates = evidence
      .filter((e) => normKey(e.key) === kNorm)
      .map((e) => ({ source: e.source, value: e.value, confidence: e.confidence }));

    if (candidates.length === 0) continue;

    const consensus = resolveConsensus('attribute', candidates);
    if (consensus.value == null) continue;
    const scored = scoreField(
      'attribute',
      consensus.value,
      candidates.map((c) => ({ source: c.source, value: c.value }))
    );
    const uniqueSources = [...new Set(candidates.map((c) => c.source))];
    result.push({
      key,
      value: String(consensus.value),
      confidence: Number(scored.score.toFixed(4)),
      sources: uniqueSources,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Fill required aspects with "Unbekannt" when still missing
// ---------------------------------------------------------------------------

function fillMissingRequired(existingAspects, requiredNames) {
  const existingByKey = new Map();
  for (const a of existingAspects) existingByKey.set(normKey(a.key), a);
  const result = [...existingAspects];
  for (const reqName of requiredNames) {
    const nk = normKey(reqName);
    if (!nk || existingByKey.has(nk)) continue;
    result.push({
      key: reqName,
      value: 'Unbekannt',
      confidence: 0,
      sources: [],
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compute requiredAspectsCoverage
// ---------------------------------------------------------------------------

function computeRequiredCoverage(aspects, requiredNames) {
  const totalRequired = requiredNames.length;
  if (totalRequired === 0) return 1;
  const filledKeys = new Set(
    aspects
      .filter((a) => a && a.value && a.value !== 'Unbekannt' && (a.confidence ?? 0) > 0)
      .map((a) => normKey(a.key))
  );
  let filled = 0;
  for (const name of requiredNames) {
    if (filledKeys.has(normKey(name))) filled += 1;
  }
  return Number((filled / totalRequired).toFixed(4));
}

// ---------------------------------------------------------------------------
// Gemini finalization loop (optional)
// ---------------------------------------------------------------------------

async function runGeminiFinalization({
  context,
  requiredNames,
  recommendedNames,
  evidence,
  toolsCalled,
  geminiCallCounter,
  tokensAccumulator,
}) {
  const aiClient = context && context.aiClient;
  if (!aiClient || !aiClient.chats || typeof aiClient.chats.create !== 'function') {
    return { finalized: null, error: null };
  }

  const model = resolveChatModel();
  const tools = [
    {
      functionDeclarations: [FINALIZE_ATTRIBUTES_DECLARATION],
    },
  ];

  const evidenceSummary = evidence
    .map((e) => `- ${e.key}: "${e.value}" (source=${e.source}, conf=${e.confidence})`)
    .join('\n');

  const userMessage = [
    'Kategorie-Aspects:',
    `Required (${requiredNames.length}): ${requiredNames.join(', ') || '—'}`,
    `Recommended (${recommendedNames.length}): ${recommendedNames.join(', ') || '—'}`,
    '',
    'Rohdaten aus Quellen:',
    evidenceSummary || '(keine)',
    '',
    'Fülle JEDEN required Aspect. Finalisiere mit finalize_attributes.',
  ].join('\n');

  const config = {
    temperature: DEFAULT_CHAT_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: false }),
    safetySettings: defaultSafetySettings(),
    tools,
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: [FINALIZE_TOOL],
      },
    },
    systemInstruction: SYSTEM_PROMPT,
  };

  let chat;
  try {
    chat = aiClient.chats.create({ model, config, history: [] });
  } catch (err) {
    return { finalized: null, error: `chats.create failed: ${err?.message || err}` };
  }

  let response;
  let finalized = null;
  let iteration = 0;

  try {
    geminiCallCounter.count += 1;
    response = await chat.sendMessage({ message: [{ text: userMessage }] });
    if (response?.usageMetadata?.totalTokenCount) {
      tokensAccumulator.total += response.usageMetadata.totalTokenCount;
    }
  } catch (err) {
    return { finalized: null, error: `sendMessage failed: ${err?.message || err}` };
  }

  while (
    response &&
    Array.isArray(response.functionCalls) &&
    response.functionCalls.length > 0 &&
    iteration < MAX_WORKER_ITERATIONS
  ) {
    iteration += 1;
    const toolResponses = [];
    for (const call of response.functionCalls) {
      const callName = call?.name || 'unknown';
      const callArgs = call?.args || {};
      const callId = call?.id || null;

      if (callName === FINALIZE_TOOL) {
        finalized = callArgs || {};
        toolResponses.push({
          functionResponse: {
            id: callId || undefined,
            name: callName,
            response: { ok: true, accepted: true },
          },
        });
        continue;
      }

      // Unexpected tool call (mode=ANY should prevent this, but be safe).
      toolsCalled.push({ name: callName, ok: false, durationMs: 0 });
      toolResponses.push({
        functionResponse: {
          id: callId || undefined,
          name: callName,
          response: { ok: false, error: 'tool_not_declared' },
        },
      });
    }

    if (finalized) break;

    try {
      geminiCallCounter.count += 1;
      // eslint-disable-next-line no-await-in-loop
      response = await chat.sendMessage({ message: toolResponses });
      if (response?.usageMetadata?.totalTokenCount) {
        tokensAccumulator.total += response.usageMetadata.totalTokenCount;
      }
    } catch (err) {
      return {
        finalized,
        error: `sendMessage iter ${iteration} failed: ${err?.message || err}`,
      };
    }
  }

  return { finalized, error: null };
}

function mergeFinalizedWithEvidence({
  finalized,
  crossRefAspects,
  requiredNames,
  recommendedNames,
}) {
  if (!finalized || !Array.isArray(finalized.aspects)) return crossRefAspects;

  const allowedNorms = new Set(
    [...requiredNames, ...recommendedNames].map((n) => normKey(n))
  );
  const byKey = new Map();
  for (const a of crossRefAspects) byKey.set(normKey(a.key), a);

  for (const row of finalized.aspects) {
    if (!row || typeof row !== 'object') continue;
    const key = safeString(row.key);
    const nk = normKey(key);
    if (!nk) continue;
    // Only accept aspects that are part of required/recommended or already
    // resolved via cross-reference.
    if (!allowedNorms.has(nk) && !byKey.has(nk)) continue;

    const value = safeString(row.value);
    const conf =
      typeof row.confidence === 'number' && Number.isFinite(row.confidence)
        ? Math.max(0, Math.min(1, row.confidence))
        : 0;
    const sources = Array.isArray(row.sources)
      ? row.sources.map((s) => safeString(s)).filter(Boolean)
      : [];
    const previous = byKey.get(nk);
    if (!previous) {
      byKey.set(nk, { key, value, confidence: conf, sources });
      continue;
    }
    // Prefer the higher-confidence entry; if tied, prefer the Gemini one when
    // it supplies a non-empty value and the cross-ref didn't.
    if (conf > (previous.confidence || 0)) {
      byKey.set(nk, { key: previous.key, value, confidence: conf, sources });
    } else if (
      (!previous.value || previous.value === 'Unbekannt') &&
      value &&
      value !== 'Unbekannt'
    ) {
      byKey.set(nk, { key: previous.key, value, confidence: conf, sources });
    }
  }

  return Array.from(byKey.values());
}

// ---------------------------------------------------------------------------
// Main worker entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   product?: object,
 *   identity?: { brand?: string, model?: string, mpn?: string, name?: string },
 *   barcodes?: object,
 *   workerResults?: {
 *     identity?: { resolved?: object },
 *     category?: {
 *       resolved?: {
 *         requiredAspects?: any[],
 *         recommendedAspects?: any[],
 *         categoryId?: string,
 *       }
 *     }
 *   },
 *   aiClient?: object,
 *   locale?: string,
 *   tenantId?: string
 * }} context
 */
async function runAttributesWorker(context = {}) {
  const startedAt = Date.now();
  const toolsCalled = [];
  const geminiCallCounter = { count: 0 };
  const tokensAccumulator = { total: 0 };
  const sources = [];
  let lastError = null;

  try {
    if (!context || typeof context !== 'object') {
      return {
        ok: false,
        domain: DOMAIN,
        resolved: { item_specifics: [], requiredAspectsCoverage: 0, aspectCap: { applied: false, removedCount: 0 } },
        confidence: { item_specifics: 0, requiredAspects: 0 },
        sources,
        retriesRequested: [],
        meta: {
          durationMs: Date.now() - startedAt,
          toolsCalled,
          geminiCalls: 0,
          error: 'missing_context',
        },
      };
    }
    if (!context.product || typeof context.product !== 'object') {
      return {
        ok: false,
        domain: DOMAIN,
        resolved: { item_specifics: [], requiredAspectsCoverage: 0, aspectCap: { applied: false, removedCount: 0 } },
        confidence: { item_specifics: 0, requiredAspects: 0 },
        sources,
        retriesRequested: [],
        meta: {
          durationMs: Date.now() - startedAt,
          toolsCalled,
          geminiCalls: 0,
          error: 'missing_product',
        },
      };
    }

    const categoryResolved = context?.workerResults?.category?.resolved || {};
    const requiredNames = toAspectNameList(categoryResolved.requiredAspects);
    const recommendedNames = toAspectNameList(categoryResolved.recommendedAspects);

    // Early-exit: no aspects to fill.
    if (requiredNames.length === 0 && recommendedNames.length === 0) {
      return {
        ok: true,
        domain: DOMAIN,
        resolved: {
          item_specifics: [],
          requiredAspectsCoverage: 1,
          aspectCap: { applied: false, removedCount: 0 },
        },
        confidence: { item_specifics: 0, requiredAspects: 1 },
        sources,
        retriesRequested: [],
        meta: {
          durationMs: Date.now() - startedAt,
          toolsCalled,
          geminiCalls: 0,
          error: null,
        },
      };
    }

    const matchCanonical = buildAspectMatcher(requiredNames, recommendedNames);
    const gtin = pickGtinFromContext(context);
    const hints = pickIdentityHints(context);

    // ---- Three parallel sources -------------------------------------------
    const executors = (atomicTools && atomicTools.executors) || {};
    const executorMap =
      typeof atomicTools.buildToolExecutorMap === 'function'
        ? atomicTools.buildToolExecutorMap()
        : {};

    const exCatalog =
      executorMap.search_ebay_catalog || executors.executeSearchEbayCatalog;
    const exAmazon =
      executorMap.search_amazon_product || executors.executeSearchAmazonProduct;
    const exManufacturer =
      executorMap.search_manufacturer_site || executors.executeSearchManufacturerSite;

    const queryBase = [hints.brand, hints.model || hints.mpn, hints.name]
      .filter(Boolean)
      .join(' ')
      .trim();

    const sourceResults = await Promise.all([
      safeExecute(
        exCatalog,
        {
          gtin: gtin || undefined,
          query: queryBase || undefined,
          marketplace: 'EBAY_DE',
        },
        'search_ebay_catalog',
        toolsCalled
      ),
      safeExecute(
        exAmazon,
        {
          gtin: gtin || undefined,
          query: queryBase || undefined,
          region: (context.locale || '').toLowerCase().startsWith('de') ? 'DE' : 'DE',
        },
        'search_amazon_product',
        toolsCalled
      ),
      hints.brand
        ? safeExecute(
            exManufacturer,
            { brand: hints.brand, model: hints.model || undefined, mpn: hints.mpn || undefined },
            'search_manufacturer_site',
            toolsCalled
          )
        : Promise.resolve({
            ok: false,
            source: 'search_manufacturer_site',
            data: null,
            confidence: 0,
            meta: { durationMs: 0 },
            error: { code: 'MISSING_BRAND', message: 'no brand hint' },
          }),
    ]);

    for (const res of sourceResults) {
      if (!res) continue;
      sources.push({
        type: res.source,
        ok: Boolean(res.ok),
        confidence: typeof res.confidence === 'number' ? res.confidence : 0,
        aspects: res.ok ? extractAspectsByTool(res.source, res).length : 0,
        error: res.ok ? null : res?.error?.code || res?.error?.message || null,
      });
    }

    // ---- Cross-reference evidence -----------------------------------------
    const evidence = collectEvidenceFromSources(sourceResults, matchCanonical);

    let aspects = crossReferenceAspects({
      requiredNames,
      recommendedNames,
      evidence,
    });

    // ---- Optional Gemini finalization -------------------------------------
    if (context.aiClient) {
      const geminiRes = await runGeminiFinalization({
        context,
        requiredNames,
        recommendedNames,
        evidence,
        toolsCalled,
        geminiCallCounter,
        tokensAccumulator,
      });
      if (geminiRes.error) {
        lastError = geminiRes.error;
      }
      if (geminiRes.finalized) {
        aspects = mergeFinalizedWithEvidence({
          finalized: geminiRes.finalized,
          crossRefAspects: aspects,
          requiredNames,
          recommendedNames,
        });
      }
    }

    // ---- Fill missing required with Unbekannt -----------------------------
    aspects = fillMissingRequired(aspects, requiredNames);

    // ---- Enforce 45-cap ---------------------------------------------------
    const capResult = enforceAspectCap(aspects, {
      requiredAspects: requiredNames,
      recommendedAspects: recommendedNames,
      maxCap: ASPECT_HARD_CAP,
    });

    // Preserve sources/confidence metadata from our aspect objects when the
    // cap-enforcer strips them. Re-merge by normalized key.
    const aspectByNorm = new Map();
    for (const a of aspects) aspectByNorm.set(normKey(a.key), a);

    const finalAspects = capResult.trimmed.map((t) => {
      const origin = aspectByNorm.get(normKey(t.key));
      return {
        key: t.key,
        value: t.value,
        confidence:
          origin && typeof origin.confidence === 'number'
            ? Number(origin.confidence.toFixed(4))
            : typeof t.confidence === 'number'
            ? Number(t.confidence.toFixed(4))
            : 0,
        sources: origin && Array.isArray(origin.sources) ? origin.sources : [],
      };
    });

    // ---- Coverage + confidence --------------------------------------------
    const coverage = computeRequiredCoverage(finalAspects, requiredNames);

    const confidenceValues = finalAspects
      .filter((a) => a.value && a.value !== 'Unbekannt')
      .map((a) => (typeof a.confidence === 'number' ? a.confidence : 0));
    const avgItemConfidence =
      confidenceValues.length > 0
        ? Number(
            (confidenceValues.reduce((s, n) => s + n, 0) / confidenceValues.length).toFixed(4)
          )
        : 0;

    return {
      ok: true,
      domain: DOMAIN,
      resolved: {
        item_specifics: finalAspects,
        requiredAspectsCoverage: coverage,
        aspectCap: {
          applied: capResult.meta.removedCount > 0,
          removedCount: capResult.meta.removedCount,
        },
      },
      confidence: {
        item_specifics: avgItemConfidence,
        requiredAspects: coverage,
      },
      sources,
      retriesRequested: [],
      meta: {
        durationMs: Date.now() - startedAt,
        toolsCalled,
        geminiCalls: geminiCallCounter.count,
        error: lastError,
      },
    };
  } catch (err) {
    return {
      ok: false,
      domain: DOMAIN,
      resolved: {
        item_specifics: [],
        requiredAspectsCoverage: 0,
        aspectCap: { applied: false, removedCount: 0 },
      },
      confidence: { item_specifics: 0, requiredAspects: 0 },
      sources,
      retriesRequested: [],
      meta: {
        durationMs: Date.now() - startedAt,
        toolsCalled,
        geminiCalls: geminiCallCounter.count,
        error: err?.message || String(err),
      },
    };
  }
}

module.exports = {
  runAttributesWorker,
  DOMAIN,
  FINALIZE_ATTRIBUTES_DECLARATION,
  SYSTEM_PROMPT,
  _testables: {
    toAspectNameList,
    aspectName,
    buildAspectMatcher,
    extractAspectsFromCatalogResult,
    extractAspectsFromAmazonResult,
    extractAspectsFromManufacturerResult,
    extractAspectsByTool,
    collectEvidenceFromSources,
    crossReferenceAspects,
    fillMissingRequired,
    computeRequiredCoverage,
    mergeFinalizedWithEvidence,
    mapToolSourceWeight,
    pickGtinFromContext,
    pickIdentityHints,
    MAX_WORKER_ITERATIONS,
    ASPECT_HARD_CAP,
  },
};
