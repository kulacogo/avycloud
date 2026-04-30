'use strict';

/**
 * identify-v3-evidence.js
 *
 * Builds an array of `{ field, source, value, confidence }` evidence-rows from
 * the stage1/stage2/stage3 outputs of the V3 identify pipeline. The rows are
 * shaped to match the `SOURCE_WEIGHTS` table in `lib/confidence-scoring.js` so
 * the cross-referencer in `lib/cross-reference.js` can produce a per-field
 * consensus score that uses the calibrated source weights.
 *
 * The output of this module feeds the new "Stage 4b" cross-reference pass that
 * runs ALONGSIDE the existing Stage 4 custom scoring (additive, gated by
 * `STAGE4_CROSS_REFERENCE`, default ON). The result lands at
 *   product.ops.data_quality.identify_v3.cross_reference
 * — Stage 4's `overall_score` / `field_confidence` are NOT touched. Phase 1 of
 * the SubAgent C plan: parallel, observable, no shape change.
 *
 * Source-mapping rules (chosen to match SOURCE_WEIGHTS verbatim):
 *
 *   stage1.eanLookup.* (when found=true)        →  source: 'ean_db'
 *   stage1.barcodes.ranked[*] (web-confirmed)   →  source: 'gs1_verified'
 *   stage1.barcodes.ranked[*] (OCR-only)        →  source: 'ocr'
 *   stage1.identity.* (Gemini focused output)   →  source: 'gemini_inference'
 *   stage1.v2FallbackRecord.* (V2 grounding)    →  source: 'google_search_grounding'
 *   stage1.ocrPayload.textSnippets              →  source: 'ocr'
 *   stage2.category.* (resolver=v2:catalog)     →  source: 'ebay_catalog'
 *   stage2.category.* (resolver=v2:suggestions) →  source: 'ebay_catalog'
 *   stage2.category.* (resolver=local)          →  source: 'gemini_inference'  (local breadcrumb came from Stage1 Gemini)
 *   stage2.gpsr.data (registry)                 →  source: 'manufacturer_website'
 *   stage2.gpsrWebFallback                      →  source: 'manufacturer_website'
 *   stage2.weightFallback.sources               →  source: 'web_search_broad'
 *   stage2.barcodeConfirmation.evidence         →  source: 'web_search_broad'
 *   stage2.pricing.sources                      →  source: 'amazon_product' | 'web_search_broad' (per host)
 *   stage3.item_specifics                       →  source: 'gemini_inference'
 *   stage3.gpsr_*                               →  source: 'gemini_inference'
 */

const { crossReferenceProduct } = require('./cross-reference');
const { aggregateProductConfidence } = require('./confidence-scoring');

function _str(v) {
  if (v == null) return '';
  return String(v).trim();
}

function _isPlausibleBrand(v) {
  const s = _str(v).toLowerCase();
  if (!s || s.length < 2) return false;
  return !/^(unbekannt|unknown|n\/a|k\.a\.|sonstige|generic|noname|hochwertig)/i.test(s);
}

