'use strict';

/**
 * Operational dashboard aggregator — COUNTS, not euros.
 *
 * Powers the redesigned dashboard: live operational backlog (current state),
 * windowed per-marketplace order/unit/storno/return counts, and an authoritative
 * full-collection status breakdown. The "must be reliable" requirement is met by
 * counting over the *whole* tenant order set server-side instead of tallying a
 * page of orders in the browser.
 *
 * The counting logic is a pure function (`aggregateOperationalMetrics`) so it can
 * be unit-tested deterministically with a fixed `now`. `getOperationalMetrics`
 * is the thin Firestore-fetching wrapper around it.
 */

const KNOWN_MARKETPLACES = new Set(['ebay', 'kaufland', 'amazon', 'otto', 'shopify']);

// Current-state OMS buckets for the live operational row.
const WAITING_PICKING_STATUSES = new Set(['pending', 'confirmed', 'new']);
const IN_PROGRESS_STATUSES = new Set(['picking', 'picked', 'packing', 'packed']);
const SHIPPED_STATUSES = new Set(['shipped', 'delivered', 'completed']);

// Canonical OMS statuses for the authoritative breakdown (mirrors
// services/order-state-machine.js ORDER_STATUSES).
const OMS_STATUS_KEYS = [
  'pending', 'confirmed', 'picking', 'picked', 'packing', 'packed',
  'shipped', 'delivered', 'completed', 'cancelled', 'returned', 'on_hold',
];

function normalizeStr(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v == null ? '' : String(v).trim().toLowerCase();
}

/**
 * Resolve an order's marketplace to one of: 'ebay' | 'kaufland' | 'other'.
 * Mirrors routes/orders.js resolveOrderMarketplace, collapsed to the two
 * integrated channels + an "other" catch-all so the breakdown always balances.
 */
function resolveMarketplace(order) {
  const stored = normalizeStr(order.marketplace || order.source);
  if (stored === 'ebay' || stored === 'kaufland') return stored;
  if (KNOWN_MARKETPLACES.has(stored)) return 'other';

  const rawSrc = normalizeStr((order.raw || {}).order_source);
  if (rawSrc.includes('ebay')) return 'ebay';
  if (rawSrc.includes('kaufland') || rawSrc.includes('real')) return 'kaufland';

  const extId = String(order.marketplaceOrderId || order.externalOrderId || order.orderSourceId || '');
  if (/^\d{2}-\d{5,}-\d{5,}$/.test(extId)) return 'ebay';

  return 'other';
}

/**
 * Canonical current OMS status for an order. Prefers the modern `omsStatus`
 * field (single-writer enforced via transitionOrder); falls back to the legacy
 * `status`/`statusLabel` substring so older docs still bucket sensibly.
 */
function normalizeOrderStatus(order) {
  const oms = normalizeStr(order.omsStatus);
  if (oms && OMS_STATUS_KEYS.includes(oms)) return oms;
  if (oms === 'new') return 'pending';

  const raw = normalizeStr(order.statusLabel || order.status);
  if (raw === 'new' || raw.includes('neu') || raw.includes('bestätigt') || raw.includes('bestaetigt') || raw.includes('confirmed')) return 'confirmed';
  if (raw.includes('storniert') || raw.includes('cancel')) return 'cancelled';
  if (raw.includes('retour') || raw.includes('return') || raw.includes('rücksend') || raw.includes('ruecksend')) return 'returned';
  if (raw.includes('zugestellt') || raw.includes('delivered')) return 'delivered';
  if (raw.includes('versendet') || raw.includes('shipped') || raw.includes('dispatched')) return 'shipped';
  if (raw.includes('verpackt') || raw.includes('packed')) return 'packed';
  if (raw.includes('kommission') || raw.includes('picked') || raw.includes('picking')) return 'picked';
  return 'other';
}

