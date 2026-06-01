const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { generalLimiter } = require('./lib/rate-limit');
const requestLogger = require('./lib/request-logger');
const { startJobRunner } = require('./services/job-runner');
const { startImproveRunner } = require('./services/improve-runner');
const { startQualityRunner } = require('./services/quality-runner');
const { startRulebookRunner } = require('./services/rulebook-runner');
const { startAdminBulkRunner } = require('./services/admin-bulk-runner');
const { startPricingRunner } = require('./services/pricing-runner');
const { startListingSyncRunner } = require('./services/listing-sync-runner');
const { startCompetitorRefreshRunner } = require('./services/competitor-refresh-runner');
const { router: warehouseRouter } = require('./routes/warehouse');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { router: ordersRouter, setBackgroundSyncOrders } = require('./routes/orders');
const identifyRouter = require('./routes/identify');
const { router: productsRouter } = require('./routes/products');
const marketplaceRouter = require('./routes/marketplace');
const integrationsRouter = require('./routes/integrations');
const settingsRouter = require('./routes/settings');
const returnsRouter = require('./routes/returns');
const invoicesRouter = require('./routes/invoices');
const webhooksRouter = require('./routes/webhooks');
const rulesRouter = require('./routes/rules');
const sessionsRouter = require('./routes/sessions');
const { router: sseRouter } = require('./routes/sse');
const helpRouter = require('./routes/help');
// order-sync's syncNewOrders is no longer used (replaced by native eBay/Kaufland intake)
const { requireAuth } = require('./lib/auth');
const { ensureDefaultRoles } = require('./lib/rbac');
const { ensureBootstrapAdmin } = require('./lib/bootstrap-admin');
const { ensureDefaultLlmScopes } = require('./lib/llm-config');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const REQUEST_BODY_LIMIT =
  process.env.API_REQUEST_BODY_LIMIT ||
  process.env.REQUEST_BODY_LIMIT ||
  '50mb';

// --- Pre-Flip-Gate: IDENTIFY_V4 promotion acknowledge ----------------------
// Phase-E bug-fix (2026-05-10): if IDENTIFY_V4=true is flipped in production
// without the operator having acknowledged the critic-hints code path, log a
// loud startup warning. NEVER throw or process.exit() — Cloud Run service
// MUST start. The flag IDENTIFY_V4_CRITIC_HINTS_VERIFIED is set by the
// operator after reading docs/runbooks/identify-v4-promotion.md.
if (process.env.IDENTIFY_V4 === 'true' && process.env.IDENTIFY_V4_CRITIC_HINTS_VERIFIED !== 'true') {
  const msg = '[STARTUP-WARN] IDENTIFY_V4=true but IDENTIFY_V4_CRITIC_HINTS_VERIFIED!=true. ' +
    'Phase-E-Code-Pfad nicht verifiziert. Siehe docs/runbooks/identify-v4-promotion.md';
  console.error(msg);
  // Optional best-effort Slack alert — never blocks startup.
  if (process.env.SLACK_ALERTS_URL) {
    try {
      // Fire-and-forget — node 20 has global fetch.
      Promise.resolve()
        .then(() => fetch(process.env.SLACK_ALERTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: msg }),
        }))
        .catch((err) => console.warn('[STARTUP-WARN] slack alert failed:', err?.message || err));
    } catch (err) {
      console.warn('[STARTUP-WARN] slack alert dispatch error:', err?.message || err);
    }
  }
}

// --- Initialization ---
const app = express();
// Behind Cloud Run's front-end proxy: trust X-Forwarded-For so req.ip is the real
// client IP, giving each client its own rate-limit bucket (not one shared proxy IP).
app.set('trust proxy', true);

