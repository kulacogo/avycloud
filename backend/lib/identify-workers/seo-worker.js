'use strict';

/**
 * seo-worker.js — Identify-V4 Worker for SEO (title + description).
 *
 * Deterministisch: nutzt die reinen Libraries seo-title-builder + seo-description-builder
 * aus Phase A. Competitor-Keyword-Mining via ebay-browse-title-insights (best-effort).
 * Kein direkter Gemini-Call nötig (die Inputs stammen aus vorherigen Workern).
 *
 * Contract: runSeoWorker(context) → { ok, domain:'seo', resolved, confidence, sources, meta }.
 */

const { buildEbayTitle } = require('../seo-title-builder');
const { buildEbayDescription } = require('../seo-description-builder');

const DOMAIN = 'seo';

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function extractIdentityHints(context) {
  const product = context.product || {};
  const identity = context.identity || {};
  const ident = product.identification || {};
  const workerIdentity = context.workerResults?.identity?.resolved || {};

  return {
    brand: safeString(workerIdentity.brand || identity.brand || ident.brand),
    model: safeString(workerIdentity.model || identity.model || ident.model || ident.sku),
    productType: safeString(identity.productType || ident.name || ident.category),
    color: safeString(identity.color),
    size: safeString(identity.size),
    material: safeString(identity.material),
    condition: safeString(ident.condition || identity.condition || 'Neu'),
    mpn: safeString(workerIdentity.mpn || identity.mpn),
  };
}

async function tryFetchCompetitorKeywords(categoryId) {
  if (!categoryId) return { keywords: [], sampleTitles: [] };
  try {
    // eslint-disable-next-line global-require
    const insights = require('../ebay-browse-title-insights');
    if (typeof insights.fetchCategoryTitleInsights !== 'function') {
      return { keywords: [], sampleTitles: [] };
    }
    const result = await Promise.race([
      insights.fetchCategoryTitleInsights(categoryId),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    const topTokens = Array.isArray(result?.topTokens) ? result.topTokens : [];
    const sampleTitles = Array.isArray(result?.sampleTitles) ? result.sampleTitles : [];
    return { keywords: topTokens, sampleTitles };
  } catch {
    return { keywords: [], sampleTitles: [] };
  }
}

async function runSeoWorker(context = {}) {
  const started = Date.now();
  const meta = {
    durationMs: 0,
    toolsCalled: [],
    geminiCalls: 0,
    error: null,
  };
  const sources = [];

  try {
    if (!context.product || typeof context.product !== 'object') {
      meta.durationMs = Date.now() - started;
      meta.error = 'product_missing';
      return {
        ok: false,
        domain: DOMAIN,
        resolved: {},
        confidence: {},
        sources,
        retriesRequested: [],
        meta,
      };
    }

    const hints = extractIdentityHints(context);
    const categoryResolved = context.workerResults?.category?.resolved || {};
    const categoryId = categoryResolved.categoryId;

    const { keywords, sampleTitles } = await tryFetchCompetitorKeywords(categoryId);
    if (keywords.length) {
      meta.toolsCalled.push('fetchCategoryTitleInsights');
      sources.push({
        type: 'competitor_keywords',
        url: null,
        data: { keywords: keywords.slice(0, 12), sampleTitles: sampleTitles.slice(0, 5) },
        weight: 0.5,
      });
    }

    const ebayTitleResult = buildEbayTitle(
      {
        brand: hints.brand,
        productType: hints.productType,
        model: hints.model,
        differentiator: [hints.color, hints.size].filter(Boolean).join(' '),
        keySpec: hints.material,
        condition: hints.condition,
        competitorKeywords: keywords,
      },
      { marketplace: 'EBAY_DE' }
    );

    const kauflandTitleResult = buildEbayTitle(
      {
        brand: hints.brand,
        productType: hints.productType,
        model: hints.model,
        differentiator: [hints.color, hints.size].filter(Boolean).join(' '),
        keySpec: hints.material,
        condition: hints.condition,
        competitorKeywords: keywords,
      },
      { marketplace: 'KAUFLAND_DE' }
    );

    const attributesResolved = context.workerResults?.attributes?.resolved || {};
    const gpsrResolved = context.workerResults?.gpsr?.resolved?.gpsr || {};
    const keyFeatures = Array.isArray(context.product.details?.key_features)
      ? context.product.details.key_features
      : [];

    const ebayDescriptionResult = buildEbayDescription({
      productData: {
        brand: hints.brand,
        title: ebayTitleResult.title,
        productType: hints.productType,
        short_description: context.product.details?.short_description,
        condition: hints.condition,
      },
      keyFeatures,
      aspects: attributesResolved.item_specifics || [],
      gpsr: gpsrResolved,
      seoKeywords: keywords,
      marketplace: 'EBAY_DE',
    });

    const kauflandDescriptionResult = buildEbayDescription({
      productData: {
        brand: hints.brand,
        title: kauflandTitleResult.title,
        productType: hints.productType,
        short_description: context.product.details?.short_description,
        condition: hints.condition,
      },
      keyFeatures,
      aspects: attributesResolved.item_specifics || [],
      gpsr: gpsrResolved,
      seoKeywords: keywords,
      marketplace: 'KAUFLAND_DE',
    });

    const mobileSnippet = ebayDescriptionResult.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);

    const titleConfidence = ebayTitleResult.score?.overall || 0.4;
    const descConfidence = ebayDescriptionResult.warnings?.length > 0 ? 0.5 : 0.75;

    meta.durationMs = Date.now() - started;

    return {
      ok: true,
      domain: DOMAIN,
      resolved: {
        title_ebay: ebayTitleResult.title,
        title_kaufland: kauflandTitleResult.title,
        description_ebay: ebayDescriptionResult.html,
        description_kaufland: kauflandDescriptionResult.html,
        key_features: keyFeatures.slice(0, 7),
        mobile_snippet: mobileSnippet,
        seo_score: {
          title: titleConfidence,
          description: descConfidence,
          overall: (titleConfidence + descConfidence) / 2,
        },
      },
      confidence: {
        title: titleConfidence,
        description: descConfidence,
      },
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
      resolved: {},
      confidence: {},
      sources,
      retriesRequested: [],
      meta,
    };
  }
}

module.exports = { runSeoWorker, DOMAIN };