function parseDate(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sumUnits(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.reduce((sum, it) => sum + (Number(it && it.quantity) || 0), 0);
}

function emptyBucket() {
  return { orders: 0, units: 0, cancellations: 0, returns: 0 };
}

/**
 * Pure aggregation. Deterministic given (orders, returns, range, now).
 *
 * @param {object} input
 * @param {Array<object>} input.orders   raw order docs
 * @param {Array<object>} input.returns  raw return docs
 * @param {Date} input.rangeStart        inclusive window start (createdAt >=)
 * @param {Date} input.rangeEndExclusive exclusive window end (createdAt <)
 * @param {Date} input.now               reference clock for "today"
 */
function aggregateOperationalMetrics({ orders = [], returns = [], rangeStart, rangeEndExclusive, now }) {
  const ref = now instanceof Date ? now : new Date(now);
  const todayStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0));

  const live = { waiting_picking: 0, in_progress: 0, shipped_today: 0 };

  const marketplaces = {
    ebay: emptyBucket(),
    kaufland: emptyBucket(),
    other: emptyBucket(),
    total: emptyBucket(),
  };

  const statusCounts = { total: 0 };
  for (const k of OMS_STATUS_KEYS) statusCounts[k] = 0;
  statusCounts.other = 0;

  const inWindow = (d) => d && d >= rangeStart && d < rangeEndExclusive;

  for (const order of orders) {
    const status = normalizeOrderStatus(order);

    // Authoritative full-collection status breakdown (current state).
    statusCounts.total += 1;
    if (Object.prototype.hasOwnProperty.call(statusCounts, status)) statusCounts[status] += 1;
    else statusCounts.other += 1;

    // Live operational backlog — current state, NOT windowed.
    if (WAITING_PICKING_STATUSES.has(status)) {
      live.waiting_picking += 1;
    } else if (IN_PROGRESS_STATUSES.has(status)) {
      live.in_progress += 1;
    } else if (SHIPPED_STATUSES.has(status)) {
      const shippedAt = parseDate(order.shippedAt);
      if (shippedAt && shippedAt >= todayStart && shippedAt <= ref) live.shipped_today += 1;
    }

    // Windowed marketplace breakdown — by order date (createdAt).
    const createdAt = parseDate(order.createdAt) || parseDate(order.updatedAt);
    if (!inWindow(createdAt)) continue;

    const mp = resolveMarketplace(order);
    const bucket = marketplaces[mp] || marketplaces.other;

    if (status === 'cancelled') {
      bucket.cancellations += 1;
      marketplaces.total.cancellations += 1;
    } else {
      const units = sumUnits(order);
      bucket.orders += 1;
      bucket.units += units;
      marketplaces.total.orders += 1;
      marketplaces.total.units += units;
    }
  }

  // Returns are a parallel workflow (the order stays "shipped"), so count them
  // from the returns collection — never from order status.
  for (const ret of returns) {
    const createdAt = parseDate(ret.createdAt);
    if (!inWindow(createdAt)) continue;
    const mp = ret.marketplace === 'ebay' || ret.marketplace === 'kaufland' ? ret.marketplace : 'other';
    marketplaces[mp].returns += 1;
    marketplaces.total.returns += 1;
  }

  return { live, window: { marketplaces }, statusCounts };
}

/**
 * Resolve a preset (+ optional custom from/to) to a UTC date window.
 * Mirrors getDashboardMetrics() in lib/firestore.js so the operational dashboard
 * and the legacy revenue dashboard always agree on what "last 7 days" means.
 *
 * @returns {{ rangeStart: Date, rangeEndExclusive: Date, label: string, preset: string }}
 */
