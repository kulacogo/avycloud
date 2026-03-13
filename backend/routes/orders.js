const router = require('express').Router();
const { requirePermission } = require('../lib/rbac');
const { listOrders, getDashboardMetrics, computeOrdersDeliveryTotal } = require('../lib/firestore');
const { syncNewOrders, markOrderAsPicked, markOrderAsPacked } = require('../services/order-sync');
const { attachPickHintsToOrders } = require('../services/pick-hints');
const { callBaseLinker } = require('../lib/baselinker');
const { getCheckAccountBalances, getShippingCostsFromSevDesk } = require('../lib/sevdesk');
const { getShippingCostsSummaryFromBaseLinker } = require('../lib/baselinker-shipping');
const { getShippingCostsSummary: getSendCloudShippingSummary } = require('../lib/sendcloud');
const { getEbayNetRevenueSummary } = require('../lib/ebay-finances');
const { emitSyncEvent } = require('../services/sync-event-bus');

// ── Factory: backgroundSyncOrders wird von index.js injiziert ────────

let _backgroundSyncOrders = () => {};

function setBackgroundSyncOrders(fn) {
  _backgroundSyncOrders = fn;
}

// --- Dashboard helpers: BaseLinker order returns (for returns KPIs + net revenue) ---
const ORDER_RETURNS_CACHE_TTL_MS = parseInt(process.env.ORDER_RETURNS_CACHE_TTL_MS || String(5 * 60 * 1000), 10);
const ORDER_RETURNS_MAX_PAGES = parseInt(process.env.ORDER_RETURNS_MAX_PAGES || '50', 10);
const ORDER_RETURNS_MAX_ITEMS = parseInt(process.env.ORDER_RETURNS_MAX_ITEMS || '5000', 10);
let ORDER_RETURNS_CACHE = {
  atMs: 0,
  dateFromUnix: 0,
  returns: [],
};

function computeOrderReturnValueBrutto(returnEntry = {}) {
  const products = Array.isArray(returnEntry?.products) ? returnEntry.products : [];
  const value = products.reduce((sum, p) => {
    const price = Number(p?.price_brutto || 0) || 0;
    const qty = Number(p?.quantity || 0) || 0;
    return sum + price * qty;
  }, 0);
  const currency = (returnEntry?.currency || '').toString().trim().toUpperCase() || 'EUR';
  const createdAt = returnEntry?.date_add ? new Date(Number(returnEntry.date_add) * 1000) : null;
  return { currency, value: Number(value) || 0, createdAt };
}

async function loadOrderReturnsSince(dateFromUnix, { timeoutMs = 20_000 } = {}) {
  const now = Date.now();
  if (
    ORDER_RETURNS_CACHE.returns?.length &&
    ORDER_RETURNS_CACHE.dateFromUnix === dateFromUnix &&
    ORDER_RETURNS_CACHE.atMs &&
    now - ORDER_RETURNS_CACHE.atMs < ORDER_RETURNS_CACHE_TTL_MS
  ) {
    return ORDER_RETURNS_CACHE.returns;
  }

  const out = [];
  const seen = new Set();
  let idFrom = null;

  for (let page = 0; page < ORDER_RETURNS_MAX_PAGES; page += 1) {
    const params = {
      date_from: dateFromUnix,
      ...(idFrom ? { id_from: idFrom } : {}),
      include_custom_extra_fields: false,
      include_connect_data: false,
    };
    const response = await callBaseLinker('getOrderReturns', params, { timeoutMs, retries: 2 });
    const batch = Array.isArray(response?.returns) ? response.returns : [];
    if (!batch.length) break;

    let maxId = 0;
    for (const entry of batch) {
      const rid = entry?.return_id != null ? String(entry.return_id) : '';
      const n = Number(entry?.return_id || 0) || 0;
      if (n > maxId) maxId = n;
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      out.push(entry);
      if (out.length >= ORDER_RETURNS_MAX_ITEMS) break;
    }

    if (out.length >= ORDER_RETURNS_MAX_ITEMS) break;
    if (batch.length < 100) break; // docs: max 100 per call
    if (!maxId) break;
    idFrom = maxId + 1;
  }

  ORDER_RETURNS_CACHE = { atMs: Date.now(), dateFromUnix, returns: out };
  return out;
}

function computeOrderReturnsStats(returnsList, { rangeStart, rangeEndExclusive, monthStart } = {}) {
  const totals = { count: 0, valueByCurrency: new Map() };
  const month = { count: 0, valueByCurrency: new Map() };
  const window = { count: 0, valueByCurrency: new Map() };

  const add = (bucket, currency, amount) => {
    bucket.valueByCurrency.set(currency, (bucket.valueByCurrency.get(currency) || 0) + (Number(amount) || 0));
  };

  (returnsList || []).forEach((entry) => {
    const { currency, value, createdAt } = computeOrderReturnValueBrutto(entry);
    totals.count += 1;
    add(totals, currency, value);

    if (createdAt && monthStart && createdAt >= monthStart) {
      month.count += 1;
      add(month, currency, value);
    }

    if (createdAt && rangeStart && rangeEndExclusive && createdAt >= rangeStart && createdAt < rangeEndExclusive) {
      window.count += 1;
      add(window, currency, value);
    }
  });

  const mapToObject = (m) => Object.fromEntries(Array.from(m.entries()).map(([k, v]) => [k, Number((v || 0).toFixed(2))]));
  return {
    total: { count: totals.count, value_by_currency: mapToObject(totals.valueByCurrency) },
    month: { count: month.count, value_by_currency: mapToObject(month.valueByCurrency) },
    window: { count: window.count, value_by_currency: mapToObject(window.valueByCurrency) },
  };
}

// --- Dashboard helpers: BaseLinker orders (for accurate revenue/volume across long presets) ---
// Official docs: https://api.baselinker.com/index.php?method=getOrders
// Official docs: https://api.baselinker.com/index.php?method=getOrderStatusList
const DASHBOARD_ORDERS_CACHE_TTL_MS = parseInt(
  process.env.DASHBOARD_ORDERS_CACHE_TTL_MS || String(15 * 60 * 1000),
  10
);
const DASHBOARD_ORDERS_MAX_PAGES = parseInt(process.env.DASHBOARD_ORDERS_MAX_PAGES || '200', 10);
const DASHBOARD_ORDERS_MAX_ITEMS = parseInt(process.env.DASHBOARD_ORDERS_MAX_ITEMS || '20000', 10);
const DASHBOARD_ORDER_STATUS_CACHE_TTL_MS = parseInt(
  process.env.DASHBOARD_ORDER_STATUS_CACHE_TTL_MS || String(15 * 60 * 1000),
  10
);

let DASHBOARD_ORDERS_AGG_CACHE = new Map(); // key -> { atMs, data }
let DASHBOARD_ORDER_STATUS_CACHE = { atMs: 0, byId: new Map() }; // string id -> normalized name

function normalizeLower(input) {
  return (input || '').toString().trim().toLowerCase();
}

async function ensureDashboardOrderStatusNameMap({ timeoutMs = 15_000 } = {}) {
  const now = Date.now();
  if (
    DASHBOARD_ORDER_STATUS_CACHE.byId &&
    DASHBOARD_ORDER_STATUS_CACHE.byId.size &&
    DASHBOARD_ORDER_STATUS_CACHE.atMs &&
    now - DASHBOARD_ORDER_STATUS_CACHE.atMs < DASHBOARD_ORDER_STATUS_CACHE_TTL_MS
  ) {
    return DASHBOARD_ORDER_STATUS_CACHE.byId;
  }
  try {
    const response = await callBaseLinker('getOrderStatusList', {}, { timeoutMs, retries: 2 });
    const statuses = Array.isArray(response?.statuses) ? response.statuses : [];
    const next = new Map();
    statuses.forEach((s) => {
      if (s?.id == null) return;
      const id = String(s.id).trim();
      const name = normalizeLower(s?.name || s?.name_for_customer || '');
      if (!id || !name) return;
      next.set(id, name);
    });
    DASHBOARD_ORDER_STATUS_CACHE = { atMs: now, byId: next };
    return next;
  } catch (err) {
    // Best-effort: keep existing cache on failure.
    return DASHBOARD_ORDER_STATUS_CACHE.byId || new Map();
  }
}