function _hostFromUrl(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function _pricingSourceForHost(host) {
  if (!host) return 'web_search_broad';
  if (host.includes('amazon.')) return 'amazon_product';
  if (host.includes('idealo.')) return 'web_search_broad';
  if (host.includes('ebay.')) return 'ebay_catalog';
  if (host.includes('geizhals.')) return 'web_search_broad';
  return 'web_search_broad';
}

/**
 * Build evidence rows for a V3 identify run.
 *
 * @param {object} stage1 Stage-1 output (`runStage1Recognition`)
 * @param {object} stage2 Stage-2 output (`runStage2Enrichment`)
 * @param {object} stage3 Stage-3 output (`runStage3ContentGeneration`)
 * @returns {Array<{field: string, source: string, value: any, confidence?: number}>}
 */
function buildEvidenceRows(stage1 = {}, stage2 = {}, stage3 = {}) {
  const rows = [];
  const identity = stage1.identity || {};
  const barcodes = stage1.barcodes || {};

  // ── Brand evidence ────────────────────────────────────────────────────────
  if (_isPlausibleBrand(identity.brand)) {
    rows.push({ field: 'brand', source: 'gemini_inference', value: _str(identity.brand) });
  }
  if (stage1.eanLookup?.found && _isPlausibleBrand(stage1.eanLookup.brand)) {
    rows.push({ field: 'brand', source: 'ean_db', value: _str(stage1.eanLookup.brand) });
  }
  if (stage1.v2FallbackRecord?.brand && _isPlausibleBrand(stage1.v2FallbackRecord.brand)) {
    rows.push({
      field: 'brand',
      source: 'google_search_grounding',
      value: _str(stage1.v2FallbackRecord.brand),
    });
  }
  if (Array.isArray(stage3.item_specifics)) {
    const markeSpec = stage3.item_specifics.find(
      (s) => s?.key && /^(marke|brand|hersteller)$/i.test(_str(s.key)),
    );
    if (markeSpec && _isPlausibleBrand(markeSpec.value)) {
      rows.push({ field: 'brand', source: 'gemini_inference', value: _str(markeSpec.value) });
    }
  }

  // ── GTIN/EAN/UPC evidence ─────────────────────────────────────────────────
  // Web-confirmed barcode is the highest-trust signal we have in Stage 2.
  const webConfirmed = stage2.barcodeConfirmation?.confirmed === true;
  if (barcodes.ean) {
    rows.push({
      field: 'gtin',
      source: webConfirmed ? 'gs1_verified' : 'ocr',
      value: _str(barcodes.ean),
    });
    rows.push({
      field: 'ean',
      source: webConfirmed ? 'gs1_verified' : 'ocr',
      value: _str(barcodes.ean),
    });
  }
  if (barcodes.gtin && barcodes.gtin !== barcodes.ean) {
    rows.push({
      field: 'gtin',
      source: webConfirmed ? 'gs1_verified' : 'ocr',
      value: _str(barcodes.gtin),
    });
  }
  if (barcodes.upc) {
    rows.push({
      field: 'upc',
      source: webConfirmed ? 'gs1_verified' : 'ocr',
      value: _str(barcodes.upc),
    });
  }

  // ── MPN evidence ──────────────────────────────────────────────────────────
  if (identity.mpn) {
    rows.push({ field: 'mpn', source: 'gemini_inference', value: _str(identity.mpn) });
  }

  // ── Category evidence ─────────────────────────────────────────────────────
  // Map resolver provenance → SOURCE_WEIGHTS key.
  const resolver = stage2.category?.resolver || {};
  const categoryId = stage2.category?.ebayId;
  const categoryBreadcrumb = stage2.category?.ebayBreadcrumb;
  if (categoryId) {
    let categorySource = 'gemini_inference';
    if (resolver.source === 'v2:catalog' || resolver.source === 'v2:suggestions') {
      categorySource = 'ebay_catalog';
    } else if (resolver.source === 'v2:local' || resolver.source === 'local') {
      // Local match comes from Stage-1 Gemini-vision breadcrumb, so semantic
      // origin is Gemini-inference even though the lookup is deterministic.
      categorySource = 'gemini_inference';
    } else if (resolver.source === 'v2:gemini') {
      categorySource = 'gemini_inference';
    }
    rows.push({
      field: 'categoryId',
      source: categorySource,
      value: _str(categoryId),
      confidence: typeof resolver.confidence === 'number' ? resolver.confidence : undefined,
    });
    if (categoryBreadcrumb) {
      rows.push({
        field: 'category',
        source: categorySource,
        value: _str(categoryBreadcrumb),
        confidence: typeof resolver.confidence === 'number' ? resolver.confidence : undefined,
      });
    }
  }

  // ── GPSR evidence ─────────────────────────────────────────────────────────
  if (stage2.gpsr?.found && stage2.gpsr?.data?.manufacturer_name) {
    rows.push({
      field: 'gpsr',
      source: 'manufacturer_website',
      value: _str(stage2.gpsr.data.manufacturer_name),
    });
  }
  if (stage2.gpsrWebFallback?.manufacturer_name) {
    rows.push({
      field: 'gpsr',
      source: 'manufacturer_website',
      value: _str(stage2.gpsrWebFallback.manufacturer_name),
    });
  }
  if (stage3.gpsr_manufacturer_name) {
    rows.push({
      field: 'gpsr',
      source: 'gemini_inference',
      value: _str(stage3.gpsr_manufacturer_name),
    });
  }

  // ── Price evidence ────────────────────────────────────────────────────────
  if (stage2.pricing?.amount > 0) {
    const amount = Number(stage2.pricing.amount);
    if (Number.isFinite(amount)) {
      const sources = Array.isArray(stage2.pricing.sources) ? stage2.pricing.sources : [];
      if (sources.length) {
        for (const s of sources.slice(0, 3)) {
          const host = _hostFromUrl(s?.url || '');
          rows.push({ field: 'price', source: _pricingSourceForHost(host), value: amount });
        }
      } else {
        rows.push({ field: 'price', source: 'web_search_broad', value: amount });
      }
    }
  }

  // ── Title / description evidence (Stage 3 LLM) ────────────────────────────
  if (stage3.title_ebay) {
    rows.push({ field: 'title', source: 'gemini_inference', value: _str(stage3.title_ebay) });
  }
  if (stage3.description_ebay) {
    rows.push({
      field: 'description',
      source: 'gemini_inference',
      value: _str(stage3.description_ebay),
    });
  }

  // ── Required-Aspects evidence (count of filled real values) ──────────────
  if (Array.isArray(stage3.item_specifics) && Array.isArray(stage2.requiredAspects)) {
    const filled = stage3.item_specifics.filter(
      (s) =>
        s?.key &&
        s?.value &&
        !/^(unbekannt|unknown|n\/a|k\.a\.)$/i.test(_str(s.value)),
    );
    if (filled.length) {
      rows.push({
        field: 'requiredAspects',
        source: 'gemini_inference',
        // For requiredAspects we represent the value as a count-bucket so cross-
        // ref can detect agreement — same count from two sources is equality.
        value: `count=${filled.length}`,
      });
    }
  }

  // ── Weight evidence ───────────────────────────────────────────────────────
  if (stage2.weightFallback?.weight_grams) {
    rows.push({
      field: 'weight',
      source: 'web_search_broad',
      value: Number(stage2.weightFallback.weight_grams),
    });
  }
  if (identity.weight_grams && Number(identity.weight_grams) > 0) {
    rows.push({
      field: 'weight',
      source: 'gemini_inference',
      value: Number(identity.weight_grams),
    });
  }

  return rows;
}

/**
 * Build the draft input object for `crossReferenceProduct`.
 *
 * The draft is the "current best guess" the assembler would have produced —
 * cross-reference treats draft values as user_input fallbacks when no
 * matching evidence exists. We fill it from the same sources as
 * `assembleProduct` to keep behaviour consistent.
 *
 * @param {object} stage1
 * @param {object} stage2
 * @param {object} stage3
 * @returns {Record<string, any>}
 */
function buildDraft(stage1 = {}, stage2 = {}, stage3 = {}) {
  const identity = stage1.identity || {};
  const barcodes = stage1.barcodes || {};
  return {
    brand: _isPlausibleBrand(identity.brand) ? _str(identity.brand) : '',
    gtin: _str(barcodes.gtin || barcodes.ean || ''),
    ean: _str(barcodes.ean || ''),
    upc: _str(barcodes.upc || ''),
    mpn: _str(identity.mpn || ''),
    categoryId: _str(stage2.category?.ebayId || ''),
    category: _str(stage2.category?.ebayBreadcrumb || identity.internalCategory || ''),
    title: _str(stage3.title_ebay || ''),
    description: _str(stage3.description_ebay || ''),
    price:
      Number(stage2.pricing?.amount) > 0
        ? Number(stage2.pricing.amount)
        : undefined,
    weight:
      Number(stage2.weightFallback?.weight_grams) > 0
        ? Number(stage2.weightFallback.weight_grams)
        : Number(identity.weight_grams) > 0
          ? Number(identity.weight_grams)
          : undefined,
    gpsr:
      _str(
        stage2.gpsr?.data?.manufacturer_name ||
          stage2.gpsrWebFallback?.manufacturer_name ||
          stage3.gpsr_manufacturer_name ||
          '',
      ) || undefined,
  };
}

/**
 * Run a Cross-Reference + Confidence-Aggregation pass over a V3 pipeline run.
 *
 * The output is an additive object intended for
 * `product.ops.data_quality.identify_v3.cross_reference` — it does not modify
 * any existing field of the assembled product.
 *
 * @param {object} stage1
 * @param {object} stage2
 * @param {object} stage3
 * @returns {{
 *   evidenceCount: number,
 *   evidence: Array,
 *   confidence: Record<string, {score: number, threshold: number, passes: boolean, sources: string[], reasoning: string}>,
 *   conflicts: Array<{field: string, alternatives: Array}>,
 *   resolved: Record<string, any>,
 *   aggregate: {score: number, readyForPublish: boolean, missingCritical: string[]},
 * }}
 */
function runStage4CrossReference(stage1, stage2, stage3) {
  const evidence = buildEvidenceRows(stage1 || {}, stage2 || {}, stage3 || {});
  const draft = buildDraft(stage1 || {}, stage2 || {}, stage3 || {});
  const xref = crossReferenceProduct(draft, evidence);
  const aggregate = aggregateProductConfidence(xref.confidence);
  return {
    evidenceCount: evidence.length,
    evidence,
    confidence: xref.confidence,
    conflicts: xref.conflicts,
    resolved: xref.resolved,
    aggregate,
  };
}

module.exports = {
  buildEvidenceRows,
  buildDraft,
  runStage4CrossReference,
};
