const products = [
  { id: 'p1', identification: { sku: 'SKU-8918729216', name: 'Marimekko Unikko Badematte 73×74 cm Baumwolle Creme Warm Orange' },
    details: { identifiers: { sku: 'SKU-8918729216' }, images: [] }, inventory: { quantity: 8 }, storage: { binCode: 'XEG0107D', quantity: 8 }, storageBins: [{ code: 'XEG0107D', quantity: 8 }] },
  { id: 'p2', identification: { sku: 'SKU-6684830308', name: 'Roadworx Mic Stand Round Base Mikrofonstativ mit Rundsockel 92–160 cm' },
    details: { identifiers: { sku: 'SKU-6684830308' }, images: [] }, inventory: { quantity: 4 }, storage: { binCode: 'LEG0304E', quantity: 4 }, storageBins: [{ code: 'LEG0304E', quantity: 4 }] },
];
export { products };
const initial = { id: 'demo-order', number: 'AV-1', marketplaceOrderId: '27-15230-28128', tenantId: 'default', omsStatus: 'confirmed', status: 'confirmed', statusLabel: 'Bestätigt', source: 'ebay', createdAt: '2026-10-06T12:00:00Z', customer: { street: 'Teststraße 1', city: 'Berlin', zip: '10000' },
  items: products.map((product, i) => ({ id: `item-${i}`, productId: product.id, sku: product.identification.sku, name: product.identification.name, quantity: i === 0 ? 2 : 1 })) };
if (new URLSearchParams(location.search).get('reset') === '1') { sessionStorage.removeItem('preview-order'); sessionStorage.removeItem('avycloud:pending-label:preview-user'); }
let order = JSON.parse(sessionStorage.getItem('preview-order') || 'null') || initial;
const save = () => sessionStorage.setItem('preview-order', JSON.stringify(order));
export const fetchOrders = async () => [structuredClone(order)];
export const syncOrders = fetchOrders;
export const fetchOperationalMetrics = async () => ({ live: { shipped_today: 30 }, statusCounts: { confirmed: 20, picked: 1 } });
export const fetchProfile = async () => ({ printing: { labelFormat: 'a6' } });
export const fetchPickWork = async () => order.pickWork ? structuredClone(order) : null;
export const claimPickWork = async () => {
  if (['picked', 'shipped'].includes(order.omsStatus)) return null;
  order.pickWork ||= { ownerUid: 'preview-user', token: 'preview-token', status: 'active', lines: order.items.map((item) => ({ itemId: item.id, required: item.quantity, picked: 0 })) };
  order.pickWork.status = 'active'; save(); return structuredClone(order);
};
export const pausePickWork = async () => { order.pickWork.status = 'paused'; save(); };
export const stockOutProduct = async (payload) => {
  const line = order.pickWork.lines.find((line) => line.itemId === payload.orderItemId);
  line.picked += payload.quantity; save();
  return { ok: true, data: { product: products.find((product) => product.id === payload.productId), pickWork: order.pickWork } };
};
export const stockInProduct = async () => { throw new Error('Einlagerung ist in dieser lokalen Prüfung deaktiviert.'); };
export const completeOrder = async () => { order.omsStatus = 'picked'; order.status = 'picked'; order.statusLabel = 'Kommissioniert'; save(); };
export const packOrder = async () => {};
export const fetchShippingOptions = async () => ({ enabled: true, weightEstimate: 1.5, products: [{ tracking: true, key: 'dhl-paket', displayName: 'DHL Paket', shippingOptionCode: 'dhl:paket', name: 'DHL Paket', carrier: 'dhl', label: 'DHL Paket', maxWeight: 2, price: 5.99 }], country: 'DE' });
export const fetchShippingPreview = async () => ({ weight: 1.5, matches: [] });
export const updateOrderWeight = async () => {};
export const packAndShip = async () => { order.omsStatus = 'shipped'; save(); return { carrier: 'DHL', labelBlob: new Blob(['demo']) }; };
export const fetchPrintStatus = async () => ({ enabled: true, online: new URLSearchParams(location.search).get('offline') !== '1' });
export const enqueueLabelPrint = async () => ({ jobId: 'demo-print' });
export const waitForPrintJob = async () => ({ status: 'done' });

export const buildImageProxyUrl = (url) => url;
export const fetchWarehouseBinDetail = async (code) => ({ code, products: products.map(p => ({ productId:p.id, sku:p.identification.sku, name:p.identification.name, quantity:p.inventory.quantity })) });
