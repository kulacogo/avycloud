const router = require('express').Router();
const { requirePermission } = require('../lib/rbac');
const { listOrders, getDashboardMetrics, computeOrdersDeliveryTotal, firestore } = require('../lib/firestore');
const { getOperationalMetrics } = require('../lib/dashboard-ops');
const { markOrderAsPicked, markOrderAsPacked } = require('../services/order-sync');
const { attachPickHintsToOrders } = require('../services/pick-hints');
const { getCheckAccountBalances, getShippingCostsFromSevDesk } = require('../lib/sevdesk');
const { getShippingCostsSummary: getSendCloudShippingSummary, lookupCsvPrice } = require('../lib/sendcloud');
const { getEbayNetRevenueSummary } = require('../lib/ebay-finances');
const { emitSyncEvent } = require('../services/sync-event-bus');
const { buildAddressLabelsHtml } = require('../services/label-printer');
const crypto = require('crypto');

// ── Factory: backgroundSyncOrders wird von index.js injiziert ────────

let _backgroundSyncOrders = () => {};

function setBackgroundSyncOrders(fn) {
  _backgroundSyncOrders = fn;
}


// ── Marketplace resolution ────────────────────────────────────────────

const KNOWN_MARKETPLACES = new Set(['ebay', 'kaufland', 'amazon', 'otto', 'shopify']);

/**
 * Determine the real marketplace for an order.
 * If the stored source/marketplace is not a known value, attempts to derive
 * it from the embedded raw.order_source string and external order ID formats.
 * Returns the canonical marketplace key (ebay / kaufland / ...) or null.
 */
function resolveOrderMarketplace(order) {
  const stored = String(order.marketplace || order.source || '').toLowerCase();

  if (KNOWN_MARKETPLACES.has(stored)) return stored;

  // Stored value is not a recognized marketplace — try to detect from embedded raw data
  const raw = order.raw || {};
  const rawSrc = String(raw.order_source || '').toLowerCase();

  if (rawSrc.includes('ebay')) return 'ebay';
  if (rawSrc.includes('kaufland') || rawSrc.includes('real.de') || rawSrc.includes('real')) return 'kaufland';
  if (rawSrc.includes('amazon')) return 'amazon';
  if (rawSrc.includes('otto')) return 'otto';

  // Last resort: eBay order IDs follow the pattern "12-12345-12345"
  const extId = String(order.marketplaceOrderId || order.externalOrderId || order.orderSourceId || '');
  if (/^\d{2}-\d{5,}-\d{5,}$/.test(extId)) return 'ebay';

  return null; // Cannot determine
}

/**
 * Strip internal fields and resolve marketplace before sending to frontend.
 * Self-heals Firestore: when we successfully derive the marketplace from raw
 * data and it differs from what's stored, we fire a background update so the
 * fix is permanent and the next read won't need the fallback logic.
 */
function normalizeOrderForResponse(order) {
  const resolvedMarketplace = resolveOrderMarketplace(order);
  const { raw: _raw, ...rest } = order; // eslint-disable-line no-unused-vars

  // Self-heal: persist the corrected marketplace back to Firestore (fire-and-forget).
  if (resolvedMarketplace && resolvedMarketplace !== order.marketplace) {
    const orderId = order.id || order.orderId;
    if (orderId) {
      firestore
        .collection('orders')
        .doc(orderId)
        .update({ marketplace: resolvedMarketplace, source: resolvedMarketplace })
        .catch(() => {}); // Non-critical — never block the response
    }
  }

  return {
    ...rest,
    ...(resolvedMarketplace ? { marketplace: resolvedMarketplace, source: resolvedMarketplace } : {}),
  };
}

// ── Routes ───────────────────────────────────────────────────────────

router.get('/orders', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Scope to the caller's tenant — otherwise this leaks every tenant's orders
    // (incl. customer PII). Legacy docs missing tenantId resolve to 'default'.
    const tenantId = req.user?.tenantId || 'default';
    // Return cached orders immediately; trigger background sync best-effort
    let rawOrders = await listOrders(limit + offset, { tenantId });
    _backgroundSyncOrders();

    if (!Array.isArray(rawOrders)) {
      rawOrders = [];
    }

    const total = rawOrders.length;
    const paginatedOrders = rawOrders.slice(offset, offset + limit);
    const orders = await attachPickHintsToOrders(paginatedOrders);
    const normalized = orders.map(normalizeOrderForResponse);
    const body = { ok: true, data: normalized, meta: { total, limit, offset, hasMore: offset + limit < total } };
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('ETag', etag);
    res.json(body);
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

// Authoritative OMS status counts over the FULL tenant order set. The Orders
// page uses this for its status bar so the counts are reliable instead of being
// tallied from the (capped) page of orders loaded in the browser.
router.get('/orders/status-counts', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const ops = await getOperationalMetrics({ preset: 'all_time', tenantId });
    const body = { ok: true, data: { statusCounts: ops.statusCounts, live: ops.live } };
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.setHeader('ETag', etag);
    res.json(body);
  } catch (error) {
    console.error(`[GET /api/orders/status-counts] ${error.message}`, error);
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: 'Status-Zähler konnten nicht geladen werden.', details: error.message },
    });
  }
});