function isCancelledByStatusId(statusId, statusNameById) {
  if (!statusId) return false;
  const name = statusNameById?.get(String(statusId).trim()) || '';
  if (!name) return false;
  return name.includes('storniert') || name.includes('cancel');
}

function computeBaseLinkerOrderValueBrutto(orderEntry = {}) {
  const products = Array.isArray(orderEntry?.products) ? orderEntry.products : [];
  const productsValue = products.reduce((sum, p) => {
    const price = Number(p?.price_brutto || 0) || 0;
    const qty = Number(p?.quantity || 0) || 0;
    return sum + price * qty;
  }, 0);
  const delivery = Number(orderEntry?.delivery_price || 0) || 0;
  const value = productsValue + delivery;
  const currency = (orderEntry?.currency || '').toString().trim().toUpperCase() || 'EUR';
  const confirmedAt = orderEntry?.date_confirmed ? new Date(Number(orderEntry.date_confirmed) * 1000) : null;
  return { currency, value: Number(value) || 0, confirmedAt };
}

function computeDashboardBucketKey(dt, { bucket, bucketStepHours, startDay } = {}) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  if (bucket === 'month') {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  if (bucket === 'week') {
    if (!(startDay instanceof Date) || Number.isNaN(startDay.getTime())) return dt.toISOString().slice(0, 10);
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const dayStartAt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0, 0, 0));
    const diffDays = Math.floor((dayStartAt.getTime() - startDay.getTime()) / MS_PER_DAY);
    const idx = Math.max(0, Math.floor(diffDays / 7));
    const d = new Date(startDay);
    d.setUTCDate(startDay.getUTCDate() + idx * 7);
    return d.toISOString().slice(0, 10);
  }
  if (bucket === 'hour') {
    const step = Math.max(1, Number(bucketStepHours) || 1);
    const hour = dt.getUTCHours();
    const bucketHour = Math.floor(hour / step) * step;
    const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), bucketHour, 0, 0));
    return d.toISOString();
  }
  // day
  return dt.toISOString().slice(0, 10);
}

async function computeDashboardBaseLinkerOrdersAggregate({
  rangeStart,
  rangeEndExclusive,
  bucket,
  bucketStepHours,
  seriesTemplate,
  timeoutMs = 20_000,
} = {}) {
  const rangeStartDt = rangeStart instanceof Date ? rangeStart : null;
  const rangeEndDt = rangeEndExclusive instanceof Date ? rangeEndExclusive : null;
  if (!rangeStartDt || !rangeEndDt) {
    return null;
  }
  const fromUnix = Math.floor(rangeStartDt.getTime() / 1000);
  const toUnix = Math.ceil(rangeEndDt.getTime() / 1000);
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix <= 0 || toUnix <= fromUnix) {
    return null;
  }

  // Cache key uses 5-min quantization to avoid thrashing on "now" ranges.
  const toUnixKey = Math.max(0, Math.floor(toUnix / 300) * 300);
  const cacheKey = `window:${fromUnix}:${toUnixKey}:${bucket || 'day'}:${Number(bucketStepHours) || 0}`;
  const now = Date.now();
  const cached = DASHBOARD_ORDERS_AGG_CACHE.get(cacheKey);
  if (cached?.atMs && now - cached.atMs < DASHBOARD_ORDERS_CACHE_TTL_MS) {
    return cached.data;
  }

  const statusNameById = await ensureDashboardOrderStatusNameMap({ timeoutMs: Math.min(20_000, timeoutMs) });

  const template = Array.isArray(seriesTemplate) ? seriesTemplate : [];
  const series = template.map((d) => ({
    date: d?.date,
    orders: 0,
    revenue: 0,
  }));
  const seriesIndex = new Map(series.map((d, idx) => [d.date, idx]));

  const startDay = new Date(
    Date.UTC(rangeStartDt.getUTCFullYear(), rangeStartDt.getUTCMonth(), rangeStartDt.getUTCDate(), 0, 0, 0)
  );

  const revenueByCurrency = new Map();
  let kauflandGross = 0;
  let cursor = fromUnix;
  let processed = 0;

  for (let page = 0; page < DASHBOARD_ORDERS_MAX_PAGES; page += 1) {
    const response = await callBaseLinker(
      'getOrders',
      {
        date_confirmed_from: cursor,
        get_unconfirmed_orders: false,
        include_custom_extra_fields: false,
        include_connect_data: false,
        include_commission_data: false,
      },
      { timeoutMs, retries: 2 }
    );
    const batch = Array.isArray(response?.orders) ? response.orders : [];
    if (!batch.length) break;

    let lastConfirmed = 0;
    for (const o of batch) {
      const confirmedUnix = Number(o?.date_confirmed || 0) || 0;
      if (confirmedUnix > lastConfirmed) lastConfirmed = confirmedUnix;
      if (!confirmedUnix || confirmedUnix < fromUnix) continue;
      if (confirmedUnix >= toUnix) continue;

      // Ignore synthetic "order_return" orders – returns are handled via getOrderReturns.
      const orderSource = (o?.order_source || '').toString().trim().toLowerCase();
      if (orderSource === 'order_return') continue;

      const statusId = o?.order_status_id != null ? String(o.order_status_id).trim() : null;
      const cancelled = isCancelledByStatusId(statusId, statusNameById);
      if (cancelled) continue;

      const { currency, value, confirmedAt } = computeBaseLinkerOrderValueBrutto(o);
      if (!confirmedAt) continue;
      if (confirmedAt < rangeStartDt || confirmedAt >= rangeEndDt) continue;

      const dk = computeDashboardBucketKey(confirmedAt, {
        bucket,
        bucketStepHours,
        startDay,
      });
      if (dk && seriesIndex.has(dk)) {
        const idx = seriesIndex.get(dk);
        series[idx].orders += 1;
        series[idx].revenue += value;
      }
      revenueByCurrency.set(currency, (revenueByCurrency.get(currency) || 0) + value);
      // Track Kaufland gross separately (order_source contains 'kaufland')
      if (orderSource.includes('kaufland') && currency === 'EUR') {
        kauflandGross += value;
      }
      processed += 1;
      if (processed >= DASHBOARD_ORDERS_MAX_ITEMS) break;
    }

    if (processed >= DASHBOARD_ORDERS_MAX_ITEMS) break;
    if (batch.length < 100) break; // docs: max 100 per call
    if (!lastConfirmed || lastConfirmed >= toUnix) break;
    cursor = lastConfirmed + 1;
  }

  // Kaufland: 14% Netto-Provision on Bruttoverkaufspreis + 19% MwSt on provision
  // = 14% × 1.19 = 16.66% effective deduction from brutto
  const KAUFLAND_PROVISION_RATE = 0.14;
  const KAUFLAND_EFFECTIVE_RATE = KAUFLAND_PROVISION_RATE * 1.19; // ~0.1666
  const data = {
    series: series.map((d) => ({
      date: d.date,
      orders: d.orders,
      revenue: Number((Number(d.revenue || 0) || 0).toFixed(2)),
    })),
    revenue_by_currency: Object.fromEntries(
      Array.from(revenueByCurrency.entries()).map(([k, v]) => [k, Number((Number(v || 0) || 0).toFixed(2))])
    ),
    kaufland_gross: Math.round(kauflandGross * 100) / 100,
    kaufland_payout: Math.round(kauflandGross * (1 - KAUFLAND_EFFECTIVE_RATE) * 100) / 100,
  };

  DASHBOARD_ORDERS_AGG_CACHE.set(cacheKey, { atMs: now, data });
  return data;
}

