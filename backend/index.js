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

// --- Initialization ---
const app = express();

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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
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
    setTimeout(() => {
      const { syncAllReturns } = require('./services/returns-engine');
      syncAllReturns({ tenantId: 'default', lookbackDays: 30 })
        .then((r) => console.log('[returns-sync] safety-net sync done:', JSON.stringify(r)))
        .catch((err) => console.warn('[returns-sync] safety-net sync failed:', err?.message));
    }, 60_000);
    setInterval(() => {
      const { syncAllReturns } = require('./services/returns-engine');
      syncAllReturns({ tenantId: 'default', lookbackDays: 30 })
        .then((r) => console.log('[returns-sync] safety-net sync done:', JSON.stringify(r)))
        .catch((err) => console.warn('[returns-sync] safety-net sync failed:', err?.message));
    }, RETURNS_SYNC_INTERVAL_MS);
    console.log(`[returns-sync] safety-net enabled: every ${RETURNS_SYNC_INTERVAL_MS}ms (primary: event-driven)`);
  } catch (err) {
    console.warn('[returns-sync] failed to start safety-net:', err?.message || err);
  }

  // Safety-net: SendCloud parcel sync every 6h (primary: SendCloud webhooks)
  const SENDCLOUD_SYNC_INTERVAL_MS = parseInt(process.env.SENDCLOUD_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  try {
    const runSendCloudSync = () => {
      const { syncSendCloudParcels } = require('./services/shipping-engine');
      const fromDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      return syncSendCloudParcels({ tenantId: 'default', fromDate })
        .then((r) => console.log('[sendcloud-sync] safety-net sync done: matched=%d, unmatched=%d, skipped=%d',
          r.matched?.length || 0, r.unmatched?.length || 0, r.skipped?.length || 0))
        .catch((err) => console.warn('[sendcloud-sync] safety-net sync failed:', err?.message));
    };
    setTimeout(runSendCloudSync, 90_000);
    setInterval(runSendCloudSync, SENDCLOUD_SYNC_INTERVAL_MS);
    console.log(`[sendcloud-sync] safety-net enabled: every ${SENDCLOUD_SYNC_INTERVAL_MS}ms (primary: event-driven)`);
  } catch (err) {
    console.warn('[sendcloud-sync] failed to start safety-net:', err?.message || err);
  }

  // ─── Marketplace Tracking Push Catch-up (every 2h) ──────────
  // Retries failed tracking pushes for shipped orders — prevents marketplace warnings
  try {
    const TRACKING_CATCHUP_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
    const runTrackingCatchup = async () => {
      try {
        const { retryFailedMarketplacePushes } = require('./services/marketplace-tracking');
        const result = await retryFailedMarketplacePushes({ maxAge: 7 });
        if (result.retried > 0) {
          console.log(`[tracking-catchup] retried=${result.retried} succeeded=${result.succeeded} failed=${result.failed}`);
        }
      } catch (err) {
        console.warn('[tracking-catchup] catch-up failed:', err?.message);
      }
    };
    setTimeout(runTrackingCatchup, 120_000); // First run after 2 min
    setInterval(runTrackingCatchup, TRACKING_CATCHUP_INTERVAL_MS);
    console.log(`[tracking-catchup] safety-net enabled: every ${TRACKING_CATCHUP_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[tracking-catchup] failed to start safety-net:', err?.message || err);
  }

  // ─── Invoice Sync: SevDesk Import + Bulk Generate (startup + every 24h) ─
  // On boot: import all existing SevDesk invoices, then generate any missing ones.
  // Runs again every 24h to catch any gaps. Fully idempotent.
  const INVOICE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const runInvoiceSync = async () => {
    try {
      const { importFromSevDesk, bulkGenerateForShippedOrders } = require('./services/invoice-engine');
      const importResult = await importFromSevDesk({ tenantId: 'default' });
      if (importResult.imported > 0 || importResult.matched > 0) {
        console.log(`[invoice-sync] SevDesk import: imported=${importResult.imported} matched=${importResult.matched} skipped=${importResult.skipped}`);
      }
      const genResult = await bulkGenerateForShippedOrders({ tenantId: 'default' });
      if (genResult.generated > 0) {
        console.log(`[invoice-sync] bulk generate: generated=${genResult.generated} skipped=${genResult.skipped} errors=${genResult.errors.length}`);
      }
    } catch (err) {
      console.warn('[invoice-sync] sync failed:', err?.message);
    }
  };
  try {
    setTimeout(runInvoiceSync, 5 * 60 * 1000); // First run 5 min after startup
    setInterval(runInvoiceSync, INVOICE_SYNC_INTERVAL_MS);
    console.log('[invoice-sync] enabled: startup + every 24h');
  } catch (err) {
    console.warn('[invoice-sync] failed to schedule:', err?.message);
  }

  // ─── Marketplace Refund Push (every 4h) ─────────────────────
  // Auto-pushes refunds to eBay/Kaufland for returns in 'erstattet' status
  try {
    const REFUND_PUSH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
    const runRefundPush = async () => {
      try {
        const { runRefundPush: pushRefunds } = require('./services/returns-engine');
        const result = await pushRefunds({ tenantId: 'default' });
        if (result.processed > 0) {
          console.log(`[refund-push] processed=${result.processed} success=${result.success} errors=${result.errors.length}`);
        }
      } catch (err) {
        console.warn('[refund-push] runner failed:', err?.message);
      }
    };
    setTimeout(runRefundPush, 180_000); // First run after 3 min
    setInterval(runRefundPush, REFUND_PUSH_INTERVAL_MS);
    console.log(`[refund-push] safety-net enabled: every ${REFUND_PUSH_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[refund-push] failed to start safety-net:', err?.message || err);
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
