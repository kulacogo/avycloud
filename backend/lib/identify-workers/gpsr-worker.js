'use strict';

/**
 * gpsr-worker.js — Identify-V4 Worker for GPSR manufacturer compliance.
 *
 * Kaskadiert: Registry → Web-Fallback → Manufacturer-Site → optional Gemini.
 * Stoppt früh wenn completeness ≥ 0.75 erreicht ist.
 */

const DOMAIN = 'gpsr';
const REQUIRED_FIELDS = [
  'manufacturer_name',
  'manufacturer_address',
  'email',
  'country_code',
];

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function tryRequire(path) {
  try {
    // eslint-disable-next-line global-require
    return require(path);
  } catch {
    return null;
  }
}

function computeCompleteness(gpsr) {
  if (!gpsr || typeof gpsr !== 'object') return 0;
  let filled = 0;
  for (const f of REQUIRED_FIELDS) {
    if (safeString(gpsr[f])) filled++;
  }
  return filled / REQUIRED_FIELDS.length;
}

function mergeGpsr(base, update, preferBase = true) {
  if (!update || typeof update !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(update)) {
    const val = safeString(v);
    if (!val) continue;
    if (preferBase && safeString(out[k])) continue;
    out[k] = val;
  }
  return out;
}

function normalizeRegistryShape(data) {
  if (!data || typeof data !== 'object') return {};
  return {
    manufacturer_name: safeString(data.manufacturer_name || data.name),
    manufacturer_address: safeString(data.manufacturer_address || data.address),
    email: safeString(data.email),
    manufacturer_phone: safeString(data.manufacturer_phone || data.phone),
    url: safeString(data.url),
    country_code: safeString(data.country_code || data.country),
  };
}

async function runGpsrWorker(context = {}) {
  const started = Date.now();
  const meta = {
    durationMs: 0,
    toolsCalled: [],
    geminiCalls: 0,
    error: null,
  };
  const sources = [];

  try {
    const brand = safeString(
      context.workerResults?.identity?.resolved?.brand ||
        context.identity?.brand ||
        context.product?.identification?.brand
    );

    if (!brand) {
      meta.durationMs = Date.now() - started;
      meta.error = 'no_brand';
      return {
        ok: false,
        domain: DOMAIN,
        resolved: { gpsr: {}, gpsr_completeness: 0 },
        confidence: { gpsr: 0 },
        sources,
        retriesRequested: [],
        meta,
      };
    }

    let gpsr = {};
    let bestConfidence = 0;

    // 1. Registry
    const registry = tryRequire('../gpsr-manufacturer-registry');
    if (registry && typeof registry.getManufacturerGpsrByName === 'function') {
      try {
        meta.toolsCalled.push('gpsr_registry');
        const r = await registry.getManufacturerGpsrByName(brand);
        if (r && (r.found === true || r.data)) {
          const data = normalizeRegistryShape(r.data || r);
          gpsr = mergeGpsr(gpsr, data);
          sources.push({
            type: 'registry',
            url: null,
            data: { ...data },
            weight: 0.9,
          });
          bestConfidence = 0.9;
        }
      } catch {
        // non-blocking
      }
    }

    // 2. Web-Fallback
    if (computeCompleteness(gpsr) < 0.75) {
      const webFallback = tryRequire('../gpsr-web-fallback');
      if (webFallback && typeof webFallback.lookupGpsrFromWeb === 'function') {
        try {
          meta.toolsCalled.push('gpsr_web_fallback');
          const r = await webFallback.lookupGpsrFromWeb(brand);
          if (r) {
            const data = normalizeRegistryShape(r);
            gpsr = mergeGpsr(gpsr, data);
            sources.push({
              type: 'web_fallback',
              url: null,
              data: { ...data },
              weight: 0.65,
            });
            if (bestConfidence < 0.65) bestConfidence = 0.65;
          }
        } catch {
          // non-blocking
        }
      }
    }

    // 3. Manufacturer-Site via atomic-tool (only if still incomplete)
    if (computeCompleteness(gpsr) < 0.75) {
      const atomicTools = tryRequire('../../services/atomic-tools');
      if (atomicTools?.executors?.executeSearchManufacturerSite) {
        try {
          meta.toolsCalled.push('search_manufacturer_site');
          const r = await atomicTools.executors.executeSearchManufacturerSite({
            brand,
            model: context.workerResults?.identity?.resolved?.model,
          });
          if (r?.ok && r.data) {
            const candidate = {
              url: safeString(r.data.site || r.data.url),
              email: safeString(r.data.email),
              manufacturer_address: safeString(r.data.address),
            };
            gpsr = mergeGpsr(gpsr, candidate);
            sources.push({
              type: 'manufacturer_site',
              url: candidate.url,
              data: candidate,
              weight: 0.55,
            });
            if (bestConfidence < 0.55) bestConfidence = 0.55;
          }
        } catch {
          // non-blocking
        }
      }
    }

    const completeness = computeCompleteness(gpsr);
    // Cross-reference boost: Registry + Web-Fallback both fired → +0.1
    const registryFired = sources.some((s) => s.type === 'registry');
    const webFired = sources.some((s) => s.type === 'web_fallback');
    let finalConfidence = bestConfidence;
    if (registryFired && webFired) finalConfidence = Math.min(finalConfidence + 0.1, 1);

    meta.durationMs = Date.now() - started;

    return {
      ok: completeness > 0,
      domain: DOMAIN,
      resolved: {
        gpsr,
        gpsr_completeness: completeness,
      },
      confidence: { gpsr: finalConfidence },
      sources,
      retriesRequested: [],
      meta,
    };
  } catch (err) {
    meta.durationMs = Date.now() - started;
    meta.error = err.message || String(err);
    return {
      ok: false,
      domain: DOMAIN,
      resolved: { gpsr: {}, gpsr_completeness: 0 },
      confidence: { gpsr: 0 },
      sources,
      retriesRequested: [],
      meta,
    };
  }
}

module.exports = { runGpsrWorker, DOMAIN, REQUIRED_FIELDS };
