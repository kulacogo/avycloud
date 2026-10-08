// globals: true in vitest.config.js
'use strict';

/**
 * Vorfall 2026-10-08: Wer ruft syncEbayOrders mit welcher Frische-Schranke und
 * welcher Tagesbudget-Prioritaet?
 *   - Web-Dienst (UI-ausgeloester Hintergrund-Sync): skipIfFreshMs (Default
 *     6 min) + P2 — der Worker importiert ohnehin alle 5 min.
 *   - Worker-Sicherheitsnetz (6 h) ueber dieselbe Funktion: keine Schranke, P1.
 *   - Worker-Fast-Poll (index.js): P0 — der einzige Dauer-Importeur.
 *   - Event-Bus (nach eigenen Status-Uebergaengen): Frische-Schranke + P1.
 */

const fs = require('fs');
const path = require('path');

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true, exports: mockExports, children: [], paths: [],
  };
}

const ebayCalls = [];
const kauflandCalls = [];
patchCjsModule('@google-cloud/firestore', {
  Firestore: function MockFirestore() {
    return { collection: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) };
  },
  FieldValue: {},
});
patchCjsModule('../services/order-intake-ebay', {
  syncEbayOrders: async (args) => { ebayCalls.push(args); return { synced: 0, skipped: 0, total: 0, skippedFresh: args.skipIfFreshMs > 0 }; },
});
patchCjsModule('../services/order-intake-kaufland', {
  syncKauflandOrders: async (args) => { kauflandCalls.push(args); return { synced: 0 }; },
});
let backgroundRole = false;
patchCjsModule('../lib/process-role', { shouldRunBackgroundJobs: () => backgroundRole });

const { syncOrders } = require('../services/order-source-router');

beforeEach(() => { ebayCalls.length = 0; kauflandCalls.length = 0; delete process.env.ORDER_SYNC_EBAY_FRESH_MS; });

describe('order-source-router.syncOrders — Web vs. Worker', () => {
  it('Web-Dienst: Frische-Schranke 6 min + Prioritaet P2, Kaufland unveraendert', async () => {
    backgroundRole = false;
    await syncOrders();
    expect(ebayCalls).toHaveLength(1);
    expect(ebayCalls[0]).toMatchObject({ tenantId: 'default', lookbackDays: 7, skipIfFreshMs: 6 * 60 * 1000, priority: 'P2' });
    expect(kauflandCalls).toHaveLength(1);
    expect(kauflandCalls[0]).toMatchObject({ tenantId: 'default', lookbackDays: 7 });
  });

  it('Worker (Sicherheitsnetz): keine Schranke, Prioritaet P1', async () => {
    backgroundRole = true;
    await syncOrders();
    expect(ebayCalls[0]).toMatchObject({ lookbackDays: 7, skipIfFreshMs: 0, priority: 'P1' });
  });

  it('ORDER_SYNC_EBAY_FRESH_MS steuert die Schranke; 0 schaltet sie ab', async () => {
    backgroundRole = false;
    process.env.ORDER_SYNC_EBAY_FRESH_MS = '0';
    await syncOrders();
    expect(ebayCalls[0].skipIfFreshMs).toBe(0);
  });
});

describe('Quell-Vertrag: Fast-Poll und Event-Bus', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const busSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'sync-event-bus.js'), 'utf8');

  it('Worker-Fast-Poll importiert mit Prioritaet P0 (einziger Dauer-Importeur)', () => {
    expect(indexSrc).toMatch(/syncEbayOrders\(\{\s*tenantId,\s*lookbackDays:\s*1,\s*priority:\s*'P0'\s*\}\)/);
  });

  it('Event-Bus-Sync traegt Frische-Schranke und Prioritaet P1', () => {
    expect(busSrc).toMatch(/syncEbayOrders\(\{\s*tenantId:\s*tenant,\s*lookbackDays:\s*3,\s*skipIfFreshMs:\s*EVENT_SYNC_EBAY_FRESH_MS,\s*priority:\s*'P1'\s*\}\)/);
    expect(busSrc).toMatch(/EVENT_SYNC_EBAY_FRESH_MS\s*=\s*parseInt\(process\.env\.EVENT_SYNC_EBAY_FRESH_MS/);
  });
});