// --- Helper: order sync best-effort in background; never block responses ---
const ORDER_SYNC_TIMEOUT_MS = parseInt(process.env.ORDER_SYNC_TIMEOUT_MS || '8000', 10);
const ORDER_SYNC_THROTTLE_MS = parseInt(process.env.ORDER_SYNC_THROTTLE_MS || '60000', 10);
let ordersSyncInFlight = false;
let lastOrdersSyncAtMs = 0;
function backgroundSyncOrders() {
  const now = Date.now();
  if (ordersSyncInFlight) return;
  if (Number.isFinite(lastOrdersSyncAtMs) && now - lastOrdersSyncAtMs < ORDER_SYNC_THROTTLE_MS) {
    return;
  }
  ordersSyncInFlight = true;
  lastOrdersSyncAtMs = now;

  const timer = setTimeout(() => {
    // best-effort safety: release lock even if something hangs
    ordersSyncInFlight = false;
  }, ORDER_SYNC_TIMEOUT_MS);

  const { syncOrders: syncOrdersRouted } = require('./services/order-source-router');
  syncOrdersRouted()
    .catch((err) => console.warn('Background order sync failed:', err?.message || err))
    .finally(() => {
      clearTimeout(timer);
      ordersSyncInFlight = false;
    });
}

// --- CORS ---
const allowedOrigins = [
  'https://avycloud.web.app',
  'https://avycloud.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// --- Start Runners ---
startJobRunner();
startImproveRunner();
startQualityRunner();
startRulebookRunner();
try {
  startAdminBulkRunner();
} catch (e) {
  console.warn('[AdminBulkRunner] failed to start (non-blocking):', e?.message || e);
}
try {
  startPricingRunner();
} catch (e) {
  console.warn('[PricingRunner] failed to start (non-blocking):', e?.message || e);
}
try {
  startListingSyncRunner();
} catch (e) {
  console.warn('[ListingSyncRunner] failed to start (non-blocking):', e?.message || e);
}
try {
  startCompetitorRefreshRunner();
} catch (e) {
  console.warn('[CompetitorRefreshRunner] failed to start (non-blocking):', e?.message || e);
}
ensureDefaultRoles()
  .then(() => console.log('RBAC default roles ensured.'))
  .catch((error) => console.error('RBAC role seeding failed:', error));
ensureBootstrapAdmin()
  .then((r) => console.log(`Bootstrap admin ensured (${r.email})${r.created ? ' [created]' : ''}`))
  .catch((error) => console.error('Bootstrap admin failed:', error));
ensureDefaultLlmScopes()
  .then(async () => {
    console.log('LLM scopes ensured.');
    try {
      const { ensureDefaultLlmScopeVersions } = require('./lib/llm-config');
      await ensureDefaultLlmScopeVersions();
      console.log('LLM default scope versions ensured.');
    } catch (e) {
      console.error('LLM default version seeding failed:', e?.message || e);
    }
  })
  .catch((error) => console.error('LLM scope seeding failed:', error));
// --- Middleware ---
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(helmet({
  contentSecurityPolicy: false, // Frontend wird separat gehostet
  crossOriginEmbedderPolicy: false,
}));
app.use(generalLimiter);
app.use(requestLogger);
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      ok: false,
      error: {
        code: 403,
        message: 'Origin not allowed by CORS policy.',
      },
    });
  }
  return next(err);
});
// HARDEN-2/3 (2026-05-20): Raw-Body für Webhook-Signatur-Verifikation capturen.
// Webhooks (eBay/Kaufland/SendCloud) signieren über den EXAKTEN Byte-Stream;
// nach `express.json()` ist `req.body` ein geparstes Objekt → re-stringify
// produziert andere Bytes (whitespace, key-order, escapes) → HMAC fail.
// Wir speichern den Buffer NUR für /api/webhooks/* — sonst leere CPU-Last
// und unnötiger Memory-Hold.
app.use(express.json({
  limit: REQUEST_BODY_LIMIT,
  verify: (req, _res, buf) => {
    if (buf && buf.length && typeof req.url === 'string' && req.url.startsWith('/api/webhooks/')) {
      req.rawBody = buf; // Buffer (raw bytes), nicht decoded string
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// Compatibility bridge: older frontend builds may call "/app/api/*" instead of "/api/*".
// Normalize those requests server-side so stale cached clients keep working.
app.use((req, res, next) => {
  const rawUrl = String(req.url || '');
  let normalizedPath = rawUrl;
  if (!normalizedPath.startsWith('/')) {
    try {
      const parsed = new URL(normalizedPath);
      normalizedPath = `${parsed.pathname || ''}${parsed.search || ''}`;
    } catch {
      normalizedPath = rawUrl;
    }
  }
  if (normalizedPath.startsWith('/app/api')) {
    req.url = normalizedPath.replace(/^\/app(?=\/api(?:\/|$))/, '');
    res.setHeader('X-Avycloud-App-Api-Normalized', '1');
  }
  return next();
});

// Support token-in-query for SSE endpoints (EventSource cannot set custom headers).
// Copies ?token=<jwt> into the Authorization header so existing auth middleware works unchanged.
app.use('/api', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.status(200).send('Product Intelligence Backend is running.');
});

// Health checks — keine Auth nötig
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

// --- Public Auth API (extracted router, no auth required) ---
app.use('/api/auth', authRouter);

// --- Public Webhooks (no auth — machine-to-machine, validated per-route) ---
app.use('/api', webhooksRouter);

// Default-deny: everything under /api requires authentication by default.
// Allowlist endpoints that must be public for technical reasons (e.g., <img src> cannot send headers).
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/image-proxy') return next();
  if (req.path === '/ebay/oauth/callback') return next(); // eBay redirect — no auth header
  return requireAuth(req, res, next);
});

// --- Extracted Routers (authenticated) ---
app.use('/api/warehouse', warehouseRouter);
app.use('/api/admin', adminRouter);
app.use('/api', ordersRouter);
app.use('/api', identifyRouter);
app.use('/api', productsRouter);
app.use('/api', marketplaceRouter);
app.use('/api', integrationsRouter);
app.use('/api', settingsRouter);
app.use('/api', returnsRouter);
app.use('/api', invoicesRouter);
app.use('/api/v1/rules', rulesRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api', sseRouter);
app.use('/api', helpRouter);
setBackgroundSyncOrders(backgroundSyncOrders);

// --- Centralized Error Handler ---
const { errorHandler } = require('./lib/error-handler');
app.use(errorHandler);

// --- Server Start ---
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);

  // ─── Event-Driven Sync is PRIMARY (sync-event-bus.js) ───────────────
  // Periodic intervals below are SAFETY NETS only — they catch anything
  // the event-driven system might miss (e.g. webhook delivery failure).
  // Primary sync happens via emitSyncEvent() on every data mutation.

  // ─── Multi-Tenant background-job loop (additive, default off) ─────
  // Mirrors STOCK_FAILURE_DRAIN_TENANTS pattern. Set
  //   BACKGROUND_JOB_TENANTS=tenantA,tenantB
  // to fan out the 6 safety-net cron jobs below across multiple tenants.
  // When unset (default) the legacy single-tenant behaviour (tenantId:'default')
  // is preserved verbatim — no behaviour change for existing deployments.
  // Activation runbook: docs/runbooks/multi-tenant-activation.md
  // Plan-D.0c — helpers extracted to lib/background-job-tenants.js for testability.
  const {
    getBackgroundJobTenants,
    runForEachBackgroundJobTenant,
  } = require('./lib/background-job-tenants');
  /**
   * Run `fn({ tenantId })` once per configured tenant when
   * BACKGROUND_JOB_TENANTS is set, otherwise once with tenantId='default'.
   * Errors per-tenant are caught + logged so one bad tenant doesn't break
   * the remaining iterations.
   * Thin adapter that preserves the legacy `{ tenantId }` object signature
   * used by all six cron call sites below.
   */
  const runForAllTenants = (label, fn) => runForEachBackgroundJobTenant(label, (tenantId) => fn({ tenantId }));
  const _backgroundJobTenantList = getBackgroundJobTenants();
  if (_backgroundJobTenantList.length > 1 || _backgroundJobTenantList[0] !== 'default') {
    console.log(`[background-jobs] multi-tenant mode: tenants=${_backgroundJobTenantList.join(',')}`);
  }

  // Safety-net: order sync every 6h (primary: event-driven on every mutation)
  const ORDER_SYNC_INTERVAL_MS = parseInt(process.env.ORDER_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  try {
    setTimeout(() => backgroundSyncOrders(), 10_000);
    setInterval(() => backgroundSyncOrders(), ORDER_SYNC_INTERVAL_MS);
    console.log(`[order-sync] safety-net enabled: every ${ORDER_SYNC_INTERVAL_MS}ms (primary: event-driven)`);
  } catch (err) {
    console.warn('[order-sync] failed to start safety-net:', err?.message || err);
  }

  // Safety-net: returns sync every 6h (primary: event-driven on return mutations + webhooks)
  const RETURNS_SYNC_INTERVAL_MS = parseInt(process.env.RETURNS_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  try {
    const runReturnsSync = async () => {
      const { syncAllReturns } = require('./services/returns-engine');
      await runForAllTenants('returns-sync', async ({ tenantId }) => {
        const r = await syncAllReturns({ tenantId, lookbackDays: 30 });
        console.log(`[returns-sync] tenant=${tenantId} done:`, JSON.stringify(r));
      });
    };
    setTimeout(() => { runReturnsSync().catch((err) => console.warn('[returns-sync] failed:', err?.message)); }, 60_000);
    setInterval(() => { runReturnsSync().catch((err) => console.warn('[returns-sync] failed:', err?.message)); }, RETURNS_SYNC_INTERVAL_MS);
    console.log(`[returns-sync] safety-net enabled: every ${RETURNS_SYNC_INTERVAL_MS}ms (primary: event-driven)`);
  } catch (err) {
    console.warn('[returns-sync] failed to start safety-net:', err?.message || err);
  }

  // Safety-net: marketplace refund → correction invoice (every 6h)
  // Auto-creates a Teil-Gutschrift (SR) in SevDesk for eBay/Kaufland refunds so
  // the invoice reflects reduced revenue + VAT. Lookback window limits the scope
  // so the historical refund backlog is NOT mass-processed (separate backfill).
  // Set REFUND_SYNC_SINCE=YYYY-MM-DD as a hard floor if needed.
  const REFUND_SYNC_INTERVAL_MS = parseInt(process.env.REFUND_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  const REFUND_SYNC_LOOKBACK_DAYS = parseInt(process.env.REFUND_SYNC_LOOKBACK_DAYS || '7', 10);
  try {
    const runRefundSync = async () => {
      const { syncRefunds } = require('./services/refund-sync');
      await runForAllTenants('refund-sync', async ({ tenantId }) => {
        const r = await syncRefunds({ tenantId, sinceDate: process.env.REFUND_SYNC_SINCE || null, lookbackDays: REFUND_SYNC_LOOKBACK_DAYS });
        console.log(`[refund-sync] tenant=${tenantId} done:`, JSON.stringify(r));
      });
    };
    setTimeout(() => { runRefundSync().catch((err) => console.warn('[refund-sync] failed:', err?.message)); }, 120_000);
    setInterval(() => { runRefundSync().catch((err) => console.warn('[refund-sync] failed:', err?.message)); }, REFUND_SYNC_INTERVAL_MS);
    console.log(`[refund-sync] enabled: every ${REFUND_SYNC_INTERVAL_MS}ms, lookback ${REFUND_SYNC_LOOKBACK_DAYS}d`);
  } catch (err) {
    console.warn('[refund-sync] failed to start:', err?.message || err);
  }

  // Safety-net: SendCloud parcel sync every 6h (primary: SendCloud webhooks)
  const SENDCLOUD_SYNC_INTERVAL_MS = parseInt(process.env.SENDCLOUD_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  try {
    const runSendCloudSync = async () => {
      const { syncSendCloudParcels } = require('./services/shipping-engine');
      const fromDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      await runForAllTenants('sendcloud-sync', async ({ tenantId }) => {
        const r = await syncSendCloudParcels({ tenantId, fromDate });
        console.log('[sendcloud-sync] tenant=%s done: matched=%d, unmatched=%d, skipped=%d',
          tenantId, r.matched?.length || 0, r.unmatched?.length || 0, r.skipped?.length || 0);
      });
    };
    setTimeout(() => { runSendCloudSync().catch((err) => console.warn('[sendcloud-sync] failed:', err?.message)); }, 90_000);
    setInterval(() => { runSendCloudSync().catch((err) => console.warn('[sendcloud-sync] failed:', err?.message)); }, SENDCLOUD_SYNC_INTERVAL_MS);
    console.log(`[sendcloud-sync] safety-net enabled: every ${SENDCLOUD_SYNC_INTERVAL_MS}ms (primary: event-driven)`);
  } catch (err) {
    console.warn('[sendcloud-sync] failed to start safety-net:', err?.message || err);
  }

  // ─── Marketplace Tracking Push Catch-up (every 2h) ──────────
  // Retries failed tracking pushes for shipped orders — prevents marketplace warnings
  try {
    const TRACKING_CATCHUP_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
    const runTrackingCatchup = async () => {
      const { retryFailedMarketplacePushes } = require('./services/marketplace-tracking');
      await runForAllTenants('tracking-catchup', async ({ tenantId }) => {
        const result = await retryFailedMarketplacePushes({ tenantId, maxAge: 7 });
        if (result.retried > 0) {
          console.log(`[tracking-catchup] tenant=${tenantId} retried=${result.retried} succeeded=${result.succeeded} failed=${result.failed}`);
        }
      });
    };
    setTimeout(() => { runTrackingCatchup().catch((err) => console.warn('[tracking-catchup] failed:', err?.message)); }, 120_000); // First run after 2 min
    setInterval(() => { runTrackingCatchup().catch((err) => console.warn('[tracking-catchup] failed:', err?.message)); }, TRACKING_CATCHUP_INTERVAL_MS);
    console.log(`[tracking-catchup] safety-net enabled: every ${TRACKING_CATCHUP_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[tracking-catchup] failed to start safety-net:', err?.message || err);
  }

  // ── Delivery status polling: check shipped parcels for delivery every 2h ──
  try {
    const DELIVERY_POLL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
    const runDeliveryPoll = async () => {
      const { pollDeliveryStatus } = require('./services/shipping-engine');
      await runForAllTenants('delivery-poll', async ({ tenantId }) => {
        const result = await pollDeliveryStatus({ tenantId });
        if (result.delivered > 0 || result.errors > 0) {
          console.log(`[delivery-poll] tenant=${tenantId} checked=${result.checked} delivered=${result.delivered} errors=${result.errors}`);
        }
      });
    };
    setTimeout(() => { runDeliveryPoll().catch((err) => console.warn('[delivery-poll] failed:', err?.message)); }, 150_000); // First run after 2.5 min
    setInterval(() => { runDeliveryPoll().catch((err) => console.warn('[delivery-poll] failed:', err?.message)); }, DELIVERY_POLL_INTERVAL_MS);
    console.log(`[delivery-poll] enabled: every ${DELIVERY_POLL_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[delivery-poll] failed to start:', err?.message || err);
  }

  // ─── Invoice Sync: SevDesk Import + Bulk Generate (startup + every 24h) ─
  // On boot: import all existing SevDesk invoices, then generate any missing ones.
  // Runs again every 24h to catch any gaps. Fully idempotent.
  const INVOICE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const runInvoiceSync = async () => {
    const { importFromSevDesk, bulkGenerateForShippedOrders } = require('./services/invoice-engine');
    await runForAllTenants('invoice-sync', async ({ tenantId }) => {
      const importResult = await importFromSevDesk({ tenantId });
      if (importResult.imported > 0 || importResult.matched > 0) {
        console.log(`[invoice-sync] tenant=${tenantId} SevDesk import: imported=${importResult.imported} matched=${importResult.matched} skipped=${importResult.skipped}`);
      }
      const genResult = await bulkGenerateForShippedOrders({ tenantId });
      if (genResult.generated > 0) {
        console.log(`[invoice-sync] tenant=${tenantId} bulk generate: generated=${genResult.generated} skipped=${genResult.skipped} errors=${genResult.errors.length}`);
      }
    });
  };
  try {
    setTimeout(() => { runInvoiceSync().catch((err) => console.warn('[invoice-sync] failed:', err?.message)); }, 5 * 60 * 1000); // First run 5 min after startup
    setInterval(() => { runInvoiceSync().catch((err) => console.warn('[invoice-sync] failed:', err?.message)); }, INVOICE_SYNC_INTERVAL_MS);
    console.log('[invoice-sync] enabled: startup + every 24h');
  } catch (err) {
    console.warn('[invoice-sync] failed to schedule:', err?.message);
  }

  // ─── Marketplace Refund Push (every 4h) ─────────────────────
  // Auto-pushes refunds to eBay/Kaufland for returns in 'erstattet' status
  try {
    const REFUND_PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
    const runRefundPush = async () => {
      const { runRefundPush: pushRefunds } = require('./services/returns-engine');
      await runForAllTenants('refund-push', async ({ tenantId }) => {
        const result = await pushRefunds({ tenantId });
        if (result.processed > 0) {
          console.log(`[refund-push] tenant=${tenantId} processed=${result.processed} success=${result.success} errors=${result.errors.length}`);
        }
      });
    };
    setTimeout(() => { runRefundPush().catch((err) => console.warn('[refund-push] failed:', err?.message)); }, 180_000); // First run after 3 min
    setInterval(() => { runRefundPush().catch((err) => console.warn('[refund-push] failed:', err?.message)); }, REFUND_PUSH_INTERVAL_MS);
    console.log(`[refund-push] safety-net enabled: every ${REFUND_PUSH_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[refund-push] failed to start safety-net:', err?.message || err);
  }

  // ─── Kaufland Listings Cache Sync (every 15min) ─────────────
  // Refreshes the `kauflandUnitsLive` cache used by the Inventory UI for
  // listed/not-listed badges, backfills `ops.kaufland.unitId` into products_v2,
  // detects forward drift (kaufland>0 while warehouse=0 → outbound stock sync)
  // and surfaces reverse drift (warehouse>0 while kaufland=0/ONHOLD → report-only).
  // Same service is called by `POST /api/marketplace/kaufland/listings/sync` so
  // ad-hoc manual sync and the cron stay perfectly in lockstep.
  try {
    const KAUFLAND_LISTINGS_SYNC_INTERVAL_MS = parseInt(
      process.env.KAUFLAND_LISTINGS_SYNC_INTERVAL_MS || String(15 * 60 * 1000),
      10,
    );
    const KAUFLAND_LISTINGS_SYNC_STOREFRONT = String(process.env.KAUFLAND_LISTINGS_SYNC_STOREFRONT || 'de').trim().toLowerCase();
    const runKauflandListingsSync = async () => {
      const { syncKauflandListingsCache } = require('./services/kaufland-listings-sync');
      await runForAllTenants('kaufland-listings-sync', async ({ tenantId }) => {
        const r = await syncKauflandListingsCache({ tenantId, storefront: KAUFLAND_LISTINGS_SYNC_STOREFRONT });
        console.log('[kaufland-listings-sync] tenant=%s storefront=%s fetched=%d active=%d driftsDetected=%d reconciled=%d reverseDriftsDetected=%d',
          tenantId, r.storefront, r.fetched, r.active, r.driftsDetected, r.reconciled, r.reverseDriftsDetected);
      });
    };
    setTimeout(() => { runKauflandListingsSync().catch((err) => console.warn('[kaufland-listings-sync] failed:', err?.message)); }, 210_000); // First run after 3.5 min
    setInterval(() => { runKauflandListingsSync().catch((err) => console.warn('[kaufland-listings-sync] failed:', err?.message)); }, KAUFLAND_LISTINGS_SYNC_INTERVAL_MS);
    console.log(`[kaufland-listings-sync] safety-net enabled: every ${KAUFLAND_LISTINGS_SYNC_INTERVAL_MS}ms storefront=${KAUFLAND_LISTINGS_SYNC_STOREFRONT}`);
  } catch (err) {
    console.warn('[kaufland-listings-sync] failed to start safety-net:', err?.message || err);
  }

  // Safety-net: expire stale stock reservations every 5 minutes
  const RESERVATION_CLEANUP_MS = parseInt(process.env.RESERVATION_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10);
  try {
    setTimeout(() => {
      const { expireStaleReservations } = require('./services/stock-reservation');
      expireStaleReservations()
        .then((r) => { if (r.expired > 0) console.log(`[reservation-cleanup] Expired ${r.expired} stale reservations`); })
        .catch((err) => console.warn('[reservation-cleanup] failed:', err?.message));
    }, 30_000); // 30s initial delay
    setInterval(() => {
      const { expireStaleReservations } = require('./services/stock-reservation');
      expireStaleReservations()
        .then((r) => { if (r.expired > 0) console.log(`[reservation-cleanup] Expired ${r.expired} stale reservations`); })
        .catch((err) => console.warn('[reservation-cleanup] failed:', err?.message));
    }, RESERVATION_CLEANUP_MS);
    console.log(`[reservation-cleanup] safety-net enabled: every ${RESERVATION_CLEANUP_MS}ms`);
  } catch (err) {
    console.warn('[reservation-cleanup] failed to start:', err?.message || err);
  }

  // Stock reconciliation: activity-based every 30min, full scan daily at 3 AM
  const RECONCILIATION_INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS || String(30 * 60 * 1000), 10);
  try {
    let lastFullScanDate = null;
    const runReconciliation = async () => {
      try {
        const { reconcileRecentActivity, reconcileFullScan } = require('./services/stock-reconciliation');

        // Full scan 1x pro Tag zwischen 3:00-3:29 Uhr
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (now.getHours() === 3 && now.getMinutes() < 30 && lastFullScanDate !== today) {
          lastFullScanDate = today;
          const result = await reconcileFullScan();
          console.log(`[stock-reconciliation] full-scan: checked=${result.checked} drifts=${result.driftsFound} fixed=${result.autoFixed}`);
          return;
        }

        // Activity-based alle 30min
        const result = await reconcileRecentActivity();
        if (result.driftsFound > 0) {
          console.log(`[stock-reconciliation] activity: checked=${result.checked} drifts=${result.driftsFound} fixed=${result.autoFixed}`);
        }
      } catch (err) {
        console.warn('[stock-reconciliation] failed:', err?.message);
      }
    };
    setTimeout(runReconciliation, 4 * 60 * 1000); // First run after 4 min
    setInterval(runReconciliation, RECONCILIATION_INTERVAL_MS);
    console.log(`[stock-reconciliation] enabled: activity every ${RECONCILIATION_INTERVAL_MS}ms, full scan daily at 03:00`);
  } catch (err) {
    console.warn('[stock-reconciliation] failed to start:', err?.message || err);
  }

  // Stock-Failure-Drain: retry fehlgeschlagene Marketplace-Syncs alle 2min
  // Siehe CLAUDE.md Punkt 10 (Oversell-Verbot). Feature-Flag STOCK_FAILURE_DRAIN_ENABLED.
  const STOCK_DRAIN_INTERVAL_MS = parseInt(process.env.STOCK_FAILURE_DRAIN_INTERVAL_MS || String(2 * 60 * 1000), 10);
  const STOCK_DRAIN_TENANTS = (process.env.STOCK_FAILURE_DRAIN_TENANTS || 'trendocean').split(',').map((t) => t.trim()).filter(Boolean);
  try {
    const runStockFailureDrain = async () => {
      if (process.env.STOCK_FAILURE_DRAIN_ENABLED === 'false') return;
      try {
        const { drainStockFailures } = require('./services/stock-failure-drain');
        for (const tenantId of STOCK_DRAIN_TENANTS) {
          const r = await drainStockFailures({ tenantId, limit: 50 });
          if (r && (r.resolved > 0 || r.abandoned > 0 || r.needsManual > 0)) {
            console.log(`[stock-failure-drain] tenant=${tenantId} total=${r.total} resolved=${r.resolved} stillFailing=${r.stillFailing} abandoned=${r.abandoned} needsManual=${r.needsManual}`);
          }
        }
      } catch (err) {
        console.warn('[stock-failure-drain] failed:', err?.message);
      }
    };
    setTimeout(runStockFailureDrain, 60 * 1000); // First run after 60s
    setInterval(runStockFailureDrain, STOCK_DRAIN_INTERVAL_MS);
    console.log(`[stock-failure-drain] enabled: tenants=${STOCK_DRAIN_TENANTS.join(',')} interval=${STOCK_DRAIN_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[stock-failure-drain] failed to start:', err?.message || err);
  }

  // Restock alert: check for pending return restocks every 2 hours
  const RESTOCK_ALERT_INTERVAL_MS = parseInt(process.env.RESTOCK_ALERT_INTERVAL_MS || String(2 * 60 * 60 * 1000), 10);
  try {
    const runRestockAlert = async () => {
      try {
        const { checkPendingRestocks } = require('./services/restock-alert');
        const result = await checkPendingRestocks();
        if (result.newAlerts > 0) {
          console.log(`[restock-alert] checked=${result.checked} newAlerts=${result.newAlerts}`);
        }
      } catch (err) {
        console.warn('[restock-alert] failed:', err?.message);
      }
    };
    setTimeout(runRestockAlert, 5 * 60 * 1000); // First run after 5 min
    setInterval(runRestockAlert, RESTOCK_ALERT_INTERVAL_MS);
    console.log(`[restock-alert] enabled: every ${RESTOCK_ALERT_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[restock-alert] failed to start:', err?.message || err);
  }
});

// Graceful shutdown für Cloud Run
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force-close nach 10s
  setTimeout(() => process.exit(1), 10000);
});