async function computeDashboardBaseLinkerRevenueTotal({
  fromUnix,
  toUnix,
  timeoutMs = 20_000,
} = {}) {
  const f = Number(fromUnix) || 0;
  const t = Number(toUnix) || 0;
  if (!Number.isFinite(f) || !Number.isFinite(t) || f <= 0 || t <= f) return null;

  // Cache key ignores "to" (we compute up to "now" and accept TTL staleness).
  const cacheKey = `total:${f}`;
  const now = Date.now();
  const cached = DASHBOARD_ORDERS_AGG_CACHE.get(cacheKey);
  if (cached?.atMs && now - cached.atMs < DASHBOARD_ORDERS_CACHE_TTL_MS) {
    return cached.data;
  }

  const statusNameById = await ensureDashboardOrderStatusNameMap({ timeoutMs: Math.min(20_000, timeoutMs) });
  const revenueByCurrency = new Map();
  let kauflandGross = 0;
  let cursor = f;
  let processed = 0;

  for (let page = 0; page < DASHBOARD_ORDERS_MAX_PAGES; page += 1) {
    const response = await callBaseLinker(
      'getOrders',
      {
        date_confirmed_from: cursor,
        get_unconfirmed_orders: false,
        include_custom_extra_fields: false,
        include_connect_data: false,
        include_commission_data: false,
      },
      { timeoutMs, retries: 2 }
    );
    const batch = Array.isArray(response?.orders) ? response.orders : [];
    if (!batch.length) break;

    let lastConfirmed = 0;
    for (const o of batch) {
      const confirmedUnix = Number(o?.date_confirmed || 0) || 0;
      if (confirmedUnix > lastConfirmed) lastConfirmed = confirmedUnix;
      if (!confirmedUnix || confirmedUnix < f) continue;
      if (confirmedUnix >= t) continue;

      const orderSource = (o?.order_source || '').toString().trim().toLowerCase();
      if (orderSource === 'order_return') continue;

      const statusId = o?.order_status_id != null ? String(o.order_status_id).trim() : null;
      const cancelled = isCancelledByStatusId(statusId, statusNameById);
      if (cancelled) continue;

      const { currency, value } = computeBaseLinkerOrderValueBrutto(o);
      revenueByCurrency.set(currency, (revenueByCurrency.get(currency) || 0) + value);
      if (orderSource.includes('kaufland') && currency === 'EUR') {
        kauflandGross += value;
      }
      processed += 1;
      if (processed >= DASHBOARD_ORDERS_MAX_ITEMS) break;
    }

    if (processed >= DASHBOARD_ORDERS_MAX_ITEMS) break;
    if (batch.length < 100) break;
    if (!lastConfirmed || lastConfirmed >= t) break;
    cursor = lastConfirmed + 1;
  }

  const KAUFLAND_PROVISION_RATE = 0.14;
  const KAUFLAND_EFFECTIVE_RATE = KAUFLAND_PROVISION_RATE * 1.19;
  const data = {
    revenue_by_currency: Object.fromEntries(
      Array.from(revenueByCurrency.entries()).map(([k, v]) => [k, Number((Number(v || 0) || 0).toFixed(2))])
    ),
    kaufland_gross: Math.round(kauflandGross * 100) / 100,
    kaufland_payout: Math.round(kauflandGross * (1 - KAUFLAND_EFFECTIVE_RATE) * 100) / 100,
  };
  DASHBOARD_ORDERS_AGG_CACHE.set(cacheKey, { atMs: now, data });
  return data;
}

// ── Routes ───────────────────────────────────────────────────────────

