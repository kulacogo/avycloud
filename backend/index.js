const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { generalLimiter } = require('./lib/rate-limit');
const requestLogger = require('./lib/request-logger');
const { syncProductToBaseLinker } = require('./lib/baselinker');
const { syncInventoriesFromBaseLinker } = require('./services/inventory-sync');
const { startJobRunner } = require('./services/job-runner');
const { startImproveRunner } = require('./services/improve-runner');
const { startQualityRunner } = require('./services/quality-runner');
const { startBaseLinkerSyncRunner } = require('./services/baselinker-sync-runner');
const { startRulebookRunner } = require('./services/rulebook-runner');
const { startAdminBulkRunner } = require('./services/admin-bulk-runner');
const { router: warehouseRouter, setBackgroundSync: setWarehouseBackgroundSync } = require('./routes/warehouse');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { router: ordersRouter, setBackgroundSyncOrders } = require('./routes/orders');
const identifyRouter = require('./routes/identify');
const { router: productsRouter, setBackgroundSyncProductStock } = require('./routes/products');
const marketplaceRouter = require('./routes/marketplace');
const { syncNewOrders } = require('./services/order-sync');
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
const BASELINKER_AUTO_STOCK_SYNC = (process.env.BASELINKER_AUTO_STOCK_SYNC ?? 'true') === 'true';
const BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS = parseInt(
  process.env.BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS || '15000',
  10
);
const lastAutoStockSyncAtMs = new Map(); // productId -> epoch ms

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

  syncNewOrders()
    .catch((err) => console.warn('Background order sync failed:', err?.message || err))
    .finally(() => {
      clearTimeout(timer);
      ordersSyncInFlight = false;
    });
}

function backgroundSyncProductStockToBaseLinker(product, reason = 'warehouse') {
  if (!BASELINKER_AUTO_STOCK_SYNC) return;
  const productId = product?.id ? String(product.id) : null;
  if (!productId) return;

  // Only auto-sync products that are linked/synced to BaseLinker to avoid creating accidental listings
  const hasLink = Boolean(product?.ops?.base_product_id || product?.ops?.baselinker?.product_id);
  if (!hasLink) return;

  const now = Date.now();
  const last = Number(lastAutoStockSyncAtMs.get(productId) || 0);
  if (Number.isFinite(last) && now - last < BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS) {
    return;
  }
  lastAutoStockSyncAtMs.set(productId, now);

  const invId = process.env.BASELINKER_INVENTORY_ID || '78659';
  // Best-effort background sync; never block warehouse ops responses
  setTimeout(() => {
    syncProductToBaseLinker(product, invId)
      .then((result) => {
        console.log(
          `[auto-sync-baselinker] reason=${reason} product=${productId} status=${result?.status || 'unknown'}`
        );
      })
      .catch((err) => {
        console.warn(
          `[auto-sync-baselinker] failed reason=${reason} product=${productId}:`,
          err?.message || err
        );
      });
  }, 0);
}

// Inject backgroundSync into warehouse router
setWarehouseBackgroundSync(backgroundSyncProductStockToBaseLinker);

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
startBaseLinkerSyncRunner();
startRulebookRunner();
try {
  startAdminBulkRunner();
} catch (e) {
  console.warn('[AdminBulkRunner] failed to start (non-blocking):', e?.message || e);
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
syncInventoriesFromBaseLinker()
  .then((result) => {
    console.log(`Initial inventory sync completed (${result.fetched} entries)`);
  })
  .catch((error) => {
    console.error('Initial inventory sync failed:', error);
  });


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

// --- Extracted Routers ---
app.use('/api/warehouse', warehouseRouter);

// --- Public Auth API (extracted router, no auth required) ---
app.use('/api/auth', authRouter);

// Default-deny: everything under /api requires authentication by default.
// Allowlist endpoints that must be public for technical reasons (e.g., <img src> cannot send headers).
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/image-proxy') return next();
  return requireAuth(req, res, next);
});

// --- Extracted Routers (authenticated) ---
app.use('/api/admin', adminRouter);
app.use('/api', ordersRouter);
app.use('/api', identifyRouter);
app.use('/api', productsRouter);
app.use('/api', marketplaceRouter);
setBackgroundSyncOrders(backgroundSyncOrders);
setBackgroundSyncProductStock(backgroundSyncProductStockToBaseLinker);

// --- Centralized Error Handler ---
const { errorHandler } = require('./lib/error-handler');
app.use(errorHandler);

// --- Server Start ---
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);

  // Best-effort periodic order status refresh so BaseLinker-internal status changes
  // (e.g. "Versendet") are reflected in AvyCloud without requiring user interaction.
  const ORDER_SYNC_INTERVAL_MS = parseInt(process.env.ORDER_SYNC_INTERVAL_MS || String(2 * 60 * 60 * 1000), 10);
  try {
    setTimeout(() => backgroundSyncOrders(), 10_000);
    setInterval(() => backgroundSyncOrders(), ORDER_SYNC_INTERVAL_MS);
    console.log(`[order-sync] periodic refresh enabled: every ${ORDER_SYNC_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[order-sync] failed to start periodic refresh:', err?.message || err);
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
