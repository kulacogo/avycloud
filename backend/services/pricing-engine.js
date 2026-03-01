/**
 * Smart Pricing Engine
 *
 * Optimale Preisfindung basierend auf:
 * - Konkurrenzpreise (competitorPrices in Produkt-Daten)
 * - Lagerbestand-Alter
 * - Kategorie-Durchschnitt
 * - Eigene Kosten (buyPrice)
 */
const { firestore } = require('../lib/firestore');

const PRICING_RULES_COLLECTION = 'pricingRules';

/**
 * Berechnet den optimalen Preis für ein Produkt.
 */
async function calculateOptimalPrice(productId) {
  const doc = await firestore.collection('products').doc(productId).get();
  if (!doc.exists) {
    throw new Error(`Product ${productId} not found`);
  }
  const product = { id: doc.id, ...doc.data() };
  const pricing = product.details?.pricing || {};
  const competitors = product.details?.competitorPrices || [];

  const buyPrice = parseFloat(pricing.buyPrice) || 0;
  const currentSellPrice = parseFloat(pricing.sellPrice) || 0;

  // Konkurrenzpreise analysieren
  const competitorPrices = competitors
    .map(c => parseFloat(c.price))
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  const analysis = {
    productId,
    currentBuyPrice: buyPrice,
    currentSellPrice: currentSellPrice,
    competitorCount: competitorPrices.length,
    competitorMin: competitorPrices[0] || null,
    competitorMax: competitorPrices[competitorPrices.length - 1] || null,
    competitorMedian: null,
    suggestedPrice: null,
    margin: null,
    strategy: 'manual',
  };

  if (competitorPrices.length > 0) {
    const mid = Math.floor(competitorPrices.length / 2);
    analysis.competitorMedian = competitorPrices.length % 2 === 0
      ? (competitorPrices[mid - 1] + competitorPrices[mid]) / 2
      : competitorPrices[mid];

    // Standard-Strategie: Median minus 3%, aber mindestens 10% über buyPrice
    const medianBased = Math.round(analysis.competitorMedian * 0.97 * 100) / 100;
    const minMargin = buyPrice > 0 ? Math.round(buyPrice * 1.10 * 100) / 100 : 0;

    analysis.suggestedPrice = Math.max(medianBased, minMargin);
    analysis.strategy = 'competitor_median_minus_3pct';
  } else if (buyPrice > 0) {
    // Kein Konkurrenzvergleich: 40% Marge
    analysis.suggestedPrice = Math.round(buyPrice * 1.40 * 100) / 100;
    analysis.strategy = 'cost_plus_40pct';
  }

  if (analysis.suggestedPrice && buyPrice > 0) {
    analysis.margin = Math.round(((analysis.suggestedPrice - buyPrice) / buyPrice) * 100 * 10) / 10;
  }

  return analysis;
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
        });

        // Update suggestedPrice in Produkt (additiv, überschreibt nicht sellPrice)
        await firestore.collection('products').doc(rule.productId).set({
          pricing: {
            suggestedPrice: analysis.suggestedPrice,
            lastPriceCheck: new Date().toISOString(),
          },
        }, { merge: true });

        // Rule als angewendet markieren
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