router.get('/dashboard/metrics', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query?.days || '7', 10) || 7, 1), 60);
    const preset = typeof req.query?.preset === 'string' ? String(req.query.preset).trim() : null;
    const fromDate = typeof req.query?.from_date === 'string' ? req.query.from_date.trim() : null;
    const toDate   = typeof req.query?.to_date   === 'string' ? req.query.to_date.trim()   : null;
    // Best-effort: trigger order sync in background so metrics stay current.
    // Do NOT await (avoid slow dashboard loads).
    try {
      _backgroundSyncOrders();
    } catch {
      // ignore
    }
    const metrics = await getDashboardMetrics({ days, preset, fromDate, toDate, tenantId: req.user?.tenantId || 'default' });

    // Pull returns from Firestore `returns` collection for KPIs (net revenue + returns counts).
    // Single source of truth — order-status-based return counting in getDashboardMetrics() is ignored.
    try {
      const rangeStart = metrics?.range?.from_iso ? new Date(metrics.range.from_iso) : null;
      const rangeEndExclusive = metrics?.range?.to_iso ? new Date(metrics.range.to_iso) : null;
      const now = new Date();
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));

      const returnsSnap = await firestore.collection('returns')
        .select('refundAmount', 'currency', 'createdAt', 'status')
        .get();

      let totalCount = 0, totalValue = 0;
      let ytdCount = 0, ytdValue = 0;
      let windowCount = 0, windowValue = 0;

      for (const doc of returnsSnap.docs) {
        const d = doc.data();
        const amount = Number(d.refundAmount || 0) || 0;
        const created = d.createdAt ? new Date(d.createdAt) : null;

        totalCount++;
        totalValue += amount;

        if (created && created >= yearStart) {
          ytdCount++;
          ytdValue += amount;
        }
        if (created && rangeStart && rangeEndExclusive && created >= rangeStart && created < rangeEndExclusive) {
          windowCount++;
          windowValue += amount;
        }
      }

      if (metrics?.orders) {
        metrics.orders.returns_total = totalCount;
        metrics.orders.returns_ytd = ytdCount;
      }

      // Deduct returns from revenue — YTD value from YTD revenue, window value from window revenue
      if (metrics?.revenue) {
        if (typeof metrics.revenue.all_non_cancelled_total === 'number') {
          metrics.revenue.all_non_cancelled_total = Number((metrics.revenue.all_non_cancelled_total - ytdValue).toFixed(2));
        }
        if (typeof metrics.revenue.window_non_cancelled_total === 'number') {
          metrics.revenue.window_non_cancelled_total = Number((metrics.revenue.window_non_cancelled_total - windowValue).toFixed(2));
        }
      }

      metrics.returns = {
        total: { count: totalCount, value_by_currency: { EUR: Math.round(totalValue * 100) / 100 } },
        ytd: { count: ytdCount, value_by_currency: { EUR: Math.round(ytdValue * 100) / 100 } },
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

    const metricsBody = { ok: true, data: metrics };
    const metricsEtag = '"' + crypto.createHash('md5').update(JSON.stringify(metricsBody)).digest('hex') + '"';
    if (req.headers['if-none-match'] === metricsEtag) {
      return res.status(304).end();
    }
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.setHeader('ETag', metricsEtag);
    res.json(metricsBody);
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

// ─── Operational Dashboard Endpoint ──────────────────────────────────────────
// COUNTS, not euros. Server-side aggregation over the FULL tenant order set so
// the numbers are trustworthy (no client-side tally of a loaded page):
//  - live:   current operational backlog (waiting/in-progress/shipped today)
//  - window: per-marketplace order/unit/storno/return counts for the time range
//  - carriers: shipping labels per carrier (DHL/DPD/DP) for the time range
//  - statusCounts: authoritative full-collection OMS status breakdown
router.get('/dashboard/ops', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const preset = typeof req.query?.preset === 'string' ? req.query.preset.trim() : null;
    const fromDate = typeof req.query?.from_date === 'string' ? req.query.from_date.trim() : null;
    const toDate = typeof req.query?.to_date === 'string' ? req.query.to_date.trim() : null;
    const tenantId = req.user?.tenantId || 'default';

    // Keep dashboard fresh without blocking on the sync.
    try { _backgroundSyncOrders(); } catch { /* ignore */ }

    const ops = await getOperationalMetrics({ preset, fromDate, toDate, tenantId });

    // Carrier label counts (DHL/DPD/DP) from SendCloud — the authoritative label
    // system. Best-effort: a SendCloud outage must not break the counts above.
    let carriers = null;
    try {
      const pad = (n) => String(n).padStart(2, '0');
      const toDateStr = (iso) => {
        const d = new Date(iso);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      };
      const fromStr = toDateStr(ops.range.from_iso);
      // to_iso is exclusive; SendCloud treats the range end as inclusive, so step back one day.
      const toStr = toDateStr(new Date(new Date(ops.range.to_iso).getTime() - 1));
      const sc = await getSendCloudShippingSummary(fromStr, toStr, { timeoutMs: 20000 });
      if (sc) {
        carriers = {
          dhl: sc.dhl_count || 0,
          dpd: sc.dpd_count || 0,
          dp: sc.dp_count || 0,
          other: sc.other_count || 0,
          total: sc.parcel_count || 0,
        };
      }
    } catch (err) {
      console.warn('[GET /api/dashboard/ops] carrier summary failed:', err?.message || err);
    }

    const body = { ok: true, data: { ...ops, carriers } };
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.setHeader('ETag', etag);
    res.json(body);
  } catch (error) {
    console.error(`[GET /api/dashboard/ops] ${error.message}`, error);
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: 'Operative Kennzahlen konnten nicht geladen werden.', details: error.message },
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

  // IMPORTANT: This range computation MUST stay aligned with `getDashboardMetrics()`
  // in lib/firestore.js. Pre-2026-05 these two endpoints disagreed on `last7`
  // (rolling 7×24h here vs. 7 calendar days there) which caused Umsatz and Versand
  // to be summed over different windows even though they appeared on the same card.
  const utcDayStart = (d) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));

  let rangeFrom;
  switch (preset) {
    case 'today': {
      rangeFrom = utcDayStart(now);
      break;
    }
    case 'last7': {
      // 7 calendar days inclusive of today (matches firestore.js getDashboardMetrics).
      rangeFrom = utcDayStart(now);
      rangeFrom.setUTCDate(rangeFrom.getUTCDate() - 6);
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
      rangeFrom = customFromDate ? new Date(customFromDate + 'T00:00:00Z') : utcDayStart(now);
      if (!customFromDate) {
        rangeFrom.setUTCDate(rangeFrom.getUTCDate() - 6);
      }
      break;
    }
    default: { // unknown → last7 semantics
      rangeFrom = utcDayStart(now);
      rangeFrom.setUTCDate(rangeFrom.getUTCDate() - 6);
      break;
    }
  }

  // Range end. rangeTo is later passed through toDateStr() and treated as INCLUSIVE
  // by the external SevDesk / SendCloud APIs. Do not switch to exclusive semantics
  // here without also adjusting toDateStr() and the consumers downstream.
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
  // Shipping cost: SevDesk (actual paid invoices) + SendCloud (parcel count + carrier breakdown).
  const forceRefresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
  const [balanceResult, sevdeskShippingResult, sevdeskShippingYtdResult, scShippingResult, scShippingYtdResult] = await Promise.allSettled([
    getCheckAccountBalances({ timeoutMs: 15000 }),
    getShippingCostsFromSevDesk(fromDateStr, toDateStr2, { timeoutMs: 20000 }),
    // Only fetch YTD separately if not already YTD
    (preset !== 'year_to_date' && !(preset === 'last_year'))
      ? getShippingCostsFromSevDesk(ytdFromStr, ytdToStr, { timeoutMs: 20000 })
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
  function mergeShipping(svResult, scResult) {
    const sv = svResult?.status === 'fulfilled' ? (svResult.value || {}) : null;
    const sc = scResult?.status  === 'fulfilled' ? (scResult.value  || {}) : null;

    // SevDesk may have "direct" shipping costs (DHL/DPD paid without SendCloud,
    // e.g. pre-February 2026 when DHL was used directly). These are brutto bank
    // transactions and need to be included even when SendCloud is the primary source.
    const svDirectNetto = sv && sv.direct_shipping_cost > 0
      ? Math.round((sv.direct_shipping_cost / 1.19) * 100) / 100
      : 0;

    // SendCloud is preferred source for parcel count, carrier breakdown, and cost.
    // dhl + dpd + other_count == parcel_count so the dashboard's "DHL X · DPD Y · Sonstige Z"
    // labels add up to the total without a hidden ghost bucket.
    if (sc && sc.parcel_count > 0) {
      const dhl = sc.dhl_count || 0;
      const dpd = sc.dpd_count || 0;
      // Older SendCloud responses may not carry `other_count`; derive it as the
      // remainder so the invariant holds for backwards-compat callers.
      const other = typeof sc.other_count === 'number'
        ? sc.other_count
        : Math.max(0, sc.parcel_count - dhl - dpd);
      return {
        total_cost: Math.round((sc.total_cost + svDirectNetto) * 100) / 100,
        parcel_count: sc.parcel_count,
        dhl_count: dhl,
        dpd_count: dpd,
        other_count: other,
        direct_dhl_cost_netto: svDirectNetto,
        currency: 'EUR',
        source: svDirectNetto > 0 ? 'sendcloud+sevdesk' : 'sendcloud',
      };
    }

    // Fallback: SevDesk cost only
    if (!sv) return null;
    if (sv.voucher_count > 0) {
      // SevDesk total_cost is brutto → convert to netto so frontend × 1.19 = correct brutto
      const svTotalNetto = Math.round((sv.total_cost / 1.19) * 100) / 100;
      return { total_cost: svTotalNetto, parcel_count: 0, currency: 'EUR', source: 'sevdesk' };
    }
    return null;
  }

  const shippingMerged    = mergeShipping(sevdeskShippingResult,    scShippingResult);
  const shippingYtdMerged = mergeShipping(sevdeskShippingYtdResult, scShippingYtdResult);

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
    // If no useful data (0 parcels or 0 cost), fall back to order delivery prices
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
    errors.push(`Versand: ${shippingResult.reason?.message || 'Fehler beim Abrufen der Versandkosten'}`);
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

/**
 * GET /api/dashboard/activity
 * Returns recent activity events (orders, shipments, returns, stock syncs).
 */
router.get('/dashboard/activity', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const activities = [];
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const emptySnap = { docs: [] };
    const safeGet = (q) => q.get().catch(() => emptySnap);
    const [ordersSnap, shipmentsSnap, returnsSnap, syncSnap] = await Promise.all([
      safeGet(firestore.collection('orders').where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(10)),
      safeGet(firestore.collection('shipments').where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(10)),
      safeGet(firestore.collection('returns').where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(10)),
      safeGet(firestore.collection('stock_sync_log').where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(10)),
    ]);

    for (const doc of ordersSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'order',
        id: doc.id,
        title: `Auftrag ${d.marketplaceOrderId || d.orderId || doc.id}`,
        detail: [d.customer?.name, d.marketplace || d.source].filter(Boolean).join(' · ') || '',
        status: d.omsStatus || d.status || 'neu',
        timestamp: d.createdAt,
      });
    }

    for (const doc of shipmentsSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'shipment',
        id: doc.id,
        title: `Versand ${d.trackingNumber || ''}`,
        detail: d.carrier || '',
        status: 'shipped',
        timestamp: d.createdAt,
      });
    }

    for (const doc of returnsSnap.docs) {
      const d = doc.data();
      activities.push({
        type: 'return',
        id: doc.id,
        title: `Retoure ${d.returnNumber || doc.id}`,
        detail: d.reason || '',
        status: d.status || 'pending',
        timestamp: d.createdAt,
      });
    }

    for (const doc of syncSnap.docs) {
      const d = doc.data();
      const channels = (d.results || []).map((r) => r.channel).join(', ');
      const hasError = (d.results || []).some((r) => r.status === 'error' || r.status === 'failed');
      activities.push({
        type: 'sync',
        id: doc.id,
        title: `Stock-Sync ${d.productId || ''}`,
        detail: channels,
        status: hasError ? 'error' : 'success',
        timestamp: d.createdAt,
      });
    }

    activities.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ ok: true, data: activities.slice(0, limit) });
  } catch (err) {
    console.error(`[GET /api/dashboard/activity] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.post('/orders/sync', requirePermission('orders', 'read'), async (req, res) => {
  try {
    // Kick off background sync, but respond immediately with cached orders
    _backgroundSyncOrders();
    const tenantId = req.user?.tenantId || 'default';
    const rawOrders = await listOrders(500, { tenantId });

    const orders = await attachPickHintsToOrders(rawOrders || []);
    res.json({ ok: true, data: orders.map(normalizeOrderForResponse) });
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

    // Auto-generate invoice + SevDesk export on pick (non-blocking)
    const _tenantId = req.user?.tenantId || 'default';
    setImmediate(async () => {
      try {
        const { generateInvoice, exportToSevDesk } = require('../services/invoice-engine');
        const orderSnap = await require('../lib/firestore').firestore.collection('orders').doc(orderId).get();
        const orderData = orderSnap.exists ? orderSnap.data() : {};
        if (!orderData.invoiceId) {
          const inv = await generateInvoice({ orderId, tenantId: _tenantId, actor: req.user ? { uid: req.user.uid, email: req.user.email } : null });
          console.log(`[complete] auto-invoice created: ${inv.invoiceNumber} for order ${orderId}`);
          if (inv.invoiceId) {
            exportToSevDesk({ invoiceId: inv.invoiceId })
              .catch((err) => console.warn(`[complete] SevDesk auto-export failed for ${orderId}: ${err.message}`));
          }
        }
      } catch (invErr) {
        console.warn(`[complete] auto-invoice failed (non-blocking) for ${orderId}: ${invErr.message}`);
      }
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
      data.carrierRules = carrierRules.map((rule, idx) => {
        const out = {
          ...rule,
          minWeight: Number(rule.minWeight) || 0,
          maxWeight: Number(rule.maxWeight) || 0,
          shippingMethodId: Number(rule.shippingMethodId) || 0,
          // Persist drag-and-drop order so matchCarrierRule honours user priority.
          // Falls back to the array index when the client did not send an explicit value.
          order: rule.order != null && Number.isFinite(Number(rule.order))
            ? Math.max(0, Math.floor(Number(rule.order)))
            : idx,
        };
        return out;
      });
    }

    await firestore.collection('order_settings').doc(tenantId).set(data, { merge: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[PUT /api/orders/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── Shipments ──

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
    const shipments = snap.docs.map(d => {
      const s = { id: d.id, ...d.data() };
      // Enrich: estimate cost from CSV if not set by SendCloud
      if ((!s.cost || s.cost === 0) && s.weight && s.carrier) {
        const carrier = (s.carrier || '').toUpperCase();
        // Default SendCloud method IDs: DHL Paket=89, DPD Classic=111
        const methodId = carrier.includes('DHL') ? 89 : carrier.includes('DPD') ? 111 : null;
        if (methodId) {
          const estimated = lookupCsvPrice(methodId, s.weight);
          if (estimated > 0) {
            s.cost = estimated;
            s.costEstimated = true;
          }
        }
      }
      return s;
    });
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

    // Fetch recent sync logs (last 24h, max 500). The "errors" derived from these
    // only cover the last 24h — they do NOT show the durable backlog of failed
    // syncs sitting in stock_operation_failures (which is where unresolved
    // oversell-risk syncs accumulate). So we ALSO surface the all-time pending
    // failure count, scoped to the tenant. Best-effort: a missing index or old
    // SDK must never break the dashboard endpoint.
    const [logsSnap, reservationsSnap, pendingFailures] = await Promise.all([
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
      (async () => {
        try {
          const agg = await firestore.collection('stock_operation_failures')
            .where('tenantId', '==', tenantId)
            .where('status', '==', 'pending')
            .count()
            .get();
          return agg.data().count || 0;
        } catch (e) {
          console.warn(`[GET /api/sync/status] pending-failure count failed: ${e.message}`);
          return null; // unknown — UI shows neutral, not falsely "0"
        }
      })(),
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
        // pendingFailures = durable backlog of unresolved syncs (all-time), NOT
        // the 24h totalErrors. >0 means real syncs never reached the marketplace.
        summary: { totalSyncs, totalErrors, pendingFailures, since: since24h },
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
        order: normalizeOrderForResponse(order),
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
      // Auto-create Stornorechnung if order had an invoice
      setImmediate(async () => {
        try {
          const { createCorrectionInvoice } = require('../services/invoice-engine');
          await createCorrectionInvoice({ orderId, tenantId, type: 'storno', reason: note || 'Stornierung' });
        } catch (err) {
          console.warn(`[transition] Storno creation failed (non-blocking) for ${orderId}: ${err.message}`);
        }
      });
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

    // Auto-generate invoice + SevDesk export when order is picked (commissioned)
    if (toStatus === 'picked') {
      setImmediate(async () => {
        try {
          const { generateInvoice, exportToSevDesk } = require('../services/invoice-engine');
          const orderSnap = await require('../lib/firestore').firestore.collection('orders').doc(orderId).get();
          const orderData = orderSnap.exists ? orderSnap.data() : {};
          if (!orderData.invoiceId) {
            const inv = await generateInvoice({ orderId, tenantId, actor: req.user ? { uid: req.user.uid, email: req.user.email } : null });
            console.log(`[transition] auto-invoice created: ${inv.invoiceNumber} for order ${orderId}`);
            if (inv.invoiceId) {
              exportToSevDesk({ invoiceId: inv.invoiceId })
                .catch((err) => console.warn(`[transition] SevDesk auto-export failed for ${orderId}: ${err.message}`));
            }
          }
        } catch (invErr) {
          console.warn(`[transition] auto-invoice failed (non-blocking) for ${orderId}: ${invErr.message}`);
        }
      });
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
 * Sync orders from eBay and/or Kaufland directly.
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
    const tenantId = getOrderSettingsTenantId(req);
    const { getCachedShippingMethods } = require('../services/shipping-engine');
    const { weight, country } = req.query;
    const methods = await getCachedShippingMethods(tenantId, {
      weight: weight ? Number(weight) : undefined,
      country: country || undefined,
    });
    res.json({ ok: true, data: methods });
  } catch (err) {
    console.error(`[GET /api/shipping-methods] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/shipping-methods/sync — Trigger SendCloud shipping methods sync.
 */
router.post('/shipping-methods/sync', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const tenantId = getOrderSettingsTenantId(req);
    const { syncShippingMethods } = require('../services/shipping-engine');
    const methods = await syncShippingMethods(tenantId, { force: true });
    res.json({ ok: true, data: methods, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[POST /api/shipping-methods/sync] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/orders/:orderId/shipping-preview — Diagnose ship-readiness.
 *
 * Returns:
 *   - effective shipping weight (from order, items, or null)
 *   - all carrier rules whose [min, max] range contains that weight
 *   - whether the order has a usable address
 *
 * Used by the frontend (mobile pack flow + desktop OrderDetail) to:
 *   1. prompt for weight when missing,
 *   2. let the user pick when multiple rules match,
 *   3. skip both prompts when there is exactly one match.
 *
 * Read-only — never mutates Firestore. Falls back to DEFAULT_CARRIER_RULES
 * when the tenant has no configured rules.
 */
router.get('/orders/:orderId/shipping-preview', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    const orderSnap = await firestore.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Auftrag nicht gefunden.' } });
    }
    const order = { id: orderSnap.id, ...orderSnap.data() };

    const {
      calculateOrderWeight,
      matchAllCarrierRules,
      DEFAULT_CARRIER_RULES,
    } = require('../services/shipping-engine');

    // Derive weight + its origin so the UI can explain to the user where the value comes from.
    const orderLevelWeight = parseFloat(order.weight || '0') || 0;
    let weightKg = null;
    let weightSource = null;
    if (orderLevelWeight > 0) {
      weightKg = orderLevelWeight;
      weightSource = 'order';
    } else {
      const fromItems = calculateOrderWeight(order);
      if (fromItems != null && fromItems > 0) {
        weightKg = fromItems;
        weightSource = 'items';
      }
    }

    // Load tenant carrier rules (mirrors shipOrder() so preview = decision).
    const settingsSnap = await firestore.collection('order_settings').doc(tenantId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const rules = (settings.carrierRules && settings.carrierRules.length)
      ? settings.carrierRules
      : (DEFAULT_CARRIER_RULES || []);

    const matches = weightKg != null ? matchAllCarrierRules({ weight: weightKg, rules }) : [];

    const customer = order.customer || {};
    const hasAddress = Boolean(
      String(customer.street || '').trim() &&
      String(customer.city || '').trim() &&
      String(customer.zip || '').trim()
    );

    res.json({
      ok: true,
      data: {
        orderId,
        weight: weightKg,
        weightSource,
        hasWeight: weightKg != null && weightKg > 0,
        hasAddress,
        matches,
        // Distinguish "no rules configured at all" from "weight does not match any rule".
        rulesConfigured: rules.length,
      },
    });
  } catch (err) {
    console.error(`[GET /api/orders/:orderId/shipping-preview] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/orders/:orderId/ship — Create shipping label via SendCloud.
 */
router.post('/orders/:orderId/ship', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { shippingMethodId, weight, labelFormat } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    // Validate labelFormat — default to 'a6' (thermal) if not provided or invalid
    const validFormats = ['a4', 'a6'];
    const resolvedFormat = validFormats.includes(labelFormat) ? labelFormat : 'a6';

    const { shipOrder } = require('../services/shipping-engine');
    const result = await shipOrder({ orderId, tenantId, shippingMethodId, weight, labelFormat: resolvedFormat });

    // Transition to shipped when tracking confirmed, or when label created but announcement pending
    const hasLabel = !!(result.labelUrl);
    if (result.trackingNumber || hasLabel) {
      const { transitionOrder } = require('../services/order-state-machine');
      const note = result.trackingNumber
        ? `Versandlabel erstellt (${result.carrier || 'unknown'})`
        : `Versandlabel erstellt (${result.carrier || 'unknown'}) — Tracking ausstehend`;
      await transitionOrder({
        tenantId,
        orderId,
        toStatus: 'shipped',
        actor: { uid: req.user?.uid || 'system', email: req.user?.email || 'api' },
        note,
        timestamps: { shippedAt: new Date().toISOString() },
      });
    } else {
      console.warn(`[ship] No label or tracking for ${orderId} — staying in current status`);
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
 * POST /api/orders/:orderId/refresh-shipment — Reconcile order/shipment with SendCloud.
 *
 * Self-heal endpoint for the "label exists in SendCloud but order shows no
 * tracking number / no print button" symptom (incident 2026-04-29). Re-pulls
 * the parcel by `sendcloudParcelId`, then writes back any non-empty field
 * (tracking number, tracking URL, carrier code, label URL, status) to both
 * the shipment and the order. NEVER overwrites with null.
 *
 * Idempotent — calling repeatedly is safe and re-checks the SendCloud status
 * each time, so this also doubles as a manual delivery-status refresh.
 */
router.post('/orders/:orderId/refresh-shipment', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const tenantId = req.user?.tenantId || 'default';
    const { labelFormat } = req.body || {};
    const validFormats = ['a4', 'a6'];
    const resolvedFormat = validFormats.includes(labelFormat) ? labelFormat : 'a6';

    const { refreshShipmentFromSendCloud } = require('../services/shipping-engine');
    const result = await refreshShipmentFromSendCloud({ orderId, tenantId, labelFormat: resolvedFormat });

    // If we just learned a tracking number, push it to the marketplace too.
    // Best-effort: never block the refresh response on a marketplace failure.
    let marketplacePush = null;
    if (result.trackingNumber && result.updated.includes('order.trackingNumber')) {
      try {
        const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
        marketplacePush = await pushTrackingToMarketplace({
          orderId,
          trackingNumber: result.trackingNumber,
          carrier: result.carrier || '',
        });
      } catch (err) {
        console.warn(`[refresh-shipment] Marketplace push failed for ${orderId}: ${err.message}`);
        marketplacePush = { ok: false, error: err.message };
      }
    }

    res.json({ ok: true, data: { ...result, marketplacePush } });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/refresh-shipment] ${err.message}`, err);
    const code = /Kein Versand|Parcel.*konnte nicht/i.test(err.message) ? 'NOT_FOUND' : 'INTERNAL';
    res.status(code === 'NOT_FOUND' ? 404 : 500).json({ ok: false, error: { code, message: err.message } });
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
    const { transitionOrder, processLabelCancelled } = require('../services/order-state-machine');
    const transitionResult = await transitionOrder({
      tenantId,
      orderId,
      toStatus: 'packed',
      actor: { uid: req.user?.uid || 'system', email: req.user?.email || 'api' },
      note: 'Versandlabel storniert — Tracking entfernt',
      force: true,
    });

    // WP4 (flag-gated): wenn die Order beim Versand dekrementiert war, Bestand
    // symmetrisch wieder gutschreiben + Decrement-Marker loeschen (Re-Ship-fähig).
    // INERT bei STOCK_RECREDIT_ENABLED='false' (heutiges No-Op-Verhalten).
    if (transitionResult?.ok && transitionResult.fromStatus === 'shipped') {
      processLabelCancelled({ orderId, tenantId, fromStatus: 'shipped' }).catch((err) => {
        console.warn(`[cancel-label] re-credit on label-cancel failed for ${orderId}: ${err.message}`);
      });
    }

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
 * POST /api/orders/:orderId/tracking — Manually assign tracking number to an order.
 * Body: { trackingNumber: string, carrier?: string, trackingUrl?: string }
 */
router.post('/orders/:orderId/tracking', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { trackingNumber, carrier, trackingUrl } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    if (!trackingNumber || typeof trackingNumber !== 'string' || !trackingNumber.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Tracking-Nummer erforderlich.' } });
    }

    const orderSnap = await firestore.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Auftrag nicht gefunden.' } });
    }

    const order = orderSnap.data();

    // Update order with tracking info
    await firestore.collection('orders').doc(orderId).set({
      trackingNumber: trackingNumber.trim(),
      trackingUrl: trackingUrl || null,
      shippingService: carrier || order.shippingService || null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Create/update shipment record
    const existingShipSnap = await firestore.collection('shipments')
      .where('orderId', '==', orderId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (!existingShipSnap.empty) {
      await existingShipSnap.docs[0].ref.set({
        trackingNumber: trackingNumber.trim(),
        trackingUrl: trackingUrl || null,
        carrier: carrier || null,
        source: 'manual',
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } else {
      await firestore.collection('shipments').add({
        tenantId,
        orderId,
        orderNumber: order.marketplaceOrderId || order.orderId || null,
        marketplaceOrderId: order.marketplaceOrderId || null,
        marketplace: order.marketplace || order.source || null,
        trackingNumber: trackingNumber.trim(),
        trackingUrl: trackingUrl || null,
        carrier: carrier || null,
        status: 'ausstehend',
        source: 'manual',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // Transition to shipped if not already
    const currentStatus = order.omsStatus || order.status;
    if (currentStatus && !['shipped', 'delivered', 'completed', 'cancelled'].includes(currentStatus)) {
      const { transitionOrder } = require('../services/order-state-machine');
      await transitionOrder({
        tenantId,
        orderId,
        toStatus: 'shipped',
        actor: { uid: req.user?.uid || 'system', email: req.user?.email || 'api' },
        note: `Tracking manuell hinterlegt: ${trackingNumber.trim()}`,
        timestamps: { shippedAt: new Date().toISOString() },
      });
    }

    // Push tracking to marketplace
    if (trackingNumber.trim()) {
      try {
        const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
        await pushTrackingToMarketplace({
          orderId,
          trackingNumber: trackingNumber.trim(),
          carrier: carrier || '',
        });
      } catch (pushErr) {
        console.warn(`[tracking] Marketplace push failed: ${pushErr.message}`);
      }
    }

    res.json({ ok: true, data: { message: 'Tracking-Nummer hinterlegt.', trackingNumber: trackingNumber.trim() } });
  } catch (err) {
    console.error(`[POST /api/orders/:orderId/tracking] ${err.message}`, err);
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

    // Persist VAT rate on order before generating invoice
    if (req.body.vatRate !== undefined) {
      const rate = parseFloat(req.body.vatRate);
      if ([0, 0.07, 0.19].includes(rate)) {
        const { Firestore } = require('@google-cloud/firestore');
        const db = new Firestore();
        await db.collection('orders').doc(orderId).set({ vatRate: rate, updatedAt: new Date().toISOString() }, { merge: true });
      }
    }

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
    const { orderIds, shippingMethodId, labelFormat } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'orderIds array required' } });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Max 50 orders per bulk ship' } });
    }

    const tenantId = req.user?.tenantId || 'default';
    const actor = { uid: req.user?.uid || 'system', email: req.user?.email || 'api' };
    const validFormats = ['a4', 'a6'];
    const resolvedFormat = validFormats.includes(labelFormat) ? labelFormat : 'a6';
    const { shipOrder } = require('../services/shipping-engine');
    const { transitionOrder } = require('../services/order-state-machine');
    const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');

    const results = [];
    for (const orderId of orderIds) {
      try {
        const result = await shipOrder({ orderId, tenantId, shippingMethodId, labelFormat: resolvedFormat });

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

const ALLOWED_CUSTOMER_FIELDS = ['name', 'street', 'city', 'zip', 'country', 'phone', 'email', 'postNumber'];

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
          let val = customer[key] === '' ? null : customer[key];
          // Ensure zip is always stored as String (leading zeros matter for DE/AT PLZ)
          if (key === 'zip' && val != null) {
            val = String(val).trim();
          }
          sanitized[key] = val;
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
 * Query params:
 *   - format: 'a4' | 'a6' (default: 'a6') — selects normal_printer (A4) or label_printer (A6/thermal)
 */
router.get('/orders/:orderId/label', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const format = req.query.format === 'a4' ? 'a4' : 'a6';

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
    const parcelId = shipment.sendcloudParcelId;

    // Get actual label URL from SendCloud parcel API (not constructed from ID)
    const { downloadLabelPdf, getLabel } = require('../services/shipping-engine');
    let labelUrl;
    if (parcelId) {
      const labelResult = await getLabel({ parcelId, labelFormat: format });
      labelUrl = labelResult.labelUrl;
    }
    // Fallback to stored URL if getLabel returned nothing
    if (!labelUrl) {
      labelUrl = shipment.labelUrl;
    }

    if (!labelUrl) {
      return res.status(404).json({ ok: false, error: { code: 'NO_LABEL', message: 'Kein Label von SendCloud verfügbar. Bitte Label in SendCloud prüfen.' } });
    }

    const { buffer, contentType } = await downloadLabelPdf(labelUrl);

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `inline; filename="label-${orderId}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error(`[GET /api/orders/:orderId/label] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── POST /api/orders/address-labels — Empfänger-Adresslabels (62×29mm) ──

router.post('/orders/address-labels', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'orderIds Array erforderlich' } });
    }
    if (orderIds.length > 100) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'Maximal 100 Orders pro Anfrage' } });
    }

    // Batch-load orders
    const orderRefs = orderIds.map((id) => firestore.collection('orders').doc(id));
    const snapshots = await firestore.getAll(...orderRefs);

    const addresses = [];
    const incomplete = [];

    for (const snap of snapshots) {
      if (!snap.exists) continue;
      const order = snap.data();
      const c = order.customer || {};
      const addr = {
        name: (c.name || '').trim(),
        street: (c.street || '').trim(),
        zip: String(c.zip || '').trim(),
        city: (c.city || '').trim(),
      };

      const missing = [];
      if (!addr.name) missing.push('name');
      if (!addr.street) missing.push('street');
      if (!addr.zip) missing.push('zip');
      if (!addr.city) missing.push('city');

      if (missing.length > 0) {
        incomplete.push({ orderId: snap.id, missing });
      } else {
        addresses.push(addr);
      }
    }

    if (incomplete.length > 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INCOMPLETE_ADDRESS', message: `${incomplete.length} Bestellung(en) mit unvollständiger Adresse` },
        incomplete,
      });
    }

    if (addresses.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NO_ORDERS', message: 'Keine gültigen Bestellungen gefunden' } });
    }

    const html = buildAddressLabelsHtml(addresses);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(`[POST /api/orders/address-labels] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = { router, setBackgroundSyncOrders };
