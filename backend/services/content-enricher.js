'use strict';

/**
 * content-enricher.js — lift an EXISTING product's datasheet CONTENT up to the
 * eBay-ready standard, in-place, gap-aware, in a bounded loop.
 *
 * HARD CONTRACT (see docs/superpowers/specs/2026-06-06-bulk-datenblatt-veredelung-design.md):
 *   - Never creates a product, never mutates inventory / sku / storage / storageBins / identity.
 *   - Only touches content fields (title, description, pricing, attributes, gpsr, weight).
 *   - Does NOT persist and does NOT push to marketplaces — the caller decides.
 *
 * All external building blocks are injected via opts.deps so the orchestration
 * is deterministic and offline-testable. Real implementations are required
 * lazily, only when a dep is actually used.
 */

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Lazily resolve a dependency: prefer the caller-provided override, otherwise
// require the real module on first use and cache it.
function buildDepResolver(provided = {}) {
  const cache = {};
  const loaders = {
    evaluateEbayReady: () => require('../lib/datasheet-quality').evaluateEbayReady,
    getPriceStatus: () => require('../lib/datasheet-quality').getPriceStatus,
    computeSweetSpotPrice: () => require('../lib/sweet-spot-pricer').computeSweetSpotPrice,
    buildEbayTitle: () => require('../lib/seo-title-builder').buildEbayTitle,
    coerceTitleToPolicy: () => require('../lib/title-policy').coerceTitleToPolicy,
    buildEbayDescription: () => require('../lib/seo-description-builder').buildEbayDescription,
    enforceAspectCap: () => require('../lib/aspect-cap-enforcer').enforceAspectCap,
    getRequiredAspects: () => require('../lib/ebay-taxonomy').getRequiredAspects,
    executors: () => require('./atomic-tools').executors,
  };
  return function getDep(name) {
    if (provided && Object.prototype.hasOwnProperty.call(provided, name)) return provided[name];
    if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
    const loader = loaders[name];
    if (!loader) throw new Error(`content-enricher: unknown dep '${name}'`);
    cache[name] = loader();
    return cache[name];
  };
}

function scoreOf(evaluateEbayReady, product) {
  const r = evaluateEbayReady(product, {}) || {};
  return {
    ready: Boolean(r.ok),
    issues: Array.isArray(r.issues) ? r.issues : [],
    snapshot: r.snapshot || {},
    missingRequiredAspects: Array.isArray(r.missingRequiredAspects) ? r.missingRequiredAspects : [],
  };
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.,-]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function safeCall(fn, args) {
  try {
    return await fn(args);
  } catch (e) {
    return null;
  }
}

function pickGtin(product) {
  const ids = (product.details && product.details.identifiers) || {};
  const fromIds = ids.gtin || ids.ean || ids.upc;
  if (fromIds) return String(fromIds);
  const bc = (product.identification && product.identification.barcodes) || [];
  if (Array.isArray(bc) && bc.length) return String(bc[0] && (bc[0].code || bc[0].value) ? bc[0].code || bc[0].value : bc[0]) || undefined;
  return undefined;
}

// Normalize a price-research tool result into [{ price, url, name }].
function extractComps(toolResult) {
  const out = [];
  if (!toolResult || !toolResult.ok || !toolResult.data) return out;
  const d = toolResult.data;
  const items = Array.isArray(d.items) ? d.items : Array.isArray(d.offers) ? d.offers : [];
  for (const it of items) {
    const price = num(it.price != null ? it.price : it.amount != null ? it.amount : it.value);
    const url = it.url || it.link || null;
    if (price && price >= 1) out.push({ price, url: url || null, name: it.name || it.title || toolResult.source });
  }
  if (!items.length && d.result) {
    const price = num(d.result.price != null ? d.result.price : d.result.amount);
    const url = d.result.url || d.result.link || null;
    if (price && price >= 1) out.push({ price, url: url || null, name: d.result.name || d.result.title || toolResult.source });
  }
  return out;
}