router.get('/orders', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Return cached orders immediately; trigger background sync best-effort
    let rawOrders = await listOrders(limit + offset);
    _backgroundSyncOrders();

    if (!Array.isArray(rawOrders)) {
      rawOrders = [];
    }

    const total = rawOrders.length;
    const paginatedOrders = rawOrders.slice(offset, offset + limit);
    const orders = await attachPickHintsToOrders(paginatedOrders);
    res.json({ ok: true, data: orders, meta: { total, limit, offset, hasMore: offset + limit < total } });
  } catch (error) {
    console.error('Failed to load orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Aufträge konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

router.get('/dashboard/metrics', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query?.days || '7', 10) || 7, 1), 60);
    const preset = typeof req.query?.preset === 'string' ? String(req.query.preset).trim() : null;
    const fromDate = typeof req.query?.from_date === 'string' ? req.query.from_date.trim() : null;
    const toDate   = typeof req.query?.to_date   === 'string' ? req.query.to_date.trim()   : null;
    // Best-effort: trigger order sync in background so metrics converge to BaseLinker truth.
    // Do NOT await (avoid slow dashboard loads).
    try {
      _backgroundSyncOrders();
    } catch {
      // ignore
    }
    const metrics = await getDashboardMetrics({ days, preset, fromDate, toDate });

    // Replace range revenue/volume with BaseLinker truth (supports long presets even if local order cache is pruned).
    try {
      const bucket = metrics?.range?.bucket || 'day';
      const bucketStepHours = metrics?.range?.bucket_step_hours || null;
      const rangeStart = metrics?.range?.from_iso ? new Date(metrics.range.from_iso) : null;
      const rangeEndExclusive = metrics?.range?.to_iso ? new Date(metrics.range.to_iso) : null;
      const template = metrics?.volume_7d?.days || [];
      if (rangeStart && rangeEndExclusive && Array.isArray(template) && template.length) {
        const agg = await computeDashboardBaseLinkerOrdersAggregate({
          rangeStart,
          rangeEndExclusive,
          bucket,
          bucketStepHours,
          seriesTemplate: template,
          timeoutMs: 20_000,
        });
        if (agg?.series && metrics?.volume_7d) {
          metrics.volume_7d.days = agg.series;
          const cur = (metrics?.currency || 'EUR').toString().trim().toUpperCase() || 'EUR';
          const windowRevenue = Number(agg?.revenue_by_currency?.[cur] || 0) || 0;
          if (metrics?.revenue) {
            metrics.revenue.window_non_cancelled_total = windowRevenue;
            // Kaufland gross + payout (14% provision + 19% MwSt on provision = 16.66% effective)
            metrics.revenue.kaufland_gross_window = agg.kaufland_gross ?? 0;
            metrics.revenue.kaufland_payout_window = agg.kaufland_payout ?? 0;
          }
        }

        // Compute "headline" total as year-to-date (YTD) revenue (gross, non-cancelled).
        const now = new Date();
        const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));
        const toUnix = Math.ceil(Date.now() / 1000);
        const total = await computeDashboardBaseLinkerRevenueTotal({
          fromUnix: Math.floor(yearStart.getTime() / 1000),
          toUnix,
          timeoutMs: 20_000,
        });
        if (total?.revenue_by_currency && metrics?.revenue) {
          const cur = (metrics?.currency || 'EUR').toString().trim().toUpperCase() || 'EUR';
          metrics.revenue.all_non_cancelled_total = Number(total.revenue_by_currency?.[cur] || 0) || 0;
          metrics.revenue.kaufland_gross_ytd = total.kaufland_gross ?? 0;
          metrics.revenue.kaufland_payout_ytd = total.kaufland_payout ?? 0;
        }
      }
    } catch (err) {
      console.warn('Dashboard BaseLinker orders enrichment failed (falling back to local cache):', err?.message || err);
    }

    // Pull returns from Firestore `returns` collection for KPIs (net revenue + returns counts).
    try {
      const { Firestore: _Firestore } = require('@google-cloud/firestore');
      const _returnsDb = new _Firestore();
      const rangeStart = metrics?.range?.from_iso ? new Date(metrics.range.from_iso) : null;
      const rangeEndExclusive = metrics?.range?.to_iso ? new Date(metrics.range.to_iso) : null;
      const now = new Date();
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));
      const monthStart = metrics?.revenue?.month_start_iso ? new Date(metrics.revenue.month_start_iso) : null;

      const returnsSnap = await _returnsDb.collection('returns')
        .where('createdAt', '>=', yearStart.toISOString())
        .select('refundAmount', 'currency', 'createdAt', 'status')
        .get();

      let ytdCount = 0, ytdValue = 0;
      let monthCount = 0;
      let windowCount = 0, windowValue = 0;

      for (const doc of returnsSnap.docs) {
        const d = doc.data();
        const amount = Number(d.refundAmount || 0) || 0;
        const created = d.createdAt ? new Date(d.createdAt) : null;
        if (!created) continue;

        ytdCount++;
        ytdValue += amount;

        if (monthStart && created >= monthStart) monthCount++;
        if (rangeStart && rangeEndExclusive && created >= rangeStart && created < rangeEndExclusive) {
          windowCount++;
          windowValue += amount;
        }
      }

      if (metrics?.orders) {
        metrics.orders.returns_total = ytdCount;
        metrics.orders.returns_month = monthCount;
      }

      if (metrics?.revenue) {
        if (typeof metrics.revenue.all_non_cancelled_total === 'number') {
          metrics.revenue.all_non_cancelled_total = Number((metrics.revenue.all_non_cancelled_total - ytdValue).toFixed(2));
        }
        if (typeof metrics.revenue.window_non_cancelled_total === 'number') {
          metrics.revenue.window_non_cancelled_total = Number((metrics.revenue.window_non_cancelled_total - windowValue).toFixed(2));
        }
      }

      metrics.returns = {
        total: { count: ytdCount, value_by_currency: { EUR: Math.round(ytdValue * 100) / 100 } },
        window: { count: windowCount, value_by_currency: { EUR: Math.round(windowValue * 100) / 100 } },
      };
    } catch (err) {
      console.warn('Dashboard returns enrichment failed:', err?.message || err);
    }

    // Enrich with eBay net revenue (after all marketplace fees) via eBay Finances API.
    // Requires sell.finances scope — silently skipped if not authorized.
    try {
      const rangeStart = metrics?.range?.from_iso ? new Date(metrics.range.from_iso) : null;
      const rangeEnd   = metrics?.range?.to_iso   ? new Date(metrics.range.to_iso)   : null;
      const now = new Date();
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));
      const pad = (n) => String(n).padStart(2, '0');
      const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

      const windowFromDate = rangeStart ? toDateStr(rangeStart) : toDateStr(yearStart);
      const windowToDate   = rangeEnd   ? toDateStr(new Date(rangeEnd.getTime() - 1)) : toDateStr(now);
      const ytdFromDate    = toDateStr(yearStart);
      const ytdToDate      = toDateStr(now);

      const [ebayWindow, ebayYtd] = await Promise.all([
        getEbayNetRevenueSummary(windowFromDate, windowToDate, { timeoutMs: 15000 }),
        getEbayNetRevenueSummary(ytdFromDate, ytdToDate, { timeoutMs: 15000 }),
      ]);

      if (metrics?.revenue) {
        if (ebayWindow !== null) {
          metrics.revenue.ebay_net_window = ebayWindow.net_revenue;
        }
        if (ebayYtd !== null) {
          metrics.revenue.ebay_net_ytd = ebayYtd.net_revenue;
          metrics.revenue.ebay_net_source = 'ebay_finances';
        }
      }
    } catch (err) {
      console.warn('Dashboard eBay net revenue enrichment failed:', err?.message || err);
    }

    // ── Compute marketplace payout-based revenue ──────────────────────────────
    // "Brutto" on Dashboard = what eBay + Kaufland actually pay out to bank account.
    // eBay: prefer Finances API (exact payout), fall back to gross × (1 - 0.25) estimate.
    // Kaufland: gross × (1 - 0.14 * 1.19) = gross × 0.8334 (14% provision + MwSt on provision).
    try {
      const rev = metrics?.revenue || {};
      const EBAY_FALLBACK_FEE_PCT = 0.25; // ~14% Transaktionsgebühren + ~11% Anzeigengebühr

      // --- Window (selected period) ---
      const ebayPayoutWindow = rev.ebay_net_window != null
        ? rev.ebay_net_window
        : (() => {
            const totalGross = rev.window_non_cancelled_total ?? 0;
            const kGross = rev.kaufland_gross_window ?? 0;
            const ebayGross = Math.max(0, totalGross - kGross);
            console.log(`[dashboard] eBay Finances API not available; estimating eBay payout from BL gross ${ebayGross.toFixed(2)} × ${(1 - EBAY_FALLBACK_FEE_PCT).toFixed(2)}`);
            return Math.round(ebayGross * (1 - EBAY_FALLBACK_FEE_PCT) * 100) / 100;
          })();
      const kauflandPayoutWindow = rev.kaufland_payout_window ?? 0;
      const payoutBruttoWindow = Math.round((ebayPayoutWindow + kauflandPayoutWindow) * 100) / 100;

      // --- YTD ---
      const ebayPayoutYtd = rev.ebay_net_ytd != null
        ? rev.ebay_net_ytd
        : (() => {
            const totalGross = rev.all_non_cancelled_total ?? 0;
            const kGross = rev.kaufland_gross_ytd ?? 0;
            const ebayGross = Math.max(0, totalGross - kGross);
            return Math.round(ebayGross * (1 - EBAY_FALLBACK_FEE_PCT) * 100) / 100;
          })();
      const kauflandPayoutYtd = rev.kaufland_payout_ytd ?? 0;
      const payoutBruttoYtd = Math.round((ebayPayoutYtd + kauflandPayoutYtd) * 100) / 100;

      metrics.revenue.payout_brutto_window = payoutBruttoWindow;
      metrics.revenue.payout_brutto_ytd = payoutBruttoYtd;
      metrics.revenue.payout_source = rev.ebay_net_window != null ? 'ebay_finances' : 'estimated';
    } catch (err) {
      console.warn('Dashboard payout computation failed:', err?.message || err);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: metrics });
  } catch (error) {
    console.error('Failed to load dashboard metrics:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Dashboard-Metriken konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

// ─── Finance Dashboard Endpoint ──────────────────────────────────────────────
// Returns SevDesk bank balances (Sichteinlagen + Business Card) and
// SendCloud shipping cost totals for the requested time range + YTD.
router.get('/dashboard/finance', requirePermission('dashboard', 'read'), async (req, res) => {
  const errors = [];

  // Resolve time range from the same preset logic as /api/dashboard/metrics
  const preset = typeof req.query?.preset === 'string' ? req.query.preset.trim() : 'last7';
  const customFromDate = typeof req.query?.from_date === 'string' ? req.query.from_date.trim() : null;
  const customToDate   = typeof req.query?.to_date   === 'string' ? req.query.to_date.trim()   : null;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  let rangeFrom;
  switch (preset) {
    case 'today': {
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      break;
    }
    case 'this_week': {
      const dow = now.getUTCDay() || 7;
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow - 1)));
      break;
    }
    case 'month_to_date': {
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    }
    case 'last_month': {
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      break;
    }
    case 'year_to_date': {
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    }
    case 'last_year': {
      rangeFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
      break;
    }
    case 'all_time': {
      rangeFrom = new Date(Date.UTC(2020, 0, 1));
      break;
    }
    case 'custom': {
      rangeFrom = customFromDate ? new Date(customFromDate + 'T00:00:00Z') : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    default: { // last7 and any unknown
      rangeFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  // Range end
  let rangeTo = now;
  if (preset === 'last_month') {
    rangeTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));
    rangeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  } else if (preset === 'last_year') {
    rangeTo = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59));
  } else if (preset === 'custom' && customToDate) {
    rangeTo = new Date(customToDate + 'T23:59:59Z');
  }

  const monthPresetMatch = /^month_(\d{4})_(\d{2})$/.exec(preset);
  if (monthPresetMatch) {
    const year = parseInt(monthPresetMatch[1], 10);
    const month = parseInt(monthPresetMatch[2], 10) - 1; // 0-indexed
    rangeFrom = new Date(Date.UTC(year, month, 1));
    rangeTo = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59)); // last day of month
  }

  const fromDateStr = toDateStr(rangeFrom);
  const toDateStr2 = toDateStr(rangeTo);
  const ytdFromStr = `${now.getUTCFullYear()}-01-01`;
  const ytdToStr = toDateStr(now);

  // Run external API calls in parallel, failing gracefully.
  // Shipping cost: SevDesk (actual paid invoices) + BaseLinker (label count only).
  // If SevDesk returns no shipping vouchers, fall back to BaseLinker CSV estimate.
  const forceRefresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
  const [balanceResult, sevdeskShippingResult, blShippingResult, sevdeskShippingYtdResult, blShippingYtdResult, scShippingResult, scShippingYtdResult] = await Promise.allSettled([
    getCheckAccountBalances({ timeoutMs: 15000 }),
    getShippingCostsFromSevDesk(fromDateStr, toDateStr2, { timeoutMs: 20000 }),
    getShippingCostsSummaryFromBaseLinker(fromDateStr, toDateStr2, { timeoutMs: 25000, forceRefresh }),
    // Only fetch YTD separately if not already YTD
    (preset !== 'year_to_date' && !(preset === 'last_year'))
      ? getShippingCostsFromSevDesk(ytdFromStr, ytdToStr, { timeoutMs: 20000 })
      : Promise.resolve(null),
    (preset !== 'year_to_date' && !(preset === 'last_year'))
      ? getShippingCostsSummaryFromBaseLinker(ytdFromStr, ytdToStr, { timeoutMs: 25000, forceRefresh })
      : Promise.resolve(null),
    // SendCloud: primary source for parcel count + carrier breakdown
    getSendCloudShippingSummary(fromDateStr, toDateStr2, { timeoutMs: 20000, forceRefresh }),
    (preset !== 'year_to_date' && !(preset === 'last_year'))
      ? getSendCloudShippingSummary(ytdFromStr, ytdToStr, { timeoutMs: 20000, forceRefresh })
      : Promise.resolve(null),
  ]);

  // Merge shipping data: SendCloud (primary for count + carrier split) + SevDesk (cost from real invoices)
  // IMPORTANT: All returned total_cost values are NETTO — the frontend multiplies by 1.19 for brutto.
  // - SendCloud API returns netto prices → use as-is
  // - SevDesk bank transactions are brutto → divide by 1.19 to get netto
  // - BaseLinker calculated costs are already brutto → divide by 1.19 to get netto
  function mergeShipping(svResult, blResult, scResult) {
    const sv = svResult?.status === 'fulfilled' ? (svResult.value || {}) : null;
    const bl = blResult?.status  === 'fulfilled' ? (blResult.value  || {}) : null;
    const sc = scResult?.status  === 'fulfilled' ? (scResult.value  || {}) : null;

    // SevDesk may have "direct" shipping costs (DHL/DPD paid without SendCloud,
    // e.g. pre-February 2026 when DHL was used directly). These are brutto bank
    // transactions and need to be included even when SendCloud is the primary source.
    const svDirectNetto = sv && sv.direct_shipping_cost > 0
      ? Math.round((sv.direct_shipping_cost / 1.19) * 100) / 100
      : 0;

    // SendCloud is preferred source for parcel count, carrier breakdown, and cost
    if (sc && sc.parcel_count > 0) {
      return {
        total_cost: Math.round((sc.total_cost + svDirectNetto) * 100) / 100,
        parcel_count: sc.parcel_count,
        dhl_count: sc.dhl_count || 0,
        dpd_count: sc.dpd_count || 0,
        direct_dhl_cost_netto: svDirectNetto,
        currency: 'EUR',
        source: svDirectNetto > 0 ? 'sendcloud+sevdesk' : 'sendcloud',
      };
    }

    // Fallback: SevDesk cost (brutto → convert to netto) + BaseLinker count
    if (!sv && !bl) return null;
    const parcelCount = bl?.parcel_count ?? 0;
    if (sv && sv.voucher_count > 0) {
      // SevDesk total_cost is brutto → convert to netto so frontend × 1.19 = correct brutto
      const svTotalNetto = Math.round((sv.total_cost / 1.19) * 100) / 100;
      return { total_cost: svTotalNetto, parcel_count: parcelCount, currency: 'EUR', source: 'sevdesk+baselinker' };
    }
    if (bl && bl.parcel_count > 0) {
      // BaseLinker calculated costs are brutto → convert to netto
      const blNetto = Math.round((bl.total_cost / 1.19) * 100) / 100;
      return { ...bl, total_cost: blNetto, source: 'baselinker' };
    }
    return null;
  }

  const shippingMerged    = mergeShipping(sevdeskShippingResult,    blShippingResult,    scShippingResult);
  const shippingYtdMerged = mergeShipping(sevdeskShippingYtdResult, blShippingYtdResult, scShippingYtdResult);

  // Shim into the existing shippingResult / shippingYtdResult shape
  const shippingResult    = { status: shippingMerged    ? 'fulfilled' : 'rejected', value: shippingMerged,    reason: new Error('Keine Versanddaten') };
  const shippingYtdResult = { status: shippingYtdMerged ? 'fulfilled' : 'rejected', value: shippingYtdMerged, reason: new Error('Keine YTD-Versanddaten') };

  let accounts = [];
  let totalBalance = 0;
  if (balanceResult.status === 'fulfilled') {
    accounts = balanceResult.value?.accounts || [];
    totalBalance = balanceResult.value?.total || 0;
  } else {
    errors.push(`SevDesk: ${balanceResult.reason?.message || 'Fehler beim Abrufen der Kontostände'}`);
  }

  let shipping = null;
  if (shippingResult.status === 'fulfilled') {
    const sc = shippingResult.value || {};
    // If BaseLinker returned no useful data (0 parcels or 0 cost), fall back to order delivery prices
    if (!sc.parcel_count && !sc.total_cost) {
      try {
        const ordersFallback = await computeOrdersDeliveryTotal(fromDateStr, toDateStr2);
        shipping = {
          ...ordersFallback,
          from_date: fromDateStr,
          to_date: toDateStr2,
          source: 'orders',
        };
      } catch (fbErr) {
        shipping = { ...sc, from_date: fromDateStr, to_date: toDateStr2 };
        errors.push(`Versandkosten-Fallback: ${fbErr?.message || 'Fehler'}`);
      }
    } else {
      shipping = { ...sc, from_date: fromDateStr, to_date: toDateStr2 };
    }
  } else {
    errors.push(`BaseLinker-Versand: ${shippingResult.reason?.message || 'Fehler beim Abrufen der Versandkosten'}`);
    // Primary source failed — fall back to order delivery prices immediately
    try {
      const ordersFallback = await computeOrdersDeliveryTotal(fromDateStr, toDateStr2);
      shipping = {
        ...ordersFallback,
        from_date: fromDateStr,
        to_date: toDateStr2,
        source: 'orders',
      };
    } catch (fbErr) {
      errors.push(`Versandkosten-Fallback: ${fbErr?.message || 'Fehler'}`);
    }
  }

  let shippingYtd = null;
  if (shippingYtdResult.status === 'fulfilled' && shippingYtdResult.value !== null) {
    const scYtd = shippingYtdResult.value || {};
    if (!scYtd.parcel_count && !scYtd.total_cost) {
      try {
        const ordersFallback = await computeOrdersDeliveryTotal(ytdFromStr, ytdToStr);
        shippingYtd = { ...ordersFallback, from_date: ytdFromStr, to_date: ytdToStr, source: 'orders' };
      } catch {
        shippingYtd = { ...scYtd, from_date: ytdFromStr, to_date: ytdToStr };
      }
    } else {
      shippingYtd = { ...scYtd, from_date: ytdFromStr, to_date: ytdToStr };
    }
  } else if (shippingResult.status === 'fulfilled' && (preset === 'year_to_date' || preset === 'last_year')) {
    // When preset IS year/last_year, the main shipping fetch already covers YTD
    shippingYtd = shipping;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    data: {
      generated_at_iso: now.toISOString(),
      accounts,
      total_balance: totalBalance,
      shipping,
      shipping_ytd: shippingYtd,
      errors,
    },
  });
});

