'use strict';

/**
 * critic-worker.js
 *
 * Finaler Validation-Agent der Identify-V4-Pipeline. Non-blocking reporter —
 * liefert IMMER `ok: true`. Sammelt Issues, berechnet einen ebay_ready_score,
 * schlägt Refinement-Runden vor und optional Fix-Hints via Gemini-Flash.
 *
 *   context = {
 *     product,               // assembled product from Wave 1 + Wave 2 merges
 *     aiClient?,             // optional @google/genai client — enables Flash-Call
 *     requiredAspects?,      // string[] — wenn nicht gesetzt, wird aus ebay-taxonomy geladen
 *     recommendedAspects?,   // string[]
 *   }
 *
 * Kein Gemini-Pro-Call. Kein Throw. Pure ausser optionalem Flash-Call.
 */

const { evaluateEbayReady } = require('../datasheet-quality');
const { isValidGtin } = require('../gtin');
const { enforceAspectCap } = require('../aspect-cap-enforcer');
const { FLASH_MODEL } = require('../gemini-config');

// F.1b.2 — caller-migration. Scope 'identify.critic' is not yet seeded in
// Firestore (lands in F.2). Until then resolveScopeConfig() will fail; we
// catch + fall back to hardcoded defaults below.
let _resolveScopeConfig = null;
try {
  // eslint-disable-next-line global-require
  ({ resolveScopeConfig: _resolveScopeConfig } = require('../llm-config'));
} catch (_err) {
  _resolveScopeConfig = null;
}
let _logger = null;
try {
  // eslint-disable-next-line global-require
  _logger = require('../logger');
} catch (_err) {
  _logger = null;
}

const SCOPE_NAME = 'identify.critic';

let getRequiredAspectsFn = null;
try {
  // best-effort: ebay-taxonomy may load large JSON on require — lazy guard.
  ({ getRequiredAspects: getRequiredAspectsFn } = require('../ebay-taxonomy'));
} catch (_err) {
  getRequiredAspectsFn = null;
}

const ERROR_PENALTY = 0.15;
const WARNING_PENALTY = 0.05;

// Field → Worker mapping for refinement suggestions
const FIELD_TO_WORKER = Object.freeze({
  required_aspects: 'attributes',
  attributes: 'attributes',
  title: 'seo',
  description: 'seo',
  price: 'pricing',
  images: 'image',
  gpsr: 'gpsr',
  categoryId: 'category',
  category: 'category',
  ean: 'identity',
  gtin: 'identity',
  upc: 'identity',
});

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pickGtinCandidate(product) {
  const ident = product && product.identification ? product.identification : {};
  const details = product && product.details ? product.details : {};
  const candidates = [
    { field: 'gtin', value: ident.gtin || details.gtin },
    { field: 'ean', value: ident.ean || details.ean },
    { field: 'upc', value: ident.upc || details.upc },
  ];
  for (const c of candidates) {
    const v = safeString(c.value);
    if (v) return { field: c.field, value: v };
  }
  return null;
}

function resolveRequiredAspects(product, overrides) {
  if (Array.isArray(overrides) && overrides.length) return overrides.slice();
  const catId = safeString(
    (product && product.details && (product.details.categoryId || product.details.ebayCategoryId)) || ''
  );
  if (!catId || typeof getRequiredAspectsFn !== 'function') return [];
  try {
    const list = getRequiredAspectsFn(catId);
    return Array.isArray(list) ? list.slice() : [];
  } catch (_err) {
    return [];
  }
}

function hasAcceptableImages(product) {
  const imgs =
    product && product.details && Array.isArray(product.details.images) ? product.details.images : [];
  if (!imgs.length) return { present: false, qualified: false };
  const iq =
    product && product.ops && product.ops.image_quality ? product.ops.image_quality : null;
  if (iq && Array.isArray(iq.items) && iq.items.length) {
    const qualified = iq.items.some((it) => it && it.meetsMinResolution === true);
    return { present: true, qualified };
  }
  // No quality metadata — count any image with url/url_or_base64 as qualified.
  const qualified = imgs.some(
    (img) => img && (img.meetsMinResolution === true || img.url_or_base64 || img.url || img.href)
  );
  return { present: true, qualified };
}

function mapFieldToWorker(field) {
  if (!field) return null;
  const key = String(field).trim().toLowerCase();
  if (FIELD_TO_WORKER[key]) return FIELD_TO_WORKER[key];
  if (key.startsWith('required_aspect')) return FIELD_TO_WORKER.required_aspects;
  if (key.includes('image')) return FIELD_TO_WORKER.images;
  if (key.includes('price')) return FIELD_TO_WORKER.price;
  if (key.includes('title')) return FIELD_TO_WORKER.title;
  if (key.includes('description')) return FIELD_TO_WORKER.description;
  if (key.includes('gpsr')) return FIELD_TO_WORKER.gpsr;
  if (key.includes('category')) return FIELD_TO_WORKER.category;
  if (key === 'ean' || key === 'gtin' || key === 'upc' || key.includes('identif')) {
    return FIELD_TO_WORKER.ean;
  }
  return null;
}