// Fill price IFF it is currently a gap. Mutates work.details.pricing in place.
// Returns a `changed.price` record, or null when nothing safe could be set.
async function fillPrice(work, ctx) {
  const { getDep, marketplace } = ctx;
  const getPriceStatus = getDep('getPriceStatus');
  if (getPriceStatus(work).ok) return null; // not a gap

  const executors = getDep('executors') || {};
  const computeSweetSpotPrice = getDep('computeSweetSpotPrice');

  const brand = (work.identification && work.identification.brand) || '';
  const name = (work.identification && work.identification.name) || '';
  const query = [brand, name].filter(Boolean).join(' ').trim() || name || brand;
  const gtin = pickGtin(work);
  const categoryId = work.details && work.details.categoryId;

  const soldRes = executors.executeSearchEbaySold
    ? await safeCall(executors.executeSearchEbaySold, { query, gtin, categoryId, marketplaceId: marketplace, limit: 20 })
    : null;
  const amazonRes = executors.executeSearchAmazonProduct
    ? await safeCall(executors.executeSearchAmazonProduct, { query, gtin, region: 'DE' })
    : null;
  const idealoRes = executors.executeSearchIdealo
    ? await safeCall(executors.executeSearchIdealo, { query, gtin, limit: 10 })
    : null;

  const soldComps = extractComps(soldRes);
  const activeComps = extractComps(idealoRes);
  const amazonComps = extractComps(amazonRes);
  const amazonPrice = amazonComps.length ? amazonComps[0].price : null;

  const result = computeSweetSpotPrice({
    soldItems: soldComps.map((c) => c.price),
    activeListings: activeComps.map((c) => c.price),
    amazonPrice,
    marketplace,
    condition: 'NEW',
  });

  const suggested = result && result.ok ? num(result.price_suggested) : null;
  if (!(suggested >= 1)) return null;

  const allComps = [...soldComps, ...activeComps, ...amazonComps].filter((c) => c.url);
  if (!allComps.length) return null; // need >=1 evidence URL for the price gate

  const sources = allComps.slice(0, 10).map((c) => ({ name: c.name, url: c.url, price: c.price }));
  const lowest = num(result.price_min) >= 1 ? num(result.price_min) : Math.min(...allComps.map((c) => c.price));

  const before = (work.details.pricing && work.details.pricing.sellPrice) || null;
  work.details = work.details || {};
  work.details.pricing = work.details.pricing || {};
  work.details.pricing.sellPrice = suggested;
  work.details.pricing.price_confidence = num(result.confidence) || 0;
  work.details.pricing.lowest_price = {
    amount: lowest,
    currency: 'EUR',
    sources,
    last_checked_iso: new Date().toISOString(),
  };

  return { before, after: suggested, lowest, confidence: num(result.confidence) || 0, sourceCount: sources.length };
}

// ── attribute helpers (attributes are stored as an object {key: value}) ──────
function toAttrObject(attrs) {
  if (!attrs) return {};
  if (Array.isArray(attrs)) {
    const o = {};
    for (const a of attrs) if (a && a.key != null) o[String(a.key)] = a.value;
    return o;
  }
  if (typeof attrs === 'object') return { ...attrs };
  return {};
}