router.post('/orders/sync', requirePermission('orders', 'read'), async (req, res) => {
  try {
    // Kick off background sync, but respond immediately with cached orders
    _backgroundSyncOrders();
    const rawOrders = await listOrders(Math.min(Number(req.query?.limit) || 200, 100));

    const orders = await attachPickHintsToOrders(rawOrders || []);
    res.json({ ok: true, data: orders });
  } catch (error) {
    console.error('Failed to sync orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragssync fehlgeschlagen.',
        details: error.message,
      },
    });
  }
});

router.post('/orders/:orderId/complete', requirePermission('orders', 'pick'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { pickOrder } = require('../services/order-source-router');
    await pickOrder({
      orderId,
      actor: req.user ? { uid: req.user.uid, email: req.user.email } : undefined,
    });

    // Event-driven sync
    emitSyncEvent('order:status_changed', {
      entityId: orderId, tenantId: req.user?.tenantId || 'default',
      toStatus: 'picked', source: 'api:complete',
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to complete order:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragsstatus konnte nicht aktualisiert werden.',
        details: error.message,
      },
    });
  }
});

router.post('/orders/:orderId/pack', requirePermission('orders', 'pack'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { packOrder } = require('../services/order-source-router');
    await packOrder({
      orderId,
      actor: req.user ? { uid: req.user.uid, email: req.user.email } : undefined,
    });

    // Event-driven sync: triggers stock sync to all channels
    const tenantId = req.user?.tenantId || 'default';
    emitSyncEvent('order:status_changed', {
      entityId: orderId, tenantId, toStatus: 'packed', source: 'api:pack',
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to mark order as packed:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragsstatus konnte nicht aktualisiert werden.',
        details: error.message,
      },
    });
  }
});