async function maybeFlashFixHints(aiClient, product, issues) {
  if (!aiClient || !aiClient.models || typeof aiClient.models.generateContent !== 'function') {
    return { hints: [], calls: 0, error: null };
  }
  if (!Array.isArray(issues) || !issues.length) return { hints: [], calls: 0, error: null };

  const flag = String(process.env.IDENTIFY_V4_CRITIC_FLASH || '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') {
    return { hints: [], calls: 0, error: null };
  }

  const compactIssues = issues.slice(0, 20).map((i) => ({
    field: i.field,
    severity: i.severity,
    message: i.message,
  }));

  const prompt = [
    'Du bist ein eBay-Listing-Qualitäts-Critic.',
    'Hier ist ein Produkt mit Issues.',
    'Gib maximal 3 konkrete, kurze Fix-Hints als JSON-Array zurück.',
    'Jeder Hint hat Schema: { "worker": "attributes"|"seo"|"pricing"|"image"|"gpsr"|"category"|"identity", "suggestion": "kurzer Satz" }.',
    '',
    'PRODUKT-SNAPSHOT:',
    JSON.stringify(
      {
        title: safeString(product && product.identification && product.identification.name),
        category: safeString(product && product.identification && product.identification.category),
        categoryId: safeString(
          product && product.details && (product.details.categoryId || product.details.ebayCategoryId)
        ),
        attributes_count: product && product.details && product.details.attributes
          ? Object.keys(product.details.attributes).length
          : 0,
      },
      null,
      2
    ),
    '',
    'ISSUES:',
    JSON.stringify(compactIssues, null, 2),
  ].join('\n');

  // F.1b.2 — scope-resolution with graceful fallback. Pass current hardcoded
  // values as callerOverrides so behaviour is unchanged when scope-version has
  // no generationConfig override.
  const fallbackTemperature = 0.1;
  const fallbackModel = FLASH_MODEL;
  let scopeModel = fallbackModel;
  let scopeGenCfg = { temperature: fallbackTemperature, responseMimeType: 'application/json' };
  if (typeof _resolveScopeConfig === 'function') {
    try {
      const resolved = await _resolveScopeConfig(SCOPE_NAME, null, {
        generationConfig: {
          temperature: fallbackTemperature,
          responseMimeType: 'application/json',
        },
        model: fallbackModel,
      });
      if (resolved && resolved.generationConfig && typeof resolved.generationConfig === 'object') {
        scopeGenCfg = resolved.generationConfig;
      }
      if (resolved && typeof resolved.model === 'string' && resolved.model.trim()) {
        scopeModel = resolved.model.trim();
      }
    } catch (err) {
      if (_logger && typeof _logger.warn === 'function') {
        _logger.warn(
          { scope: SCOPE_NAME, reason: err && err.message ? err.message : String(err) },
          '[critic-worker] resolveScopeConfig failed, using hardcoded defaults'
        );
      }
    }
  }

  try {
    const resp = await aiClient.models.generateContent({
      model: scopeModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType:
          typeof scopeGenCfg.responseMimeType === 'string'
            ? scopeGenCfg.responseMimeType
            : 'application/json',
        temperature:
          typeof scopeGenCfg.temperature === 'number' ? scopeGenCfg.temperature : fallbackTemperature,
      },
    });
    const text =
      (resp && typeof resp.text === 'string' && resp.text) ||
      (resp && typeof resp.text === 'function' && resp.text()) ||
      (resp &&
        resp.candidates &&
        resp.candidates[0] &&
        resp.candidates[0].content &&
        Array.isArray(resp.candidates[0].content.parts) &&
        resp.candidates[0].content.parts
          .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
          .join('')) ||
      '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_parseErr) {
      return { hints: [], calls: 1, error: 'parse_error' };
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.hints)
        ? parsed.hints
        : [];
    const hints = arr
      .map((h) => {
        if (!h || typeof h !== 'object') return null;
        const worker = safeString(h.worker);
        const suggestion = safeString(h.suggestion);
        if (!worker || !suggestion) return null;
        return { worker, suggestion };
      })
      .filter(Boolean)
      .slice(0, 3);
    return { hints, calls: 1, error: null };
  } catch (err) {
    return { hints: [], calls: 1, error: err && err.message ? err.message : 'flash_error' };
  }
}

/**
 * runCriticWorker(context)
 *
 * @param {object} context
 * @param {object} context.product  assembled product
 * @param {object} [context.aiClient] Optional @google/genai client
 * @param {string[]} [context.requiredAspects]
 * @param {string[]} [context.recommendedAspects]
 */
