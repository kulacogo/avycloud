'use strict';

// Firebase/Firestore/external services are replaced, but Express routes and the
// production permission resolver run unchanged. No blanket allow-all middleware.
const express = require('express');
const request = require('supertest');
const { mockDoc } = require('./_patchGcp');
const { spies: localSpies } = require('./_patchLocalModules');
const { spies: storeSpies, firestoreModule } = require('./_setupMocks');
const patch = (name, exports) => { const p = require.resolve(name); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete require.cache[require.resolve('../../lib/rbac')];
const rbac = require('../../lib/rbac');
const ship = vi.fn().mockResolvedValue({ labelUrl: 'https://labels.invalid/test.pdf', carrier: 'dhl' });
const pack = vi.fn().mockResolvedValue({});
const transition = vi.fn().mockResolvedValue({});
patch('../../services/shipping-engine', { shipOrder: ship });
patch('../../services/order-source-router', { packOrder: pack });
patch('../../services/order-state-machine', { transitionOrder: transition });
const { router: orders } = require('../../routes/orders');
const print = require('../../routes/print');
const returns = require('../../routes/returns');
const admin = require('../../routes/admin');
const settings = require('../../routes/settings');
const profile = { accessRole: 'employee', tenantId: 'default', roles: ['admin'], overrides: { allow: { '*': { '*': true } } } };
let current = profile;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { uid: 'huseyin', email: 'huseyin.kisaoglu@trendocean.de', tenantId: 'default', accessProfile: current }; next(); });
app.use('/api', orders, print, returns, settings);
app.use('/api/admin', admin);

beforeEach(() => {
  current = { ...profile };
  ship.mockClear(); pack.mockClear(); transition.mockClear();
  storeSpies.updateOrder.mockClear();
  mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ tenantId: 'default', orderId: 'order-1', sendcloudParcelId: 1, carrier: 'dhl' }) });
});

it('Mitarbeiter: packen → Gewicht speichern → Label erstellen → drucken, mit eigener Identität', async () => {
  expect((await request(app).post('/api/orders/order-1/pack').send({})).status).toBe(200);
  expect(pack).toHaveBeenCalledWith(expect.objectContaining({ actor: { uid: 'huseyin', email: 'huseyin.kisaoglu@trendocean.de' } }));
  expect((await request(app).put('/api/orders/order-1').send({ weight: 1.25 })).status).toBe(200);
  expect(storeSpies.updateOrder).toHaveBeenCalledWith('order-1', { weight: 1.25 });
  expect((await request(app).post('/api/orders/order-1/ship').send({ weight: 1.25 })).status).toBe(200);
  expect(ship).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', weight: 1.25 }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ actor: { uid: 'huseyin', email: 'huseyin.kisaoglu@trendocean.de' } }));
  expect((await request(app).post('/api/print/jobs').send({ orderId: 'order-1', shipmentId: 'shipment-1' })).status).toBe(200);
});