function resolveRange({ preset = null, fromDate = null, toDate = null, now } = {}) {
  const ref = now instanceof Date ? now : (now ? new Date(now) : new Date());
  const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
  const yearStart = (y) => new Date(Date.UTC(y, 0, 1, 0, 0, 0));

  const v = normalizeStr(preset);
  const canonical = (() => {
    if (!v) return 'last7';
    if (v === 'today' || v === 'heute') return 'today';
    if (['last7', 'last_7_days', '7d', '7_days'].includes(v)) return 'last7';
    if (['this_week', 'week', 'diese_woche'].includes(v)) return 'this_week';
    if (['month', 'this_month', 'current_month', 'mtd', 'month_to_date'].includes(v)) return 'month_to_date';
    if (['last_month', 'previous_month'].includes(v)) return 'last_month';
    if (['year', 'this_year', 'current_year', 'ytd', 'year_to_date'].includes(v)) return 'year_to_date';
    if (['last_year', 'previous_year'].includes(v)) return 'last_year';
    if (['all_time', 'all', 'gesamt'].includes(v)) return 'all_time';
    if (v === 'custom' || v === 'benutzerdefiniert') return 'custom';
    if (/^month_\d{4}_\d{2}$/.test(v)) return v;
    return 'last7';
  })();

  let rangeStart;
  let rangeEndExclusive = ref;
  let label;

  if (canonical === 'today') {
    rangeStart = dayStart(ref);
    label = 'Heute';
  } else if (canonical === 'this_week') {
    const dow = ref.getUTCDay() || 7;
    rangeStart = dayStart(ref);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - (dow - 1));
    label = 'Diese Woche';
  } else if (canonical === 'month_to_date') {
    rangeStart = monthStart(ref);
    label = 'Aktueller Monat';
  } else if (canonical === 'last_month') {
    rangeStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1, 0, 0, 0));
    rangeEndExclusive = monthStart(ref);
    label = 'Letzter Monat';
  } else if (canonical === 'year_to_date') {
    rangeStart = yearStart(ref.getUTCFullYear());
    label = 'Dieses Jahr';
  } else if (canonical === 'last_year') {
    rangeStart = yearStart(ref.getUTCFullYear() - 1);
    rangeEndExclusive = yearStart(ref.getUTCFullYear());
    label = 'Letztes Jahr';
  } else if (canonical === 'all_time') {
    rangeStart = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
    label = 'Gesamter Zeitraum';
  } else if (canonical === 'custom') {
    const from = fromDate ? new Date(`${fromDate}T00:00:00Z`) : null;
    const to = toDate ? (() => { const d = new Date(`${toDate}T00:00:00Z`); if (Number.isNaN(d.getTime())) return null; d.setUTCDate(d.getUTCDate() + 1); return d; })() : null;
    rangeStart = from && !Number.isNaN(from.getTime()) ? from : dayStart(ref);
    rangeEndExclusive = to || ref;
    label = 'Benutzerdefiniert';
  } else if (/^month_\d{4}_\d{2}$/.test(canonical)) {
    const [, y, m] = canonical.split('_').map(Number);
    rangeStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    rangeEndExclusive = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  } else {
    // last7 (default + fallback): 7 calendar days inclusive of today.
    rangeStart = dayStart(ref);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - 6);
    label = 'Letzte 7 Tage';
  }

  return { rangeStart, rangeEndExclusive, label, preset: canonical };
}

/**
 * Firestore-fetching wrapper. Reads the tenant's full order set + returns once,
 * then delegates all counting to the pure aggregator. Tenant-scoped per CLAUDE.md #8.
 */
async function getOperationalMetrics({ preset = null, fromDate = null, toDate = null, tenantId = null } = {}) {
  const { firestore } = require('./firestore');
  const now = new Date();
  const range = resolveRange({ preset, fromDate, toDate, now });

  let ordersRef = firestore.collection('orders');
  if (tenantId) ordersRef = ordersRef.where('tenantId', '==', tenantId);
  let returnsRef = firestore.collection('returns');
  if (tenantId) returnsRef = returnsRef.where('tenantId', '==', tenantId);

  const [ordersSnap, returnsSnap] = await Promise.all([
    ordersRef.get(),
    returnsRef.select('marketplace', 'createdAt').get().catch(() => ({ docs: [] })),
  ]);

  const orders = ordersSnap.docs.map((d) => d.data() || {});
  const returns = (returnsSnap.docs || []).map((d) => d.data() || {});

  const agg = aggregateOperationalMetrics({
    orders,
    returns,
    rangeStart: range.rangeStart,
    rangeEndExclusive: range.rangeEndExclusive,
    now,
  });

  return {
    range: {
      preset: range.preset,
      label: range.label,
      from_iso: range.rangeStart.toISOString(),
      to_iso: range.rangeEndExclusive.toISOString(),
    },
    ...agg,
  };
}

module.exports = {
  aggregateOperationalMetrics,
  resolveRange,
  getOperationalMetrics,
  resolveMarketplace,
  normalizeOrderStatus,
  OMS_STATUS_KEYS,
};
