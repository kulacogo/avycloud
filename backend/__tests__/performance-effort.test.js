const { productCareEvidence } = require('../services/performance-scoreboard');
const update = (uid, id, details) => ({ action: 'product.updated', userId: uid, resourceId: id, details });
describe('Produktpflege nach tatsächlicher Tätigkeit', () => {
  it('zählt Datenkorrektur zusätzlich zur Erfassung, aber nur einmal pro Produkt und Konto', () => {
    const rows = productCareEvidence([
      { action: 'product.identified', userId: 'u', details: { productId: 'p' } },
      update('u', 'p', { changedFields: ['details.description'] }),
      update('u', 'p', { changedFields: ['details.gpsr'] }),
      update('v', 'p', { changedFields: ['identification.brand'] }),
    ]);
    expect(rows.u).toEqual({ productCareEdited: 1, productReady: 0 });
    expect(rows.v.productCareEdited).toBe(1);
  });
  it('wertet Bearbeiten-Öffnen, leere Saves und unklare Altlogs nicht als Anreicherung', () => {
    const rows = productCareEvidence([
      update('u', 'a', { changedFields: [] }),
      update('u', 'b', { changedFields: ['ops.readiness'], changes: [{ field: 'ops.readiness', from: 'pending', to: 'in_progress' }] }),
      update('u', 'c', undefined),
      { action: 'product.created', userId: 'u', resourceId: 'd', details: { changedFields: [] } },
    ]);
    expect(rows.u).toEqual({ productCareEdited: 0, productReady: 0 });
  });
  it('zählt bestätigtes Bereit auch nach Prüfung ohne weitere Datenänderung', () => {
    const ready = { changedFields: ['ops.readiness'], changes: [{ field: 'ops.readiness', from: 'in_progress', to: 'ready' }] };
    const rows = productCareEvidence([update('u', 'a', ready), update('u', 'a', ready), update('u', 'a', { changedFields: ['details.description'] })]);
    expect(rows.u).toEqual({ productCareEdited: 1, productReady: 1 });
  });
  it('unterstellt ohne Statusübergang keinen Bereit-Abschluss', () => {
    const rows = productCareEvidence([
      update('u', 'a', { changedFields: ['ops.readiness'] }),
      update('u', 'b', { changes: [{ field: 'ops.readiness', from: 'ready', to: 'ready' }] }),
    ]);
    expect(rows.u.productReady).toBe(0);
    expect(rows.u.productCareEdited).toBe(0);
  });
  it('ignoriert System, falsche Aktionen, fehlende Produkt-ID und technische Felder', () => {
    const rows = productCareEvidence([
      update('system', 'a', { changedFields: ['details.description'] }),
      update('u', null, { changedFields: ['details.description'] }),
      update('u', 'a', { changedFields: ['ops.revision', 'inventory.quantity'] }),
      { action: 'other', userId: 'u', resourceId: 'b', details: { changedFields: ['details.description'] } },
    ]);
    expect(rows.system).toBeUndefined();
    expect(rows.u.productCareEdited).toBe(0);
  });
});
describe('Audit bildet den tatsächlichen Bereit-Übergang ab', () => {
  let previous, diffProduct;
  const path = require.resolve('../lib/firestore');
  beforeAll(() => { previous = require.cache[path]; require.cache[path] = { exports: { firestore: {} } }; ({ diffProduct } = require('../services/audit-log')); });
  afterAll(() => { if (previous) require.cache[path] = previous; else delete require.cache[path]; });
  it('protokolliert Statuswechsel, nicht bloß neue Bearbeiter-/Zeitstempel', () => {
    const before = { ops: { readiness: 'in_progress', readiness_editor: 'AA', readiness_set_at: 'old' } };
    const after = { ops: { readiness: 'ready', readiness_editor: 'BB', readiness_set_at: 'new' } };
    expect(diffProduct(before, after)).toEqual([{ field: 'ops.readiness', from: 'in_progress', to: 'ready' }]);
    expect(diffProduct(after, { ops: { ...after.ops, readiness_set_at: 'later' } })).toEqual([]);
  });
});
