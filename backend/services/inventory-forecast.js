/**
 * Inventory Forecasting Service
 *
 * Vorhersage von Stock-Outs basierend auf historischen Verkaufsraten.
 */
const { firestore } = require('../lib/firestore');

/**
 * Berechnet die durchschnittliche Verkaufsgeschwindigkeit (Einheiten/Tag).
 */
async function calculateSalesVelocity(productId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Orders der letzten N Tage mit diesem Produkt zählen
  const ordersSnap = await firestore.collection('orders')
    .where('date_add', '>=', Math.floor(since.getTime() / 1000))
    .get();

  let totalSold = 0;
  for (const doc of ordersSnap.docs) {
    const order = doc.data();
    const products = order.products || [];
    for (const item of products) {
      if (item.product_id === productId || item.sku === productId) {
        totalSold += Number(item.quantity) || 1;
      }
    }
  }

  const velocity = days > 0 ? Math.round((totalSold / days) * 100) / 100 : 0;

  return {
    productId,
    periodDays: days,
    totalSold,
    salesVelocity: velocity,
    unit: 'units/day',
  };
}

/**
 * Schätzt das Stock-Out-Datum bei aktueller Verkaufsgeschwindigkeit.
 */
async function predictStockOut(productId) {
  const productDoc = await firestore.collection('products').doc(productId).get();
  if (!productDoc.exists) {
    throw new Error(`Product ${productId} not found`);
  }
  const product = productDoc.data();
  const currentStock = Number(product.ops?.totalStock || product.ops?.stock || 0);

  const { salesVelocity } = await calculateSalesVelocity(productId, 30);

  let predictedStockOut = null;
  let daysUntilStockOut = null;

  if (salesVelocity > 0 && currentStock > 0) {
    daysUntilStockOut = Math.ceil(currentStock / salesVelocity);
    predictedStockOut = new Date(Date.now() + daysUntilStockOut * 24 * 60 * 60 * 1000).toISOString();
  } else if (currentStock <= 0) {
    daysUntilStockOut = 0;
    predictedStockOut = new Date().toISOString();
  }

  return {
    productId,
    currentStock,
    salesVelocity,
    daysUntilStockOut,
    predictedStockOut,
    lastCalculated: new Date().toISOString(),
  };
}

/**
 * Alle Produkte identifizieren, die in < 14 Tagen ausverkauft sein werden.
 */
async function generateReorderAlerts(thresholdDays = 14) {
  const productsSnap = await firestore.collection('products')
    .where('ops.totalStock', '>', 0)
    .limit(500)
    .get();

  const alerts = [];

  for (const doc of productsSnap.docs) {
    try {
      const prediction = await predictStockOut(doc.id);
      if (prediction.daysUntilStockOut !== null && prediction.daysUntilStockOut <= thresholdDays) {
        const product = doc.data();
        alerts.push({
          productId: doc.id,
          name: product.identification?.name || 'Unknown',
          sku: product.identification?.sku || '',
          currentStock: prediction.currentStock,
          salesVelocity: prediction.salesVelocity,
          daysUntilStockOut: prediction.daysUntilStockOut,
          predictedStockOut: prediction.predictedStockOut,
          urgency: prediction.daysUntilStockOut <= 3 ? 'critical'
            : prediction.daysUntilStockOut <= 7 ? 'high'
            : 'medium',
        });
      }
    } catch (err) {
      // Skip products that can't be analyzed
    }
  }

  // Nach Dringlichkeit sortieren
  alerts.sort((a, b) => a.daysUntilStockOut - b.daysUntilStockOut);

  return { alerts, total: alerts.length, threshold: thresholdDays };
}

module.exports = {
  calculateSalesVelocity,
  predictStockOut,
  generateReorderAlerts,
};
