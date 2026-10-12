'use strict';
const { planOrderBins, planOrderStops } = require('./pick-route');
const fields = ['tenantId', 'identification.sku', 'details.identifiers.sku', 'details.identifiers.ean', 'storageBins', 'storage'];
const text = value => String(value || '').trim();
const normalize = value => text(value).toUpperCase();
const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

// Read-only planning projection. Quantities are NOT reserved here. The existing
// stock transaction remains the sole authority on ownership and actual stock.
async function loadPickRouteBins(db, { tenantId, orders, stops = false, lastBinCode = null }) {
  if (!tenantId) throw new Error('Pick route tenant is required');
  if (!orders.length) return new Map();
  const scoped = orders.filter(order => (order.tenantId || 'default') === tenantId);
  const items = scoped.flatMap(order => Array.isArray(order.items) ? order.items.filter(Boolean) : []);
  const products = new Map();
  const add = doc => {
    if (!doc.exists) return;
    const data = doc.data();
    if ((data.tenantId || 'default') === tenantId) products.set(doc.id, { ...data, id: doc.id });
  };
  const ids = [...new Set(items.map(item => text(item.productId)).filter(id => id && !id.includes('/')))];
  for (const batch of chunks(ids, 100)) {
    const docs = await db.getAll(...batch.map(id => db.collection('products_v2').doc(id)), { fieldMask: fields });
    docs.forEach(add);
  }
  const unresolved = items.filter(item => !products.has(text(item.productId)));
  const skus = [...new Set(unresolved.flatMap(item => [text(item.sku), normalize(item.sku)]).filter(Boolean))];
  const eans = [...new Set(unresolved.filter(item => !item.sku).map(item => text(item.ean)).filter(Boolean))];
  for (const [field, values] of [['identification.sku', skus], ['details.identifiers.sku', skus], ['details.identifiers.ean', eans]]) {
    for (const batch of chunks(values, 30)) {
      const snapshot = await db.collection('products_v2').where('tenantId', '==', tenantId)
        .where(field, 'in', batch).select(...fields).get();
      snapshot.docs.forEach(add);
    }
  }
  const aliases = new Map();
  const addAlias = (key, product) => {
    if (!key) return;
    if (!aliases.has(key)) aliases.set(key, product);
    else if (aliases.get(key)?.id !== product.id) aliases.set(key, null); // ambiguous is not a location
  };
  for (const product of products.values()) {
    for (const sku of [product.identification?.sku, product.details?.identifiers?.sku]) {
      if (sku) addAlias(`sku:${normalize(sku)}`, product);
    }
    if (product.details?.identifiers?.ean) addAlias(`ean:${text(product.details.identifiers.ean)}`, product);
  }
  const resolve = item => products.get(text(item.productId)) || aliases.get(item.sku ? `sku:${normalize(item.sku)}` : `ean:${text(item.ean)}`);
  return new Map(scoped.map(order => [order.id, stops
    ? planOrderStops(order, resolve, { nearest: true, lastBinCode }) : planOrderBins(order, resolve)]));
}
const loadPickRouteStops = (db, context) => loadPickRouteBins(db, { ...context, stops: true });
module.exports = { loadPickRouteBins, loadPickRouteStops };
