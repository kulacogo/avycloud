'use strict';

const { evaluateEbayReady } = require('./datasheet-quality');
const { scoreGpsr } = require('./gpsr-manufacturer-registry');
const { SOURCE_WEIGHTS } = require('./confidence-scoring');

// Phase A.1: Stage4 nutzt zentrale SOURCE_WEIGHTS aus confidence-scoring.js.
// 2 historische Werte (ean_db=0.80, ocr=0.60) weichen vom zentralen Wert ab (0.85, 0.65).
// Werte-erhaltend: STAGE4_OVERRIDES preserven den V3-Stage4-Behavior.
// Reconciliation als bewusste Verhaltensänderung in separater Folge-PR (TBD).
const STAGE4_OVERRIDES = { ean_db: 0.8, ocr: 0.6 };
const SOURCE_BASE_SCORES = { ...SOURCE_WEIGHTS, ...STAGE4_OVERRIDES };

function computeFieldConfidence(fieldName, value, sources) {
  if (!value || (typeof value === 'string' && !value.trim())) {
    return { score: 0, sources: [] };
  }

  const matchedSources = [];
  for (const [sourceName, sourceValue] of Object.entries(sources)) {
    if (!sourceValue) continue;
    if (typeof sourceValue === 'boolean' && sourceValue) {
      matchedSources.push(sourceName);
    } else if (typeof sourceValue === 'string' && sourceValue.trim()) {
      const agrees = sourceValue.trim().toLowerCase() === String(value).trim().toLowerCase();
      if (agrees) matchedSources.push(sourceName);
    }
  }

  if (!matchedSources.length) {
    return { score: 0.5, sources: ['unverified'] };
  }

  let score = Math.max(...matchedSources.map((s) => SOURCE_BASE_SCORES[s] || 0.5));

  if (matchedSources.length >= 3) score = Math.min(1.0, score + 0.25);
  else if (matchedSources.length >= 2) score = Math.min(1.0, score + 0.15);

  return { score: Math.round(score * 100) / 100, sources: matchedSources };
}

function computeAspectCoverage(requiredAspects, providedSpecifics) {
  const provided = Array.isArray(providedSpecifics) ? providedSpecifics : [];
  const providedKeys = new Set(
    provided.map((s) => (s?.key || '').trim().toLowerCase()).filter(Boolean)
  );

  const required = Array.isArray(requiredAspects) ? requiredAspects : [];
  const total = required.length;
  const missing = required.filter((a) => !providedKeys.has(a.toLowerCase()));
  const filled = total - missing.length;

  return {
    total,
    filled,
    missing,
    coverage: total > 0 ? Math.round((filled / total) * 100) / 100 : 1,
  };
}

function runStage4Validation(stage1, stage2, stage3, assembledProduct) {
  const fieldConfidence = {};

  fieldConfidence.brand = computeFieldConfidence('brand', stage1.identity?.brand, {
    grounding: stage1.identity?.brand,
    ean_db: stage1.eanLookup?.brand,
    barcode_confirm: stage2.barcodeConfirmation?.confirmed,
  });

  fieldConfidence.ean = computeFieldConfidence('ean', stage1.barcodes?.ean, {
    ocr: stage1.ocrPayload?.barcodes?.includes(stage1.barcodes?.ean),
    grounding: stage1.barcodes?.ean,
    barcode_confirm: stage2.barcodeConfirmation?.confirmed,
  });

  fieldConfidence.category = computeFieldConfidence('category', stage2.category?.ebayBreadcrumb, {
    grounding: stage1.identity?.internalCategory,
    ebay_browse: stage2.category?.ebayId ? stage2.category.ebayBreadcrumb : null,
  });

  fieldConfidence.price = computeFieldConfidence('price', stage2.pricing?.amount, {
    [stage2.pricing?.via || 'web']: stage2.pricing?.amount ? String(stage2.pricing.amount) : null,
  });

  fieldConfidence.title_ebay = computeFieldConfidence('title_ebay', stage3.title_ebay, {
    llm_generated: stage3.title_ebay,
  });

  fieldConfidence.gpsr = computeFieldConfidence('gpsr', stage2.gpsr?.data?.manufacturer_name, {
    registry: stage2.gpsr?.found ? stage2.gpsr.data.manufacturer_name : null,
  });

  // Aspect coverage
  const requiredAspectsCoverage = computeAspectCoverage(
    stage2.requiredAspects || [],
    stage3.item_specifics || []
  );

  // Quality gate (reuse existing)
  let qualityGate = { ok: false, issues: [], issuesDetailed: [], snapshot: null };
  try {
    qualityGate = evaluateEbayReady(assembledProduct, { force: true });
  } catch {
    // Quality gate failure is non-fatal
  }

  // GPSR score
  const gpsrData = assembledProduct?.details?.gpsr || assembledProduct?.gpsr;
  const gpsrScore = gpsrData ? scoreGpsr(gpsrData) : 0;

  // Marketplace readiness
  const ebayReady = qualityGate.ok && requiredAspectsCoverage.coverage >= 0.7;
  const kauflandReady = Boolean(stage3.title_kaufland && stage3.description_kaufland);

  // Overall score (weighted composite)
  const weights = {
    brand: 0.15, ean: 0.1, category: 0.15, price: 0.1,
    title_ebay: 0.15, gpsr: 0.1, aspectCoverage: 0.15, qualityGate: 0.1,
  };
  const overallScore = Math.round((
    (fieldConfidence.brand?.score || 0) * weights.brand +
    (fieldConfidence.ean?.score || 0) * weights.ean +
    (fieldConfidence.category?.score || 0) * weights.category +
    (fieldConfidence.price?.score || 0) * weights.price +
    (fieldConfidence.title_ebay?.score || 0) * weights.title_ebay +
    (fieldConfidence.gpsr?.score || 0) * weights.gpsr +
    (requiredAspectsCoverage.coverage || 0) * weights.aspectCoverage +
    (qualityGate.ok ? 1 : 0.3) * weights.qualityGate
  ) * 100) / 100;

  return {
    fieldConfidence,
    requiredAspectsCoverage,
    marketplaceReadiness: {
      ebay: { ready: ebayReady, issues: qualityGate.issues || [], score: overallScore },
      kaufland: { ready: kauflandReady, issues: [], score: kauflandReady ? overallScore : overallScore * 0.8 },
    },
    overallScore,
    gpsrScore,
    qualityGate,
  };
}

module.exports = {
  computeFieldConfidence,
  computeAspectCoverage,
  runStage4Validation,
};