it('Gewichtsfreigabe erlaubt keine eingeschmuggelte Adressänderung', async () => {
  expect((await request(app).put('/api/orders/order-1').send({ weight: 2, customer: { name: 'Changed' } })).status).toBe(403);
  expect(storeSpies.updateOrder).not.toHaveBeenCalled();
});
it('Gewicht: ungültige Werte und fremder Tenant schreiben nichts', async () => {
  for (const weight of [0, -1, 'abc', '1kg']) expect((await request(app).put('/api/orders/order-1').send({ weight })).status).toBe(400);
  mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ tenantId: 'foreign' }) });
  expect((await request(app).put('/api/orders/order-1').send({ weight: 2 })).status).toBe(404);
  expect(storeSpies.updateOrder).not.toHaveBeenCalled();
});
for (const role of ['viewer', 'partner', 'developer']) {
  it(`${role}: Versand und Bearbeitungen bleiben gesperrt, auch mit alter Adminrolle`, async () => {
    current = { ...profile, accessRole: role };
    expect((await request(app).put('/api/orders/order-1').send({ weight: 2 })).status).toBe(403);
    expect((await request(app).post('/api/orders/order-1/pack').send({})).status).toBe(403);
    expect((await request(app).post('/api/orders/order-1/ship').send({})).status).toBe(403);
    expect((await request(app).post('/api/print/jobs').send({})).status).toBe(403);
    expect(ship).not.toHaveBeenCalled();
  });
}
for (const role of ['employee', 'manager', 'developer', 'viewer']) {
  it(`${role}: keine Bankdaten, Rechnungen oder Erstattungen über Nebenpfade`, async () => {
    current = { ...profile, accessRole: role };
    expect((await request(app).get('/api/dashboard/finance')).status).toBe(403);
    expect((await request(app).post('/api/orders/order-1/invoice').send({})).status).toBe(403);
    expect((await request(app).post('/api/returns/bulk-action').send({ action: 'refund', returnIds: ['ret-1'] })).status).toBe(403);
    expect((await request(app).patch('/api/returns/ret-1').send({ status: 'erstattet' })).status).toBe(403);
  });
}
it('deaktiviertes Sammelkonto und Profil eines anderen Tenants sind gesperrt', async () => {
  current = { ...profile, disabled: true };
  expect((await request(app).put('/api/orders/order-1').send({ weight: 2 })).status).toBe(403);
  current = { ...profile, tenantId: 'foreign' };
  expect((await request(app).put('/api/orders/order-1').send({ weight: 2 })).status).toBe(403);
});
it('alte Einzel-Ausnahmen und Gruppen sind keine Autorisierungsquelle', async () => {
  const resolved = await rbac.resolvePermissionsForUser('huseyin', { email: 'huseyin.kisaoglu@trendocean.de', accessProfile: { ...profile, groupIds: ['admins'] } });
  expect(resolved.roles).toEqual(['employee']);
  expect(rbac.hasPermission(resolved.permissions, 'admin', 'users.write')).toBe(false);
});
it('Owner wird anhand verifizierter Identität erkannt; disabled gewinnt auch dort', async () => {
  const identity = { email: 'admin@trendocean.de', accessProfile: { roles: [], tenantId: 'default' } };
  expect((await rbac.resolvePermissionsForUser('owner', identity)).roles).toEqual(['admin']);
  await expect(rbac.resolvePermissionsForUser('owner', { ...identity, accessProfile: { disabled: true } })).rejects.toThrow('Account disabled');
  expect((await rbac.resolvePermissionsForUser('attacker', { email: 'other@trendocean.de', accessProfile: { email: 'admin@trendocean.de', accessRole: 'admin' } })).roles).toEqual([]);
});

for (const role of ['employee', 'manager', 'partner', 'viewer', 'developer']) {
  it(`${role}: Verwaltungs-APIs bleiben auch direkt gesperrt`, async () => {
    current = { ...profile, accessRole: role };
    expect((await request(app).get('/api/admin/users')).status).toBe(403);
    expect((await request(app).put('/api/admin/users/target/roles').send({ roles: ['admin'] })).status).toBe(403);
    expect((await request(app).put('/api/settings/company').send({ name: 'Changed' })).status).toBe(403);
    expect((await request(app).post('/api/admin/financials/cost-model').send({ mode: 'x' })).status).toBe(403);
  });
}
it('Finanzwerte werden auch in operativen Antworten entfernt und dürfen nicht eingeschmuggelt werden', async () => {
  const { stripFinancialFields, containsFinancialWrite } = require('../../lib/financial-access');
  const data = { product: { details: { pricing: { buyPrice: 12, sellPrice: 25 } } }, lots: [{ ekBrutto: 100, note: 'A' }] };
  expect(stripFinancialFields(data)).toEqual({ product: { details: { pricing: { sellPrice: 25 } } }, lots: [{ note: 'A' }] });
  expect(data.product.details.pricing.buyPrice).toBe(12);
  expect(containsFinancialWrite({ updates: [{ field: 'details.pricing.buyPrice', value: 1 }] })).toBe(true);
  expect(containsFinancialWrite({ mapping: [{ targetField: 'buyPrice' }] })).toBe(true);
  expect(containsFinancialWrite({ details: { pricing: { sellPrice: 12 } } })).toBe(false);
});
