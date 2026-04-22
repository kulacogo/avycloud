'use strict';

/**
 * sweet-spot-pricer.js
 *
 * Fee-aware, trend-weighted product pricing for eBay + Kaufland.
 *
 * Inputs vary (SOLD listings, active listings, Amazon price, Kaufland price).
 * Output is a single "sweet-spot" price with full breakdown + per-marketplace
 * net revenue projection.
 *
 * Principles:
 *   - SOLD listings are truth (real market signal) → weight 0.6
 *   - Active listings are intent (ask price) → weight 0.25
 *   - Amazon price as cross-reference (strong category signal) → weight 0.15
 *   - Psychological rounding applied AFTER the arithmetic core
 *   - Every output is fully deterministic & auditable
 *
 * Pure function. No I/O. No Gemini.
 */

// Marketplace fee structure (as of 2026-04)
const MARKETPLACE_FEES = Object.freeze({
  // eBay DE: ~12.5% on total sale price (varies by category, 12.5% is a fair
  // blended default for private non-promoted listings). Plus ~0.35€ fixed fee
  // on items below 10€, ignored here (can be added in route-layer if needed).
  EBAY_DE: { percent: 0.125, fixed: 0 },

  // Kaufland: 14% commission + 19% VAT on commission = 16.66% effective
  //   payout = brutto * (1 - 0.14 * 1.19)
  KAUFLAND_DE: { percent: 0.1666, fixed: 0 },

  // Amazon DE: ~15% referral fee (blended default — electronics are 8%, media 15%)
  AMAZON_DE: { percent: 0.15, fixed: 0 },
});

// Weights for blending sources when computing the raw sweet-spot
const SOURCE_WEIGHTS = Object.freeze({
  sold: 0.6,
  active: 0.25,
  amazon: 0.15,
});

// Rounding brackets (price → suffix cents)
//   price <  10 → .99 NOT applied (too low, round to whole + .49 or .99)
//   price <  50 → .99 (e.g. 14.99, 29.99)
//   price <= 100 → .95 (e.g. 49.95, 89.95)
//   price > 100 → nearest ~5, ending .99 (e.g. 149.99, 199.99, 249.99)
const PSYCHOLOGICAL_BRACKETS = Object.freeze([
  { maxExclusive: 10, mode: 'nine99' },
  { maxExclusive: 50, mode: 'nine99' },
  { maxExclusive: 100, mode: 'ninefive' },
  { maxExclusive: Infinity, mode: 'nearest5nine99' },
]);

// Minimal sanity bounds
const MIN_VIABLE_PRICE = 0.5;
const MAX_VIABLE_PRICE = 100000;

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractPrices(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === 'number') return entry;
      if (typeof entry === 'object') {
        return (
          toNumber(entry.amount) ??
          toNumber(entry.price) ??
          toNumber(entry.value) ??
          null
        );
      }
      return toNumber(entry);
    })
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimmedMean(numbers, trimRatio = 0.1) {
  if (!numbers.length) return null;
  if (numbers.length < 5) return median(numbers);
  const sorted = [...numbers].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimRatio);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  if (!trimmed.length) return median(numbers);
  const sum = trimmed.reduce((acc, n) => acc + n, 0);
  return sum / trimmed.length;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * psychologicalRound(price) → price adjusted to a consumer-friendly ending.
 * Deterministic. Works on any positive price >= MIN_VIABLE_PRICE.
 */
function psychologicalRound(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < MIN_VIABLE_PRICE) {
    return null;
  }

  const bracket =
    PSYCHOLOGICAL_BRACKETS.find((b) => price < b.maxExclusive) ||
    PSYCHOLOGICAL_BRACKETS[PSYCHOLOGICAL_BRACKETS.length - 1];

  switch (bracket.mode) {
    case 'nine99': {
      // Round DOWN to the whole euro, add .99
      // 14.23 → 13.99, 14.67 → 14.99 (take floor + 0.99 if >= 0.5; else floor-1 + 0.99)
      const floor = Math.floor(price);
      if (price - floor >= 0.5) return floor + 0.99;
      return Math.max(floor - 1 + 0.99, MIN_VIABLE_PRICE);
    }
    case 'ninefive': {
      // Round to nearest whole euro + .95, but keep near input
      const target = Math.round(price);
      const candidate = target - 0.05; // e.g. 89.95
      return Math.max(candidate, MIN_VIABLE_PRICE);
    }
    case 'nearest5nine99': {
      // Round to nearest 5-euro step + .99
      // 147.30 → 149.99, 152.80 → 149.99 or 154.99? Use nearest-5 on floor(price).
      const base = Math.round(price / 5) * 5;
      const candidate = base - 0.01; // e.g. 149.99
      return Math.max(candidate, MIN_VIABLE_PRICE);
    }
    default:
      return Math.round(price * 100) / 100;
  }
}

