/**
 * Smart Pricing Engine
 *
 * Optimale Preisfindung basierend auf 3-stufiger Fallback-Strategie:
 * - Tier 1 (confidence 0.9): EAN/GTIN-Match → direkte Konkurrenzpreise (nur Neuware)
 * - Tier 2 (confidence 0.6): Kategorie-Similarity → ähnliche Produkte im eigenen Bestand
 * - Tier 3 (confidence 0.4): LLM-gestützter Vergleich (Stub, rate-limitiert)
 *
 * Jeder Preisvorschlag enthält: pricingTier, confidence, matchBasis
 */
const { firestore } = require('../lib/firestore');
const { getCollection } = require('../lib/product-store');

const PRICING_RULES_COLLECTION = 'pricingRules';

// ─── Tier 1: EAN/GTIN-Match mit Neuware-Filter ────────────────────────────────

async function _tier1EanMatch(product, filterCondition) {
  const pricing = product.details?.pricing || {};
  const buyPrice = parseFloat(pricing.buyPrice) || 0;
  const currentSellPrice = parseFloat(pricing.sellPrice) || 0;
  // Prefer runner-stored prices (details.pricing.competitorPrices) over legacy field
  const competitors = product.details?.pricing?.competitorPrices
    || product.details?.competitorPrices
    || [];

  const filteredCompetitors = filterCondition === 'new'
    ? competitors.filter(c => {
        const cond = (c.condition || '').toLowerCase().trim();
        return !cond || cond === 'new' || cond === 'neu' || cond === 'new_with_tags';
      })
    : competitors;

  const prices = filteredCompetitors
    .map(c => parseFloat(c.price))
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) return null;

  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[mid - 1] + prices[mid]) / 2
    : prices[mid];

  const medianBased = Math.round(median * 0.97 * 100) / 100;
  const minMargin = buyPrice > 0 ? Math.round(buyPrice * 1.10 * 100) / 100 : 0;
  const suggestedPrice = minMargin > 0 ? Math.max(medianBased, minMargin) : medianBased;
  const margin = buyPrice > 0
    ? Math.round(((suggestedPrice - buyPrice) / buyPrice) * 100 * 10) / 10
    : null;

  const ean = product.details?.identifiers?.ean
    || (Array.isArray(product.identification?.barcodes) ? product.identification.barcodes[0] : null);
  const matchBasis = ean
    ? `EAN ${ean}: ${prices.length} Neuware-Angebote (Median ${median.toFixed(2)} EUR)`
    : `${prices.length} Neuware-Angebote (Median ${median.toFixed(2)} EUR)`;

  return {
    productId: product.id,
    currentBuyPrice: buyPrice,
    currentSellPrice,
    competitorCount: prices.length,
    competitorMin: prices[0],
    competitorMax: prices[prices.length - 1],
    competitorMedian: median,
    suggestedPrice,
    margin,
    strategy: 'competitor_median_minus_3pct',
    pricingTier: 1,
    confidence: 0.9,
    matchBasis,
  };
}

// ─── Tier 2: Kategorie-Similarity (eigener Bestand) ──────────────────────────

async function _tier2CategoryMatch(product) {
  const category = product.identification?.category
    || product.details?.categoryId
    || null;
  if (!category) return null;

  const pricing = product.details?.pricing || {};
  const buyPrice = parseFloat(pricing.buyPrice) || 0;
  const currentSellPrice = parseFloat(pricing.sellPrice) || 0;

  try {
    const snap = await firestore.collection(getCollection())
      .where('identification.category', '==', category)
      .limit(50)
      .get();

    const prices = snap.docs
      .filter(d => d.id !== product.id)
      .map(d => parseFloat(d.data()?.details?.pricing?.sellPrice))
      .filter(p => p > 0)
      .sort((a, b) => a - b);

    if (prices.length < 3) return null;

    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0
      ? (prices[mid - 1] + prices[mid]) / 2
      : prices[mid];

    const minMargin = buyPrice > 0 ? Math.round(buyPrice * 1.10 * 100) / 100 : 0;
    const suggestedPrice = Math.round(
      (minMargin > 0 ? Math.max(median, minMargin) : median) * 100
    ) / 100;
    const margin = buyPrice > 0
      ? Math.round(((suggestedPrice - buyPrice) / buyPrice) * 100 * 10) / 10
      : null;

    return {
      productId: product.id,
      currentBuyPrice: buyPrice,
      currentSellPrice,
      competitorCount: prices.length,
      competitorMin: prices[0],
      competitorMax: prices[prices.length - 1],
      competitorMedian: median,
      suggestedPrice,
      margin,
      strategy: 'category_median',
      pricingTier: 2,
      confidence: 0.6,
      matchBasis: `${prices.length} ähnliche Produkte in Kategorie "${category}" (Median ${median.toFixed(2)} EUR)`,
    };
  } catch (err) {
    console.warn(`[pricing-engine] Tier 2 query failed for ${product.id}: ${err.message}`);
    return null;
  }
}

// ─── Tier 3: LLM-Fallback (Stub — rate-limitiert, noch nicht implementiert) ──