function attrVal(work, keyRegex) {
  const obj = toAttrObject(work.details && work.details.attributes);
  for (const k of Object.keys(obj)) {
    if (keyRegex.test(k)) {
      const v = obj[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

function categoryLeaf(work) {
  const s = String((work.identification && work.identification.category) || '');
  const parts = s.split('>').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Deterministic only — NEVER hallucinate. Returns '' when no safe source exists.
function deriveAspectValue(work, aspect) {
  const a = String(aspect || '').toLowerCase();
  const existing = toAttrObject(work.details && work.details.attributes);
  for (const k of Object.keys(existing)) {
    if (k.toLowerCase() === a && existing[k] != null && String(existing[k]).trim()) return String(existing[k]).trim();
  }
  const brand = (work.identification && work.identification.brand) || '';
  if (/(^|[^a-z])(marke)([^a-z]|$)/.test(a) && brand) return brand;
  if (/hersteller(?!nummer)/.test(a) && brand) return brand;
  if (/produktart|warenart/.test(a)) {
    const pt = attrVal(work, /produktart/i) || categoryLeaf(work);
    if (pt) return pt;
  }
  if (/zustand|condition/.test(a)) return attrVal(work, /zustand/i) || 'Neu';
  return '';
}

const TITLE_ISSUE_RE = /title|priority_a|order_priority|dangling/;
function titleIssuesOf(issues) {
  return (issues || []).filter((i) => TITLE_ISSUE_RE.test(String(i)));
}

// Title: restructure to the eBay title policy (Priority-A keywords first) via
// coerceTitleToPolicy(forcePolicy). Accept the new title ONLY if it measurably
// reduces the title-policy issues reported by the real gate.
async function fillTitle(work, ctx) {
  const { getDep } = ctx;
  const evaluateEbayReady = getDep('evaluateEbayReady');
  const before = scoreOf(evaluateEbayReady, work);
  const issuesBefore = titleIssuesOf(before.issues);
  if (!issuesBefore.length) return null; // title not a gap

  const coerceTitleToPolicy = getDep('coerceTitleToPolicy');
  const current = (work.identification && work.identification.name) || '';
  const candidate = String(coerceTitleToPolicy(work, current, { forcePolicy: true, minLen: 65, maxLen: 80 }) || '').trim();
  if (!candidate || candidate === current) return null;

  work.identification = work.identification || {};
  work.identification.name = candidate;
  const after = scoreOf(evaluateEbayReady, work);
  if (titleIssuesOf(after.issues).length < issuesBefore.length) {
    return { before: current, after: candidate };
  }
  work.identification.name = current; // no improvement → revert
  return null;
}

// Description: build HTML when short_description is too short. Writes the field
// the gate measures (short_description). Only upgrades.
async function fillDescription(work, ctx) {
  const { getDep, marketplace } = ctx;
  const evaluateEbayReady = getDep('evaluateEbayReady');
  const s = scoreOf(evaluateEbayReady, work);
  const descGap =
    s.issues.some((i) => /description/.test(String(i))) ||
    (s.snapshot && s.snapshot.desc_len != null && s.snapshot.desc_len < 260);
  if (!descGap) return null;

  const buildEbayDescription = getDep('buildEbayDescription');
  const current = (work.details && work.details.short_description) || '';
  const built = buildEbayDescription({
    productData: {
      brand: (work.identification && work.identification.brand) || '',
      title: (work.identification && work.identification.name) || '',
      productType: attrVal(work, /produktart/i) || categoryLeaf(work),
      short_description: current,
      condition: attrVal(work, /zustand/i) || 'Neu',
    },
    keyFeatures: (work.details && work.details.key_features) || [],
    aspects: (work.details && work.details.attributes) || {},
    gpsr: (work.details && work.details.gpsr) || {},
    marketplace,
    seoKeywords: [],
  });
  const html = built && built.html ? String(built.html) : '';
  if (!html || html.length <= current.length) return null;

  work.details = work.details || {};
  work.details.short_description = html;
  return { before_len: current.length, after_len: html.length };
}

// Aspects: fill ONLY required aspects whose value is deterministically derivable.
async function fillAspects(work, ctx) {
  const { getDep } = ctx;
  const evaluateEbayReady = getDep('evaluateEbayReady');
  const s = scoreOf(evaluateEbayReady, work);
  const missing = Array.isArray(s.missingRequiredAspects) ? s.missingRequiredAspects : [];
  if (!missing.length) return null;

  const attrs = toAttrObject(work.details && work.details.attributes);
  const filled = [];
  for (const aspect of missing) {
    const key = typeof aspect === 'string' ? aspect.trim() : '';
    if (!key) continue;
    const val = deriveAspectValue(work, key);
    if (val) {
      attrs[key] = val;
      filled.push(key);
    }
  }
  if (!filled.length) return null;

  work.details = work.details || {};
  work.details.attributes = attrs;
  return { filled };
}

// Ordered list of field fillers run each iteration. Each filler is gap-aware
// (returns null when its field already meets the standard).
const FILLERS = [
  { name: 'price', run: fillPrice },
  { name: 'title', run: fillTitle },
  { name: 'description', run: fillDescription },
  { name: 'aspects', run: fillAspects },
];

/**
 * @param {object} product            existing products_v2 document
 * @param {object} [opts]
 * @param {object} [opts.deps]        dependency overrides (for tests)
 * @param {number} [opts.maxIter=4]   max bring-up iterations
 * @param {string} [opts.marketplace='EBAY_DE']
 * @returns {Promise<{product, changed, ready, scoreBefore, scoreAfter, remainingIssues}>}
 */
async function enrichProductContent(product, opts = {}) {
  const getDep = buildDepResolver(opts.deps || {});
  const evaluateEbayReady = getDep('evaluateEbayReady');
  const maxIter = Number.isInteger(opts.maxIter) ? opts.maxIter : 4;
  const marketplace = opts.marketplace || 'EBAY_DE';

  const work = deepClone(product);
  const changed = {};

  const scoreBefore = scoreOf(evaluateEbayReady, work);
  if (scoreBefore.ready) {
    return {
      product: work,
      changed,
      ready: true,
      scoreBefore,
      scoreAfter: scoreBefore,
      remainingIssues: scoreBefore.issues,
    };
  }

  // Title rewriting is OPT-IN and OFF by default. Reason: policy-coercion can
  // drop the brand and pick the wrong product type from the category breadcrumb
  // (prod incident 2026-06-07 on the markisen). Existing titles are usually fine.
  const titleRewrite = opts.titleRewrite === true;
  const activeFillers = FILLERS.filter((f) => f.name !== 'title' || titleRewrite);

  // Bounded bring-up loop: each pass tries every gap-aware filler, re-scores,
  // and stops when ready or when no filler can make further progress.
  const ctx = { getDep, marketplace };
  for (let iter = 0; iter < maxIter; iter++) {
    if (scoreOf(evaluateEbayReady, work).ready) break;
    let progressed = false;
    for (const filler of activeFillers) {
      const result = await filler.run(work, ctx);
      if (result) {
        changed[filler.name] = result;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const scoreAfter = scoreOf(evaluateEbayReady, work);
  return {
    product: work,
    changed,
    ready: scoreAfter.ready,
    scoreBefore,
    scoreAfter,
    remainingIssues: scoreAfter.issues,
  };
}

module.exports = { enrichProductContent, _internal: { buildDepResolver, deepClone, scoreOf } };
