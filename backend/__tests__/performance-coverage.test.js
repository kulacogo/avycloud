'use strict';
const { sourceCoverage, belongsToTenant } = require('../services/performance-scoreboard');

describe('Leistungsbewertung: Datenabdeckung', () => {
  const start = Date.parse('2026-09-01T00:00:00Z');
  it('unterscheidet bestätigte leere Quellen von unbekannter Abdeckung', () => {
    expect(sourceCoverage([], 10, 'timestamp', start)).toBe('complete');
  });
  it('meldet ein abgeschnittenes Zeitfenster statt vollständiger Nullwerte', () => {
    const docs = [{ timestamp: '2026-09-02T00:00:00Z' }, { timestamp: '2026-09-03T00:00:00Z' }];
    expect(sourceCoverage(docs, 2, 'timestamp', start)).toBe('limited');
    expect(sourceCoverage(docs, 3, 'timestamp', start)).toBe('complete');
  });
  it('akzeptiert ein erreichtes Limit nur wenn die Quelle bis vor den Zeitraum reicht', () => {
    expect(sourceCoverage([{ timestamp: '2026-08-31T23:00:00Z' }], 1, 'timestamp', start)).toBe('complete');
    expect(sourceCoverage([{ timestamp: '2026-09-01T00:00:00Z' }], 1, 'timestamp', start)).toBe('limited');
  });
  it('wertet ungültige Zeitstempel nicht als Beweis für Vollständigkeit', () => {
    expect(sourceCoverage([{ timestamp: 'invalid' }], 2, 'timestamp', start)).toBe('limited');
  });
  it('ordnet historische Ereignisse ohne Mandant nur dem ursprünglichen default zu', () => {
    expect(belongsToTenant({}, 'default')).toBe(true);
    expect(belongsToTenant({}, 'another')).toBe(false);
    expect(belongsToTenant({ tenantId: 'another' }, 'default')).toBe(false);
    expect(belongsToTenant({ meta: { tenantId: 'another' } }, 'another')).toBe(true);
  });
});

describe('getPerformance: tatsächliche Quellenzustände', () => {
  const paths = [require.resolve('../lib/firestore'), require.resolve('../lib/rbac')];
  let previous;
  beforeEach(() => { previous = paths.map((path) => require.cache[path]); });
  afterEach(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  function mockSources({ broken = null, warehouse = [], extraAudit = [] } = {}) {
    const now = new Date().toISOString();
    const values = {
      audit_log: [{ action: 'product.identified', userId: 'u1', resourceId: 'p1', timestamp: now, tenantId: 'default' }, ...extraAudit.map((row) => ({ timestamp: now, tenantId: 'default', ...row }))],
      order_events: [{ toStatus: 'packed', actor: { uid: 'u1' }, timestamp: now }],
      warehouseEvents: warehouse.map((row) => ({ type: 'stock_in', createdAt: now, ...row })),
    };
    const firestore = { collection(name) { const query = { where() { return query; }, orderBy() { return query; }, limit() { return query; }, async get() { if (name === broken) throw new Error('source unavailable'); return { docs: values[name].map((row, index) => ({ id: String(index), data: () => row })) }; } }; return query; } };
    require.cache[paths[0]] = { exports: { firestore } };
    require.cache[paths[1]] = { exports: { listUsers: async () => [{ uid: 'u1', firstName: 'Test', lastName: 'Person' }] } };
  }
  it('liefert belegte Vollständigkeit zusammen mit unveränderten Zählungen', async () => {
    mockSources();
    const { getPerformance } = require('../services/performance-scoreboard');
    const result = await getPerformance();
    expect(result.dataQuality).toEqual({ complete: true, sources: { audit: 'complete', orders: 'complete', warehouse: 'complete' } });
    expect(result.rows[0]).toMatchObject({ uid: 'u1', name: 'Test Person', erfasst: 1, verpackt: 1 });
  });
  it('kennzeichnet eine ausgefallene Quelle, behält aber die verfügbaren Details', async () => {
    mockSources({ broken: 'audit_log' });
    const { getPerformance } = require('../services/performance-scoreboard');
    const result = await getPerformance();
    expect(result.dataQuality.complete).toBe(false);
    expect(result.dataQuality.sources.audit).toBe('unavailable');
    expect(result.rows[0]).toMatchObject({ erfasst: 0, verpackt: 1 });
  });
  it('liefert neue Pflegebelege und Versionskennung neben unveränderten Rohzahlen', async () => {
    mockSources({ extraAudit: [
      { action: 'product.updated', userId: 'u1', resourceId: 'p1', details: { changes: [{ field: 'details.description', from: 'Alt', to: 'Neu' }] } },
      { action: 'product.updated', userId: 'u1', resourceId: 'p2', details: { changedFields: [] } },
    ] });
    const result = await require('../services/performance-scoreboard').getPerformance();
    expect(result.contributionDataVersion).toBe(3);
    expect(result.rows[0]).toMatchObject({ erfasst: 1, angereichert: 2, productCareEdited: 1, productCareOverlap: 1, productReady: 0 });
  });
  it('zählt im Lager weder explizit fremde Mandanten noch deren Meta-Zuordnung', async () => {
    mockSources({ warehouse: [
      { meta: { actor: { uid: 'u1' } } },
      { tenantId: 'another', meta: { actor: { uid: 'u1' } } },
      { meta: { tenantId: 'another', actor: { uid: 'u1' } } },
    ] });
    const { getPerformance } = require('../services/performance-scoreboard');
    const result = await getPerformance();
    expect(result.rows[0].eingelagert).toBe(1);
  });
});

describe('productCareOverlaps: kein doppelter Produktkredit', () => {
  const { productCareOverlaps } = require('../services/performance-scoreboard');
  it('erkennt nur gleiche Produkte desselben Kontos und dedupliziert Saves', () => {
    const overlaps = productCareOverlaps([
      { action: 'product.identified', userId: 'a', resourceId: 'p1' },
      { action: 'product.created', userId: 'a', resourceId: 'p1' },
      { action: 'product.updated', userId: 'a', resourceId: 'p1' },
      { action: 'product.updated', userId: 'a', resourceId: 'p2' },
      { action: 'product.updated', userId: 'b', resourceId: 'p1' },
      { action: 'product.identified', userId: 'a' },
      { action: 'product.created', userId: 'a' },
    ]);
    expect(overlaps.a).toBe(1);
    expect(overlaps.b).toBe(0);
  });
});