async function _tier3LlmFallback(product) {
  // TODO: Gemini-Call mit Produktbeschreibung + Kategorie → 3-5 vergleichbare Produkte
  // Rate-Limit: max 1 LLM-Pricing-Call pro Produkt pro Tag
  // Implementierung erfordert: Gemini-Client + Rate-Limit-Store in Firestore
  console.log(`[pricing-engine] Tier 3 LLM-Fallback not yet implemented for ${product.id}`);
  return null;
}

// ─── Kosten-Fallback wenn kein Tier liefert ───────────────────────────────────

function _costPlusFallback(product) {
  const pricing = product.details?.pricing || {};
  const buyPrice = parseFloat(pricing.buyPrice) || 0;
  const currentSellPrice = parseFloat(pricing.sellPrice) || 0;

  if (buyPrice <= 0) {
    return {
      productId: product.id,
      currentBuyPrice: 0,
      currentSellPrice,
      competitorCount: 0,
      competitorMin: null,
      competitorMax: null,
      competitorMedian: null,
      suggestedPrice: null,
      margin: null,
      strategy: 'manual',
      pricingTier: null,
      confidence: 0,
      matchBasis: null,
    };
  }

  const suggestedPrice = Math.round(buyPrice * 1.40 * 100) / 100;
  return {
    productId: product.id,
    currentBuyPrice: buyPrice,
    currentSellPrice,
    competitorCount: 0,
    competitorMin: null,
    competitorMax: null,
    competitorMedian: null,
    suggestedPrice,
    margin: 40.0,
    strategy: 'cost_plus_40pct',
    pricingTier: 0,
    confidence: 0.3,
    matchBasis: `Kostenbasis ${buyPrice.toFixed(2)} EUR × 1.40`,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Berechnet den optimalen Preis für ein Produkt (3-stufige Fallback-Strategie).
 *
 * @param {string} productId
 * @param {object} [opts]
 * @param {string} [opts.filterCondition='new'] - Nur Konkurrenzpreise mit diesem Zustand ('new'|'any')
 * @returns {Promise<object>} Preis-Analyse mit suggestedPrice, pricingTier, confidence, matchBasis
 */
async function calculateOptimalPrice(productId, { filterCondition = 'new' } = {}) {
  const doc = await firestore.collection(getCollection()).doc(productId).get();
  if (!doc.exists) {
    throw new Error(`Product ${productId} not found`);
  }
  const product = { id: doc.id, ...doc.data() };

  const tier1 = await _tier1EanMatch(product, filterCondition);
  if (tier1) return tier1;

  const tier2 = await _tier2CategoryMatch(product);
  if (tier2) return tier2;

  const tier3 = await _tier3LlmFallback(product);
  if (tier3) return tier3;

  return _costPlusFallback(product);
}

/**
 * Pricing-Regel erstellen oder aktualisieren.
 */
async function savePricingRule(rule) {
  const { productId, ruleType, params } = rule;
  if (!productId || !ruleType) {
    throw new Error('productId and ruleType are required');
  }
  const docRef = firestore.collection(PRICING_RULES_COLLECTION).doc(productId);
  const data = {
    productId,
    ruleType,
    params: params || {},
    active: true,
    lastApplied: null,
    updatedAt: new Date().toISOString(),
  };
  await docRef.set(data, { merge: true });
  return { id: docRef.id, ...data };
}

/**
 * Alle aktiven Pricing-Regeln laden.
 */
async function listPricingRules() {
  const snap = await firestore.collection(PRICING_RULES_COLLECTION)
    .where('active', '==', true)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Batch-Repricing: Alle Produkte mit aktiven Regeln prüfen.
 * Schreibt suggestedPrice + pricingTier + confidence + matchBasis in die aktive Collection.
 */
async function runRepricingJob() {
  const rules = await listPricingRules();
  const results = { processed: 0, updated: 0, errors: 0, suggestions: [] };

  for (const rule of rules) {
    try {
      const analysis = await calculateOptimalPrice(rule.productId);
      results.processed++;

      if (analysis.suggestedPrice) {
        results.suggestions.push({
          productId: rule.productId,
          currentPrice: analysis.currentSellPrice,
          suggestedPrice: analysis.suggestedPrice,
          margin: analysis.margin,
          strategy: analysis.strategy,
          pricingTier: analysis.pricingTier,
          confidence: analysis.confidence,
          matchBasis: analysis.matchBasis,
        });

        // Update pricing metadata in the active collection (additive — does not overwrite sellPrice)
        await firestore.collection(getCollection()).doc(rule.productId).set({
          details: {
            pricing: {
              suggestedPrice: analysis.suggestedPrice,
              pricingTier: analysis.pricingTier,
              pricingConfidence: analysis.confidence,
              pricingMatchBasis: analysis.matchBasis,
              lastPriceCheck: new Date().toISOString(),
            },
          },
        }, { merge: true });

        // Regel als angewendet markieren
        await firestore.collection(PRICING_RULES_COLLECTION).doc(rule.productId).set({
          lastApplied: new Date().toISOString(),
        }, { merge: true });

        results.updated++;
      }
    } catch (err) {
      console.error(`[pricing-engine] Error for ${rule.productId}:`, err.message);
      results.errors++;
    }
  }

  return results;
}

module.exports = {
  calculateOptimalPrice,
  savePricingRule,
  listPricingRules,
  runRepricingJob,
};