/**
 * applyFeeAwareness(grossPrice, { marketplace }) → { gross, netPayout, fee }
 *
 * netPayout = gross - fee
 *   fee = gross * feePercent + fixed
 */
function applyFeeAwareness(grossPrice, options = {}) {
  const { marketplace = 'EBAY_DE' } = options;
  const fees = MARKETPLACE_FEES[marketplace] || MARKETPLACE_FEES.EBAY_DE;
  if (typeof grossPrice !== 'number' || !Number.isFinite(grossPrice)) {
    return { gross: null, netPayout: null, fee: null, feePercent: fees.percent };
  }
  const fee = grossPrice * fees.percent + fees.fixed;
  return {
    gross: Math.round(grossPrice * 100) / 100,
    netPayout: Math.round((grossPrice - fee) * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    feePercent: fees.percent,
    marketplace,
  };
}

/**
 * blendSources({soldPrices, activePrices, amazonPrice}) → {rawSweetSpot, weights, breakdown}
 *
 * Robust weighted blend. Missing sources are dropped and their weight redistributed.
 */
function blendSources({ soldPrices = [], activePrices = [], amazonPrice = null } = {}) {
  const soldMedian = median(soldPrices);
  const activeMedian = trimmedMean(activePrices, 0.1);
  const amazonNum = typeof amazonPrice === 'number' && Number.isFinite(amazonPrice)
    ? amazonPrice
    : null;

  const parts = [
    { key: 'sold', value: soldMedian, weight: SOURCE_WEIGHTS.sold },
    { key: 'active', value: activeMedian, weight: SOURCE_WEIGHTS.active },
    { key: 'amazon', value: amazonNum, weight: SOURCE_WEIGHTS.amazon },
  ].filter((p) => typeof p.value === 'number' && Number.isFinite(p.value) && p.value > 0);

  if (!parts.length) {
    return { rawSweetSpot: null, weights: {}, breakdown: { soldMedian, activeMedian, amazonNum } };
  }

  const totalWeight = parts.reduce((acc, p) => acc + p.weight, 0);
  const weightedSum = parts.reduce((acc, p) => acc + p.value * p.weight, 0);
  const rawSweetSpot = weightedSum / totalWeight;

  const weightsOut = {};
  for (const p of parts) weightsOut[p.key] = p.weight / totalWeight;

  return {
    rawSweetSpot,
    weights: weightsOut,
    breakdown: { soldMedian, activeMedian, amazonNum },
  };
}

/**
 * computeSweetSpotPrice({ soldItems, activeListings, amazonPrice, marketplace, condition })
 *
 * Master entry point. Returns:
 *   {
 *     ok: boolean,
 *     price_suggested: number | null,
 *     price_min: number | null,
 *     price_max: number | null,
 *     fee_breakdown: { gross, netPayout, fee, feePercent, marketplace },
 *     confidence: number,         // 0..1
 *     data_points: { sold: N, active: N, amazon: 0|1 },
 *     weights_used: { sold?, active?, amazon? },
 *     raw_sweet_spot: number | null,
 *     psychological_applied: boolean,
 *     reasons: string[]           // audit trail for UI / debug
 *   }
 */
function computeSweetSpotPrice(input = {}) {
  const {
    soldItems = [],
    activeListings = [],
    amazonPrice = null,
    marketplace = 'EBAY_DE',
    condition = 'NEW',
  } = input;

  const reasons = [];

  const soldPrices = extractPrices(soldItems);
  const activePrices = extractPrices(activeListings);
  const amazonNum = toNumber(amazonPrice);

  const dataPoints = {
    sold: soldPrices.length,
    active: activePrices.length,
    amazon: amazonNum != null ? 1 : 0,
  };

  if (!soldPrices.length && !activePrices.length && amazonNum == null) {
    reasons.push('no_price_signals');
    return {
      ok: false,
      price_suggested: null,
      price_min: null,
      price_max: null,
      fee_breakdown: applyFeeAwareness(null, { marketplace }),
      confidence: 0,
      data_points: dataPoints,
      weights_used: {},
      raw_sweet_spot: null,
      psychological_applied: false,
      reasons,
    };
  }

  const { rawSweetSpot, weights, breakdown } = blendSources({
    soldPrices,
    activePrices,
    amazonPrice: amazonNum,
  });

  if (rawSweetSpot == null || rawSweetSpot < MIN_VIABLE_PRICE) {
    reasons.push('raw_sweet_spot_below_minimum');
    return {
      ok: false,
      price_suggested: null,
      price_min: null,
      price_max: null,
      fee_breakdown: applyFeeAwareness(null, { marketplace }),
      confidence: 0,
      data_points: dataPoints,
      weights_used: weights,
      raw_sweet_spot: rawSweetSpot,
      psychological_applied: false,
      reasons,
    };
  }

  const bounded = clamp(rawSweetSpot, MIN_VIABLE_PRICE, MAX_VIABLE_PRICE);
  if (bounded !== rawSweetSpot) reasons.push('bounded_to_sanity_range');

  // Condition-Adjustment — used items discount 15%, refurbished 10%
  let conditionAdjusted = bounded;
  const condStr = String(condition || 'NEW').toUpperCase();
  if (condStr === 'USED' || condStr === 'GEBRAUCHT') {
    conditionAdjusted = bounded * 0.85;
    reasons.push('applied_used_discount_15pct');
  } else if (
    condStr === 'REFURBISHED' ||
    condStr === 'WIEDERAUFBEREITET' ||
    condStr === 'OPEN_BOX'
  ) {
    conditionAdjusted = bounded * 0.9;
    reasons.push('applied_refurbished_discount_10pct');
  }

  const priceSuggested = psychologicalRound(conditionAdjusted);
  const priceMin = soldPrices.length
    ? Math.max(MIN_VIABLE_PRICE, Math.min(...soldPrices))
    : Math.max(MIN_VIABLE_PRICE, conditionAdjusted * 0.85);
  const priceMax = soldPrices.length
    ? Math.max(...soldPrices)
    : conditionAdjusted * 1.15;

  // Confidence based on data density + agreement between sources
  let confidence = 0.3;
  if (soldPrices.length >= 5) confidence += 0.35;
  else if (soldPrices.length >= 2) confidence += 0.2;
  if (activePrices.length >= 3) confidence += 0.15;
  if (amazonNum != null) confidence += 0.1;

  // Agreement boost: sold and active within 15% of each other
  if (breakdown.soldMedian && breakdown.activeMedian) {
    const diff = Math.abs(breakdown.soldMedian - breakdown.activeMedian);
    const avg = (breakdown.soldMedian + breakdown.activeMedian) / 2;
    if (avg > 0 && diff / avg <= 0.15) {
      confidence += 0.1;
      reasons.push('sold_active_agreement');
    }
  }
  confidence = clamp(confidence, 0, 1);

  const feeBreakdown = applyFeeAwareness(priceSuggested, { marketplace });

  return {
    ok: true,
    price_suggested: priceSuggested,
    price_min: Math.round(priceMin * 100) / 100,
    price_max: Math.round(priceMax * 100) / 100,
    fee_breakdown: feeBreakdown,
    confidence: Math.round(confidence * 100) / 100,
    data_points: dataPoints,
    weights_used: weights,
    raw_sweet_spot: Math.round(rawSweetSpot * 100) / 100,
    psychological_applied: true,
    reasons,
  };
}

module.exports = {
  MARKETPLACE_FEES,
  SOURCE_WEIGHTS,
  MIN_VIABLE_PRICE,
  MAX_VIABLE_PRICE,
  computeSweetSpotPrice,
  applyFeeAwareness,
  psychologicalRound,
  blendSources,
  _internal: { median, trimmedMean, extractPrices, toNumber, clamp },
};