async function runCriticWorker(context = {}) {
  const started = Date.now();
  const meta = { durationMs: 0, geminiCalls: 0, error: null };
  const product = (context && context.product) || {};

  const issues = [];

  // 1. evaluateEbayReady base check
  let baseReport;
  try {
    baseReport = evaluateEbayReady(product, { force: true });
  } catch (err) {
    meta.error = err && err.message ? err.message : 'evaluate_error';
    baseReport = { ok: true, issues: [], issuesDetailed: [], missingRequiredAspects: [] };
  }
  const baseIssues = Array.isArray(baseReport && baseReport.issuesDetailed) && baseReport.issuesDetailed.length
    ? baseReport.issuesDetailed
    : (Array.isArray(baseReport && baseReport.issues) ? baseReport.issues : []).map((code) => ({
        code: String(code),
        severity: 'error',
        field: String(code).split(/[_:\s]/)[0],
        message: String(code),
      }));
  for (const d of baseIssues) {
    const field =
      (d && d.field && String(d.field)) ||
      (d && d.code && String(d.code).split(/[_:\s]/)[0]) ||
      'unknown';
    const severity = d && d.severity === 'warning' ? 'warning' : 'error';
    const message = (d && (d.message || d.code)) || 'issue';
    issues.push({ field, severity, message: String(message) });
  }

  // 2. GTIN check
  const gtinCandidate = pickGtinCandidate(product);
  if (gtinCandidate) {
    if (!isValidGtin(gtinCandidate.value)) {
      issues.push({
        field: gtinCandidate.field,
        severity: 'error',
        message: `Invalid ${gtinCandidate.field.toUpperCase()} checksum: ${gtinCandidate.value}`,
      });
    }
  }

  // 3. Aspect-cap check
  const requiredAspects = resolveRequiredAspects(product, context.requiredAspects);
  const recommendedAspects = Array.isArray(context.recommendedAspects)
    ? context.recommendedAspects
    : [];
  const attrs =
    product && product.details && product.details.attributes ? product.details.attributes : {};
  let aspectCapApplied = false;
  try {
    const capResult = enforceAspectCap(attrs, {
      requiredAspects,
      recommendedAspects,
      maxCap: 45,
    });
    if (capResult && capResult.meta) {
      if (capResult.meta.removedCount > 0) aspectCapApplied = true;
      const missing = Array.isArray(capResult.meta.requiredMissing)
        ? capResult.meta.requiredMissing
        : [];
      if (missing.length > 0) {
        // Avoid duplicating the evaluateEbayReady "missing_required_aspects" issue
        const alreadyHas = issues.some(
          (i) => i.field === 'required_aspects' || /missing_required_aspects/i.test(i.message)
        );
        if (!alreadyHas) {
          issues.push({
            field: 'required_aspects',
            severity: 'error',
            message: `Missing required aspects: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`,
          });
        }
      }
    }
  } catch (err) {
    meta.error = meta.error || (err && err.message) || 'aspect_cap_error';
  }

  // 4. GPSR check
  const gpsr = product && product.details && product.details.gpsr ? product.details.gpsr : null;
  const gpsrName = safeString(gpsr && (gpsr.manufacturer_name || gpsr.manufacturerName));
  const gpsrAddr = safeString(gpsr && (gpsr.manufacturer_address || gpsr.manufacturerAddress));
  if (!gpsrName || !gpsrAddr) {
    const hasGpsrIssue = issues.some((i) => i.field === 'gpsr');
    if (!hasGpsrIssue) {
      issues.push({
        field: 'gpsr',
        severity: 'warning',
        message: 'GPSR requires manufacturer_name and manufacturer_address',
      });
    }
  }

  // 5. Images check
  const imageStatus = hasAcceptableImages(product);
  if (!imageStatus.present || !imageStatus.qualified) {
    const alreadyImageIssue = issues.some((i) => i.field === 'images' || /images?_missing/i.test(i.message));
    if (!alreadyImageIssue) {
      issues.push({
        field: 'images',
        severity: 'warning',
        message: imageStatus.present
          ? 'No image meets minimum resolution'
          : 'No images attached to product',
      });
    }
  }

  // 6. ebay_ready_score
  let score = 1.0;
  for (const i of issues) {
    if (i.severity === 'error') score -= ERROR_PENALTY;
    else if (i.severity === 'warning') score -= WARNING_PENALTY;
  }
  const ebayReadyScore = clamp01(score);

  // 7. refinement_needed_workers
  const workerSet = new Set();
  for (const i of issues) {
    const w = mapFieldToWorker(i.field);
    if (w) workerSet.add(w);
  }
  const refinementNeededWorkers = Array.from(workerSet);

  // 8. Optional Flash-Call for fix_hints
  let fixHints = [];
  const flashResult = await maybeFlashFixHints(context.aiClient, product, issues);
  fixHints = flashResult.hints;
  meta.geminiCalls = flashResult.calls;
  if (flashResult.error && !meta.error) meta.error = flashResult.error;

  meta.durationMs = Date.now() - started;

  return {
    ok: true,
    domain: 'critic',
    resolved: {
      critiqued: true,
      issues,
      fix_hints: fixHints,
      ebay_ready_score: ebayReadyScore,
      aspect_cap_applied: aspectCapApplied,
      refinement_needed_workers: refinementNeededWorkers,
    },
    confidence: { ebay_ready: ebayReadyScore },
    sources: [],
    retriesRequested: [],
    meta,
  };
}

module.exports = {
  runCriticWorker,
  // exposed for tests
  _internal: {
    mapFieldToWorker,
    pickGtinCandidate,
    hasAcceptableImages,
    ERROR_PENALTY,
    WARNING_PENALTY,
  },
};