// ── Order Settings (CRUD for automation rules, statuses, number ranges) ──

const { firestore } = require('../lib/firestore');

function getOrderSettingsTenantId(req) {
  return req.user?.tenantId || 'default';
}

router.get('/orders/settings', async (req, res) => {
  try {
    const tenantId = getOrderSettingsTenantId(req);
    const doc = await firestore.collection('order_settings').doc(tenantId).get();
    const data = doc.exists ? doc.data() : {};
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[GET /api/orders/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.put('/orders/settings', async (req, res) => {
  try {
    const tenantId = getOrderSettingsTenantId(req);
    const { rules, statuses, numberRanges, templates, carrierRules } = req.body;
    const data = { tenantId, updatedAt: new Date().toISOString(), updatedBy: req.user?.uid || null };
    if (rules !== undefined) data.rules = rules;
    if (statuses !== undefined) data.statuses = statuses;
    if (numberRanges !== undefined) data.numberRanges = numberRanges;
    if (templates !== undefined) data.templates = templates;
    if (carrierRules !== undefined) {
      // Validate carrier rules structure
      if (!Array.isArray(carrierRules)) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'carrierRules muss ein Array sein' } });
      }
      for (const rule of carrierRules) {
        if (!rule.maxWeight || !rule.shippingMethodId || !rule.carrier) {
          return res.status(400).json({
            ok: false,
            error: { code: 'INVALID_INPUT', message: 'Jede Versandregel braucht: maxWeight, shippingMethodId, carrier' },
          });
        }
      }
      data.carrierRules = carrierRules.map((rule) => ({
        ...rule,
        minWeight: Number(rule.minWeight) || 0,
        maxWeight: Number(rule.maxWeight) || 0,
        shippingMethodId: Number(rule.shippingMethodId) || 0,
      }));
    }

    await firestore.collection('order_settings').doc(tenantId).set(data, { merge: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[PUT /api/orders/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── Shipments (read from BaseLinker orders with tracking) ──

router.get('/shipments', async (req, res) => {
  try {
    const tenantId = getOrderSettingsTenantId(req);
    // Try Firestore shipments collection first
    let query = firestore.collection('shipments').where('tenantId', '==', tenantId);
    if (req.query.status) {
      query = query.where('status', '==', req.query.status);
    }
    query = query.orderBy('createdAt', 'desc').limit(parseInt(req.query.limit || '100', 10));
    const snap = await query.get();
    const shipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: shipments });
  } catch (err) {
    console.error(`[GET /api/shipments] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.post('/shipments', async (req, res) => {
  try {
    const tenantId = getOrderSettingsTenantId(req);
    const { orderId, customer, carrier, trackingNumber, cost } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderId required' } });
    const data = {
      tenantId,
      orderId,
      customer: customer || null,
      carrier: carrier || 'DHL',
      trackingNumber: trackingNumber || null,
      cost: cost || 0,
      status: 'ausstehend',
      shippedAt: null,
      deliveredAt: null,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || null,
    };
    const ref = await firestore.collection('shipments').add(data);
    res.json({ ok: true, data: { id: ref.id, ...data } });
  } catch (err) {
    console.error(`[POST /api/shipments] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── Stock Sync Status (aggregates sync health from stock_sync_log + stock_reservations) ──

router.get('/sync/status', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Fetch recent sync logs (last 24h, max 500)
    const [logsSnap, reservationsSnap] = await Promise.all([
      firestore.collection('stock_sync_log')
        .where('tenantId', '==', tenantId)
        .where('createdAt', '>=', since24h)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get(),
      firestore.collection('stock_reservations')
        .where('tenantId', '==', tenantId)
        .where('status', '==', 'reserved')
        .limit(500)
        .get(),
    ]);

    // Aggregate per-channel stats from logs
    const channels = {};
    for (const doc of logsSnap.docs) {
      const d = doc.data();
      const results = d.results || [];
      for (const r of results) {
        const ch = r.channel;
        if (!ch || ch === 'all') continue;
        if (!channels[ch]) {
          channels[ch] = { lastSync: null, successCount: 0, errorCount: 0, totalCount: 0 };
        }
        channels[ch].totalCount++;
        if (r.status === 'success') channels[ch].successCount++;
        else if (r.status === 'error' || r.status === 'failed') channels[ch].errorCount++;
        // Track latest sync time
        if (!channels[ch].lastSync || (d.createdAt && d.createdAt > channels[ch].lastSync)) {
          channels[ch].lastSync = d.createdAt;
        }
      }
    }

    // Count active reservations
    const reservedCount = reservationsSnap.docs.length;
    let reservedQuantity = 0;
    for (const doc of reservationsSnap.docs) {
      reservedQuantity += Number(doc.data().quantity) || 0;
    }

    const totalErrors = Object.values(channels).reduce((s, c) => s + c.errorCount, 0);
    const totalSyncs = Object.values(channels).reduce((s, c) => s + c.totalCount, 0);

    res.json({
      ok: true,
      data: {
        channels,
        reservations: { count: reservedCount, totalQuantity: reservedQuantity },
        summary: { totalSyncs, totalErrors, since: since24h },
        generatedAt: now.toISOString(),
      },
    });
  } catch (err) {
    console.error(`[GET /api/sync/status] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── OMS Native Endpoints ─────────────────────────────────────

const {
  transitionOrder,
  getOrderTimeline,
  getStatusCounts,
  getAllStatuses,
  getNextStatuses,
  mapLegacyStatus,
} = require('../services/order-state-machine');
const { syncEbayOrders } = require('../services/order-intake-ebay');
const { syncKauflandOrders } = require('../services/order-intake-kaufland');
const { getSequenceStates } = require('../services/number-sequence');
const { getOrderById } = require('../lib/firestore');

/**
 * GET /api/orders/statuses
 * Returns all OMS status definitions and their metadata.
 */
router.get('/orders/statuses', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const statuses = getAllStatuses();
    const counts = await getStatusCounts().catch(() => ({}));
    res.json({ ok: true, data: { statuses, counts } });
  } catch (err) {
    console.error(`[GET /api/orders/statuses] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/orders/:orderId/detail
 * Returns detailed order data including timeline.
 */
router.get('/orders/:orderId/detail', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Auftrag nicht gefunden' } });
    }

    // Map legacy status
    order.omsStatus = order.omsStatus || mapLegacyStatus(order.status);

    // Get timeline
    const timeline = await getOrderTimeline({ orderId }).catch(() => []);

    // Get next possible statuses + all statuses for manual override
    const nextStatuses = getNextStatuses(order.omsStatus);
    const allStatuses = getAllStatuses();

    res.json({
      ok: true,
      data: {
        order,
        timeline,
        nextStatuses,
        allStatuses,
      },
    });
  } catch (err) {
    console.error(`[GET /api/orders/${req.params.orderId}/detail] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/transition
 * Transition an order to a new OMS status.
 */
router.post('/orders/:orderId/transition', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { toStatus, note, force } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    if (!toStatus) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'toStatus ist erforderlich' } });
    }

    const result = await transitionOrder({
      tenantId,
      orderId,
      toStatus,
      actor: req.user ? { uid: req.user.uid, email: req.user.email } : null,
      note,
      force: !!force,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: { code: 'TRANSITION_DENIED', message: result.error } });
    }

    // Event-driven sync: handles stock release, marketplace push, and cross-system sync
    emitSyncEvent('order:status_changed', {
      entityId: orderId, tenantId, toStatus, fromStatus: result.fromStatus, source: 'api:transition',
    });

    // Direct marketplace push for cancel/ship (time-critical, don't wait for debounced sync)
    if (toStatus === 'cancelled') {
      const { pushCancellationToMarketplace } = require('../services/marketplace-tracking');
      pushCancellationToMarketplace({ orderId, reason: note || 'other' })
        .catch((err) => console.warn(`[transition] cancel marketplace push failed: ${err.message}`));
    }
    let marketplacePush = null;
    if (toStatus === 'shipped') {
      const orderDoc = await require('../lib/firestore').firestore.collection('orders').doc(orderId).get();
      const orderData = orderDoc.exists ? orderDoc.data() : {};
      const trackingNumber = orderData.trackingNumber || orderData.tracking?.trackingNumber;
      const carrier = orderData.carrier || orderData.shippingService || orderData.tracking?.carrier || 'other';
      if (trackingNumber) {
        try {
          const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
          marketplacePush = await pushTrackingToMarketplace({ orderId, trackingNumber, carrier });
          if (!marketplacePush.ok && !marketplacePush.skipped) {
            console.warn(`[transition] shipped tracking push failed for ${orderId}: ${marketplacePush.error}`);
          }
        } catch (err) {
          console.warn(`[transition] shipped tracking push error for ${orderId}: ${err.message}`);
          marketplacePush = { ok: false, error: err.message };
        }
      }
    }

    res.json({ ok: true, data: { ...result, marketplacePush } });
  } catch (err) {
    console.error(`[POST /api/orders/${req.params.orderId}/transition] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/orders/:orderId/timeline
 * Returns the event history for an order.
 */
router.get('/orders/:orderId/timeline', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const timeline = await getOrderTimeline({ orderId, limit });
    res.json({ ok: true, data: timeline });
  } catch (err) {
    console.error(`[GET /api/orders/${req.params.orderId}/timeline] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/sync/marketplace
 * Sync orders from eBay and/or Kaufland directly (not via BaseLinker).
 */
router.post('/orders/sync/marketplace', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { marketplace, lookbackDays = 7 } = req.body;
    const tenantId = req.user?.tenantId || 'default';
    const results = {};

    if (!marketplace || marketplace === 'ebay' || marketplace === 'all') {
      results.ebay = await syncEbayOrders({ tenantId, lookbackDays }).catch((err) => ({
        synced: 0, skipped: 0, total: 0, error: err.message,
      }));
    }

    if (!marketplace || marketplace === 'kaufland' || marketplace === 'all') {
      results.kaufland = await syncKauflandOrders({ tenantId, lookbackDays }).catch((err) => ({
        synced: 0, skipped: 0, total: 0, error: err.message,
      }));
    }

    const totalSynced = Object.values(results).reduce((s, r) => s + (r.synced || 0), 0);
    res.json({ ok: true, data: { results, totalSynced } });
  } catch (err) {
    console.error(`[POST /api/orders/sync/marketplace] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/orders/sequences
 * Returns current number sequence states for all types.
 */
router.get('/orders/sequences', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const states = await getSequenceStates({ tenantId });
    res.json({ ok: true, data: states });
  } catch (err) {
    console.error(`[GET /api/orders/sequences] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── OMS-B: Shipping & Invoices ──────────────────────────────────────

/**
 * GET /api/shipping-methods — List available SendCloud shipping methods.
 * Used by admin UI to configure carrier rules with correct method IDs.
 */
router.get('/shipping-methods', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { getShippingMethods } = require('../services/shipping-engine');
    const methods = await getShippingMethods();
    res.json({ ok: true, data: methods });
  } catch (err) {
    console.error(`[GET /api/shipping-methods] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/ship — Create shipping label via SendCloud.
 */
router.post('/orders/:orderId/ship', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { shippingMethodId, weight } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    const { shipOrder } = require('../services/shipping-engine');
    const result = await shipOrder({ orderId, tenantId, shippingMethodId, weight });

    // Only transition to shipped if we have confirmed tracking
    if (result.trackingNumber) {
      const { transitionOrder } = require('../services/order-state-machine');
      await transitionOrder({
        tenantId,
        orderId,
        toStatus: 'shipped',
        actor: { uid: req.user?.uid || 'system', email: req.user?.email || 'api' },
        note: `Versandlabel erstellt (${result.carrier || 'unknown'})`,
        timestamps: { shippedAt: new Date().toISOString() },
      });
    } else {
      console.warn(`[ship] Label created for ${orderId} but no tracking number — staying in current status`);
    }

    // Push tracking to marketplace immediately (time-critical)
    // await the result so we can include push status in response
    let marketplacePush = null;
    if (result.trackingNumber) {
      try {
        const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
        marketplacePush = await pushTrackingToMarketplace({
          orderId,
          trackingNumber: result.trackingNumber,
          carrier: result.carrier || '',
        });
        if (!marketplacePush.ok && !marketplacePush.skipped) {
          console.warn(`[ship] Marketplace push failed for ${orderId}: ${marketplacePush.error}`);
        }
      } catch (err) {
        console.error(`[ship] Marketplace push error for ${orderId}: ${err.message}`);
        marketplacePush = { ok: false, error: err.message };
      }
    }

    // Event-driven sync: stock sync + marketplace sync + SendCloud sync
    // The event bus will also retry the marketplace push if it failed above
    emitSyncEvent('order:status_changed', {
      entityId: orderId, tenantId, toStatus: 'shipped', source: 'api:ship',
    });
    emitSyncEvent('shipment:created', {
      entityId: orderId, tenantId, source: 'api:ship',
    });

    res.json({ ok: true, data: { ...result, marketplacePush } });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/ship] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/cancel-label — Cancel shipping label and clear tracking.
 */
router.post('/orders/:orderId/cancel-label', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    // Find active shipment for this order
    const snap = await firestore.collection('shipments')
      .where('orderId', '==', orderId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Kein Versandlabel für diesen Auftrag gefunden.' } });
    }

    const shipment = snap.docs[0].data();
    const parcelId = shipment.sendcloudParcelId;

    if (!parcelId) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Keine SendCloud Parcel-ID vorhanden.' } });
    }

    // Cancel parcel in SendCloud (non-blocking — may already be cancelled externally)
    const { cancelParcel } = require('../services/shipping-engine');
    try {
      await cancelParcel({ parcelId, tenantId });
    } catch (cancelErr) {
      console.warn(`[cancel-label] SendCloud cancel failed (may already be cancelled): ${cancelErr.message}`);
    }

    // Update shipment doc status
    await firestore.collection('shipments').doc(snap.docs[0].id).set({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Clear tracking data from order
    await firestore.collection('orders').doc(orderId).set({
      trackingNumber: null,
      trackingUrl: null,
      shippingService: null,
      shipmentId: null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Transition order back to packed
    const { transitionOrder } = require('../services/order-state-machine');
    await transitionOrder({
      tenantId,
      orderId,
      toStatus: 'packed',
      actor: { uid: req.user?.uid || 'system', email: req.user?.email || 'api' },
      note: 'Versandlabel storniert — Tracking entfernt',
      force: true,
    });

    // Event-driven sync: shipment cancelled → resync stock + shipments
    emitSyncEvent('order:status_changed', {
      entityId: orderId, tenantId, toStatus: 'packed', source: 'api:cancel-label',
    });
    emitSyncEvent('shipment:updated', {
      entityId: orderId, tenantId, source: 'api:cancel-label',
    });

    res.json({ ok: true, data: { message: 'Label storniert, Tracking entfernt.' } });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/cancel-label] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/invoice — Generate invoice PDF.
 */
router.post('/orders/:orderId/invoice', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    const { generateInvoice } = require('../services/invoice-engine');
    const result = await generateInvoice({
      orderId,
      tenantId,
      actor: { uid: req.user?.uid || '', email: req.user?.email || '' },
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/invoice] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/delivery-note — Generate delivery note PDF.
 */
router.post('/orders/:orderId/delivery-note', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    const { generateDeliveryNote } = require('../services/invoice-engine');
    const result = await generateDeliveryNote({ orderId, tenantId });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/delivery-note] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/shipping/methods — List available SendCloud shipping methods.
 */
router.get('/shipping/methods', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { getShippingMethods } = require('../services/shipping-engine');
    const methods = await getShippingMethods();
    res.json({ ok: true, data: methods });
  } catch (err) {
    console.error(`[GET /api/shipping/methods] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/invoices/:invoiceId/export-sevdesk — Export invoice to SevDesk.
 */
router.post('/invoices/:invoiceId/export-sevdesk', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { exportToSevDesk } = require('../services/invoice-engine');
    const result = await exportToSevDesk({ invoiceId });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: { code: 'SEVDESK_EXPORT_FAILED', message: result.error } });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/invoices/:invoiceId/export-sevdesk] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/sync-sendcloud — Sync SendCloud parcels into AvyCloud orders.
 * Body: { fromDate?: string, toDate?: string }
 */
router.post('/orders/sync-sendcloud', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    const { syncSendCloudParcels } = require('../services/shipping-engine');
    const result = await syncSendCloudParcels({ tenantId, fromDate, toDate });

    res.json({
      ok: true,
      data: {
        matched: result.matched.length,
        unmatched: result.unmatched.length,
        skipped: result.skipped,
        details: {
          matched: result.matched,
          unmatched: result.unmatched,
        },
      },
    });
  } catch (err) {
    console.error(`[POST /api/orders/sync-sendcloud] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/bulk-ship — Create labels for multiple packed orders at once.
 * Body: { orderIds: string[], shippingMethodId?: number }
 */
router.post('/orders/bulk-ship', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderIds, shippingMethodId } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderIds array required' } });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Max 50 orders per bulk ship' } });
    }

    const tenantId = req.user?.tenantId || 'default';
    const actor = { uid: req.user?.uid || 'system', email: req.user?.email || 'api' };
    const { shipOrder } = require('../services/shipping-engine');
    const { transitionOrder } = require('../services/order-state-machine');
    const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');

    const results = [];
    for (const orderId of orderIds) {
      try {
        const result = await shipOrder({ orderId, tenantId, shippingMethodId });

        // Auto-transition to shipped
        await transitionOrder({
          tenantId, orderId, toStatus: 'shipped', actor,
          note: `Bulk-Versand (${result.carrier || 'unknown'})`,
        });

        // Push tracking async
        if (result.trackingNumber) {
          pushTrackingToMarketplace({
            orderId, trackingNumber: result.trackingNumber, carrier: result.carrier || '',
          }).catch((err) => console.error(`[bulk-ship] Marketplace push failed for ${orderId}: ${err.message}`));
        }

        results.push({ orderId, ok: true, trackingNumber: result.trackingNumber, labelUrl: result.labelUrl });
      } catch (err) {
        console.error(`[bulk-ship] Order ${orderId} failed: ${err.message}`);
        results.push({ orderId, ok: false, error: err.message });
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    res.json({ ok: true, data: { total: orderIds.length, success: successCount, results } });
  } catch (err) {
    console.error(`[POST /api/orders/bulk-ship] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/bulk-transition — Change status for multiple orders at once.
 * Body: { orderIds: string[], toStatus: string, note?: string, force?: boolean }
 */
router.post('/orders/bulk-transition', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderIds, toStatus, note, force } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderIds array required' } });
    }
    if (!toStatus || typeof toStatus !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'toStatus required' } });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Max 50 orders per bulk transition' } });
    }

    const tenantId = req.user?.tenantId || 'default';
    const actor = { uid: req.user?.uid || 'system', email: req.user?.email || 'api' };
    const { transitionOrder } = require('../services/order-state-machine');

    const results = [];
    const successfulOrderIds = [];
    for (const orderId of orderIds) {
      try {
        const result = await transitionOrder({
          tenantId, orderId, toStatus, actor,
          note: note || `Bulk-Statuswechsel → ${toStatus}`,
          force: !!force,
        });
        results.push({ orderId, ok: true, fromStatus: result.fromStatus, toStatus: result.toStatus });
        if (result.ok) successfulOrderIds.push(orderId);
      } catch (err) {
        console.error(`[bulk-transition] Order ${orderId} failed: ${err.message}`);
        results.push({ orderId, ok: false, error: err.message });
      }
    }

    // Post-transition side effects for successfully transitioned orders
    if (successfulOrderIds.length > 0 && toStatus === 'cancelled') {
      const { releaseReservation } = require('../services/stock-reservation');
      const { syncStockForOrderItems } = require('../services/stock-sync-dispatcher');
      const { pushCancellationToMarketplace } = require('../services/marketplace-tracking');
      for (const oid of successfulOrderIds) {
        releaseReservation({ tenantId, orderId: oid })
          .then(() => syncStockForOrderItems({ tenantId, orderId: oid, reason: 'bulk-cancel' }))
          .catch((err) => console.warn(`[bulk-transition] cancel release failed for ${oid}: ${err.message}`));
        pushCancellationToMarketplace({ orderId: oid, reason: note || 'other' })
          .catch((err) => console.warn(`[bulk-transition] cancel push failed for ${oid}: ${err.message}`));
      }
    }
    if (successfulOrderIds.length > 0 && toStatus === 'shipped') {
      const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
      const { firestore: fs } = require('../lib/firestore');
      for (const oid of successfulOrderIds) {
        fs.collection('orders').doc(oid).get().then((doc) => {
          if (!doc.exists) return;
          const od = doc.data();
          const tn = od.trackingNumber || od.tracking?.trackingNumber;
          const cr = od.carrier || od.tracking?.carrier || 'other';
          if (tn) {
            pushTrackingToMarketplace({ orderId: oid, trackingNumber: tn, carrier: cr })
              .catch((err) => console.warn(`[bulk-transition] tracking push failed for ${oid}: ${err.message}`));
          }
        }).catch(() => {});
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    res.json({ ok: true, data: { total: orderIds.length, success: successCount, results } });
  } catch (err) {
    console.error(`[POST /api/orders/bulk-transition] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// --- Order Update (address editing) ---
const { updateOrder } = require('../lib/firestore');
const { logAudit } = require('../services/audit-log');

const ALLOWED_CUSTOMER_FIELDS = ['name', 'street', 'city', 'zip', 'country', 'phone', 'email'];

router.put('/orders/:orderId', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { customer, weight } = req.body;

    const updates = {};
    const auditFields = [];

    // --- Customer fields ---
    if (customer && typeof customer === 'object') {
      const sanitized = {};
      for (const key of ALLOWED_CUSTOMER_FIELDS) {
        if (customer[key] !== undefined) {
          sanitized[key] = customer[key] === '' ? null : customer[key];
        }
      }
      for (const [key, value] of Object.entries(sanitized)) {
        updates[`customer.${key}`] = value;
      }
      auditFields.push(...Object.keys(sanitized).map((k) => `customer.${k}`));
    }

    // --- Weight (top-level, in kg) ---
    if (weight !== undefined) {
      const w = parseFloat(weight);
      if (isNaN(w) || w < 0) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'weight muss eine positive Zahl in kg sein' } });
      }
      updates.weight = w;
      auditFields.push('weight');
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Keine gültigen Felder zum Aktualisieren' } });
    }

    await updateOrder(orderId, updates);

    logAudit({
      action: 'order.updated',
      userId: req.user?.uid,
      userEmail: req.user?.email,
      tenantId: req.user?.tenantId || 'default',
      resourceType: 'order',
      resourceId: orderId,
      details: { updatedFields: auditFields },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(`[PUT /api/orders/${req.params.orderId}] ${error.message}`, error);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

/**
 * GET /api/orders/:orderId/label — Proxy SendCloud label PDF with auth.
 * Returns the PDF directly so the browser can display/print it.
 */
router.get('/orders/:orderId/label', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderId } = req.params;

    // Find shipment for this order
    const snap = await firestore.collection('shipments')
      .where('orderId', '==', orderId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Kein Versandlabel für diesen Auftrag gefunden.' } });
    }

    const shipment = snap.docs[0].data();
    const labelUrl = shipment.labelUrl;
    if (!labelUrl) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Label-URL nicht verfügbar.' } });
    }

    const { downloadLabelPdf } = require('../services/shipping-engine');
    const { buffer, contentType } = await downloadLabelPdf(labelUrl);

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `inline; filename="label-${orderId}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error(`[GET /api/orders/:orderId/label] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = { router, setBackgroundSyncOrders };
