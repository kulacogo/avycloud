'use strict';

// Same established back-to-front sequence as utils/warehouseRoute.ts. These
// are ordinal locations, not coordinates or a claim about walking metres.
const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ', 'P'];
const FLOORS = ['GA', 'EG', 'UG'];
const code = value => String(value || '').trim().toUpperCase();
function parseBin(value) {
  const match = /^(XQ|XS|XL|X|S|M|L|P)(GA|EG|UG)(\d{2})(\d{2})([A-G])(\d{2})?$/.exec(code(value));
  if (!match || Number(match[3]) < 1 || Number(match[4]) < 1) return null;
  return { zone: match[1], etage: match[2], gang: Number(match[3]), regal: Number(match[4]), ebene: match[5], child: match[6] || '' };
}
function compareBins(a, b) {
  const pa = parseBin(a); const pb = parseBin(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : code(a).localeCompare(code(b), 'de', { numeric: true });
  return ZONES.indexOf(pa.zone) - ZONES.indexOf(pb.zone)
    || FLOORS.indexOf(pa.etage) - FLOORS.indexOf(pb.etage)
    || pb.gang - pa.gang || pb.regal - pa.regal
    || pa.ebene.localeCompare(pb.ebene) || pa.child.localeCompare(pb.child);
}
function lastPickBin(order) {
  const work = order?.pickWork;
  if (parseBin(work?.lastBinCode)) return code(work.lastBinCode);
  // Firestore map iteration order is not receipt chronology. Historical
  // assignments only give a proven endpoint if all receipts share one BIN.
  const bins = [...new Set(Object.values(work?.receipts || {}).map(r => code(r.binCode)).filter(Boolean))];
  return bins.length === 1 && parseBin(bins[0]) ? bins[0] : null;
}
function time(value) {
  const raw = value?.toDate ? value.toDate().getTime() : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(raw) ? raw : 0;
}
function rankPickCandidates(orders, lastBin = null) {
  const anchor = parseBin(lastBin);
  const entries = orders.map(order => {
    const bins = [...(order.routeBins || [])].filter(b => parseBin(b)).sort(compareBins);
    const first = bins[0]; const position = parseBin(first);
    const sameArea = position && anchor && position.zone === anchor.zone && position.etage === anchor.etage;
    const at = time(order.createdAt);
    return { order, first, at,
      known: position ? 0 : 1, area: sameArea ? 0 : 1,
      aisle: sameArea && position.gang === anchor.gang ? 0 : 1,
      behind: position && anchor && compareBins(first, lastBin) < 0 ? 1 : 0 };
  });
  // This is a continuous warehouse round, not FIFO dispatching. Exhaust nearby
  // work before leaving the area; FIFO is a tie-break at the same BIN.
  return entries.sort((a, b) => a.known - b.known || a.area - b.area
    || a.aisle - b.aisle || a.behind - b.behind || compareBins(a.first, b.first)
    || a.at - b.at || String(a.order.id).localeCompare(String(b.order.id))).map(entry => entry.order);
}
function planOrderBins(order, resolveProduct) {
  const pools = new Map(); const route = [];
  for (const item of Array.isArray(order.items) ? order.items : []) {
    const product = resolveProduct(item);
    if (!product) continue;
    if (!pools.has(product.id)) {
      const bins = (Array.isArray(product.storageBins) ? product.storageBins : [])
        .filter(b => b?.code && Number.isFinite(Number(b.quantity)) && Number(b.quantity) > 0)
        .map(b => ({ code: code(b.code), quantity: Number(b.quantity) }));
      if (!bins.length && product.storage?.binCode && Number.isFinite(Number(product.storage.quantity)) && Number(product.storage.quantity) > 0) {
        bins.push({ code: code(product.storage.binCode), quantity: Number(product.storage.quantity) });
      }
      pools.set(product.id, bins);
    }
    const remaining = Number(item.quantity);
    const pool = pools.get(product.id);
    if (Number.isSafeInteger(remaining) && remaining > 0) {
      pool.sort((a, b) => b.quantity - a.quantity || compareBins(a.code, b.code));
      const bin = pool.find(b => b.quantity > 0);
      if (!bin) continue;
      const amount = Math.min(remaining, bin.quantity);
      route.push(bin.code); bin.quantity -= amount;
    }
  }
  return [...new Set(route)].sort(compareBins);
}

module.exports = { parseBin, compareBins, lastPickBin, rankPickCandidates, planOrderBins };
