// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Kaufland-Tracking-Push: Teilfehler ist KEIN Erfolg.
//
// Vorher: pushTrackingToKaufland meldete ok:true sobald EINE Unit durchging
// (nur successCount === 0 galt als Fehler). marketplacePush.status wurde
// 'success', ensureMarketplaceTrackingPushed und der Catchup-Cron skippen
// 'success' → die fehlgeschlagene Unit wurde NIE nachgemeldet. Kaufland sah
// kein Versand-Confirm, Auto-Cancel + Refund trotz physisch versendeter Ware.
//
// Seit Fix: ok:false sobald irgendeine Unit fehlschlägt (mit failedUnitIds),
// bereits-versendete Units zählen beim Retry als Erfolg (Idempotenz).

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

let unitBehavior = {}; // unitId → 'ok' | Error-Message
const kauflandRequest = vi.fn(async (method, path) => {
  const m = path.match(/order-units\/(.+?)\/(send|cancel)/);
  if (m) {
    const behavior = unitBehavior[m[1]];
    if (behavior && behavior !== 'ok') throw new Error(behavior);
    return { data: {} };
  }
  return { data: {} };
});

patchCjsModule('../lib/kaufland-api', { kauflandRequest });

const {
  pushTrackingToKaufland,
  cancelOrderOnKaufland,
  isKauflandUnitAlreadyDone,
} = require('../services/marketplace-tracking');

const ORDER = {
  marketplaceOrderId: 'KL-100',
  items: [
    { sku: 'SKU-A', unitId: 'unit-1' },
    { sku: 'SKU-B', unitId: 'unit-2' },
  ],
};

beforeEach(() => {
  unitBehavior = {};
  kauflandRequest.mockClear();
});

describe('pushTrackingToKaufland: Teilfehler', () => {
  it('meldet ok:false wenn eine von zwei Units fehlschlägt', async () => {
    unitBehavior = { 'unit-1': 'ok', 'unit-2': 'Kaufland 500 Internal Error' };

    const result = await pushTrackingToKaufland({
      order: ORDER, trackingNumber: 'TRACK1', carrier: 'DHL',
    });

    expect(result.ok).toBe(false);
    expect(result.unitsShipped).toBe(1);
    expect(result.failedUnitIds).toEqual(['unit-2']);
    expect(result.error).toContain('unit-2');
  });

  it('meldet ok:true wenn alle Units durchgehen', async () => {
    const result = await pushTrackingToKaufland({
      order: ORDER, trackingNumber: 'TRACK1', carrier: 'DHL',
    });
    expect(result.ok).toBe(true);
    expect(result.unitsShipped).toBe(2);
  });

  it('Retry konvergiert: bereits versendete Unit zählt als Erfolg', async () => {
    unitBehavior = { 'unit-1': "Order unit is already in status 'sent'", 'unit-2': 'ok' };

    const result = await pushTrackingToKaufland({
      order: ORDER, trackingNumber: 'TRACK1', carrier: 'DHL',
    });

    expect(result.ok).toBe(true);
    expect(result.unitsShipped).toBe(2);
  });
});

describe('cancelOrderOnKaufland: Teilfehler', () => {
  it('meldet ok:false wenn eine Unit-Stornierung fehlschlägt', async () => {
    unitBehavior = { 'unit-1': 'ok', 'unit-2': 'Kaufland 502 Bad Gateway' };

    const result = await cancelOrderOnKaufland({ order: ORDER, reason: 'other' });

    expect(result.ok).toBe(false);
    expect(result.unitsCancelled).toBe(1);
    expect(result.failedUnitIds).toEqual(['unit-2']);
  });

  it('bereits stornierte Unit zählt als Erfolg', async () => {
    unitBehavior = { 'unit-1': 'Unit already cancelled', 'unit-2': 'ok' };

    const result = await cancelOrderOnKaufland({ order: ORDER, reason: 'other' });

    expect(result.ok).toBe(true);
    expect(result.unitsCancelled).toBe(2);
  });
});

describe('isKauflandUnitAlreadyDone', () => {
  it.each([
    ["Order unit is already in status 'sent'", 'sent', true],
    ['unit already shipped', 'sent', true],
    ['Unit already cancelled', 'cancelled', true],
    ["Order unit is in status 'cancelled'", 'cancelled', true],
    ['Kaufland 500 Internal Error', 'sent', false],
    ['rate limit exceeded', 'sent', false],
    // "not allowed" heißt: Unit ist in einem ANDEREN Status → Fehler:
    ["Status transition to 'cancelled' is not allowed", 'cancelled', false],
    // 'sent'-Target darf cancelled-Status NICHT als erledigt werten:
    ["Order unit is already in status 'cancelled'", 'sent', false],
  ])('%s (%s) → %s', (msg, target, expected) => {
    expect(isKauflandUnitAlreadyDone(msg, target)).toBe(expected);
  });
});
