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
const policyDocuments = new Map();
const originalCollection = firestoreModule.firestore.collection.getMockImplementation();
firestoreModule.firestore.collection.mockImplementation(name => name === 'accessRolePolicies' ? {
  doc: id => ({ id, path: `${name}/${id}`, get: async () => ({ exists: policyDocuments.has(id), data: () => policyDocuments.get(id) }) }),
} : originalCollection(name));
const auditWrites = [];
firestoreModule.firestore.runTransaction.mockImplementation(async work => {
  const writes = [];
  const result = await work({ get: ref => ref.get(), set: (ref, data) => writes.push([ref, data]) });
  for (const [ref, data] of writes) {
    if (ref.path?.startsWith('accessRolePolicies/')) policyDocuments.set(ref.id, data);
    else auditWrites.push(data);
  }
  return result;
});
const invoice = vi.fn().mockResolvedValue({ invoiceNumber: 'TEST-1', total: 119 });
patch('../../services/invoice-engine', { generateInvoice: invoice });
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
let email;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { uid: 'huseyin', email, tenantId: 'default', accessProfile: current }; next(); });
app.use('/api', orders, print, returns, settings);
app.use('/api/admin', admin);

beforeEach(() => {
  current = { ...profile };
  email = 'huseyin.kisaoglu@trendocean.de';
  policyDocuments.clear(); auditWrites.length = 0; invoice.mockClear(); mockDoc.set.mockClear();
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
  it(`${role}: keine Finanzberichte oder Erstattungen; Rechnung nur mit eigenem Recht`, async () => {
    current = { ...profile, accessRole: role };
    expect((await request(app).get('/api/dashboard/finance')).status).toBe(403);
    expect((await request(app).post('/api/orders/order-1/invoice').send({})).status).toBe(role === 'manager' ? 200 : 403);
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


it('Manager erstellt die Rechnung mit MwSt. und eigener Identität, ohne Finanzrechte', async () => {
  current = { ...profile, accessRole: 'manager' };
  email = 'yasemin@trendocean.de';
  const response = await request(app).post('/api/orders/order-1/invoice').send({ vatRate: 0.19 });
  expect(response.status).toBe(200);
  expect(invoice).toHaveBeenCalledWith({ orderId: 'order-1', tenantId: 'default', actor: { uid: 'huseyin', email } });
  expect(mockDoc.set).toHaveBeenCalledWith(expect.objectContaining({ vatRate: 0.19 }), { merge: true });
  expect((await request(app).get('/api/dashboard/finance')).status).toBe(403);
});

it('Rechnung prüft den Tenant vor der MwSt.-Änderung und Generierung', async () => {
  current = { ...profile, accessRole: 'manager' };
  mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ tenantId: 'foreign' }) });
  expect((await request(app).post('/api/orders/order-1/invoice').send({ vatRate: 0.19 })).status).toBe(404);
  expect(mockDoc.set).not.toHaveBeenCalled();
  expect(invoice).not.toHaveBeenCalled();
});

it('Inhaber speichert Rollenrechte mit Audit; Freigabe und Entzug wirken auf die nächste Anfrage', async () => {
  email = 'admin@trendocean.de';
  const permissions = { orders: { read: true }, invoices: { read: true, write: true } };
  const granted = await request(app).put('/api/admin/roles/employee').send({ permissions, revision: 0 });
  expect(granted.status).toBe(200);
  expect(granted.body.data.revision).toBe(1);
  expect(auditWrites).toHaveLength(1);
  expect(auditWrites[0]).toMatchObject({ tenantId: 'default', action: 'role.permissions.update', roleId: 'employee' });
  const roles = (await request(app).get('/api/admin/roles')).body.data;
  expect(roles.find(role => role.id === 'employee')).toMatchObject({ permissions, revision: 1, editable: true });
  email = 'huseyin.kisaoglu@trendocean.de';
  expect((await request(app).post('/api/orders/order-1/invoice').send({})).status).toBe(200);
  expect((await request(app).put('/api/admin/roles/employee').send({ permissions: {}, revision: 1 })).status).toBe(403);
  email = 'admin@trendocean.de';
  expect((await request(app).put('/api/admin/roles/employee').send({ permissions: {}, revision: 1 })).status).toBe(200);
  email = 'huseyin.kisaoglu@trendocean.de';
  expect((await request(app).post('/api/orders/order-1/invoice').send({})).status).toBe(403);
});

it('veraltetes Speichern überschreibt keine neuere Rollenänderung', async () => {
  email = 'admin@trendocean.de';
  const payload = { permissions: {}, revision: 0 };
  expect((await request(app).put('/api/admin/roles/manager').send(payload)).status).toBe(200);
  expect((await request(app).put('/api/admin/roles/manager').send(payload)).status).toBe(409);
  expect(auditWrites).toHaveLength(1);
});

it('Inhaber, Wildcards, Personalverwaltung und unbekannte Rechte bleiben geschützt', async () => {
  email = 'admin@trendocean.de';
  expect((await request(app).put('/api/admin/roles/admin').send({ permissions: {}, revision: 0 })).status).toBe(400);
  for (const permissions of [{ '*': { '*': true } }, { admin: { 'roles.write': true } }, { admin: { 'users.write': true } }, { invoices: { write: true } }, { invoices: { read: 'true' } }, { invented: { read: true } }]) {
    expect((await request(app).put('/api/admin/roles/employee').send({ permissions, revision: 0 })).status).toBe(400);
  }
  expect(policyDocuments.size).toBe(0);
  expect(auditWrites).toHaveLength(0);
});

it('Rollenänderung ist tenantgebunden; defekte Policies geben keine Standardrechte frei', async () => {
  email = 'admin@trendocean.de';
  await request(app).put('/api/admin/roles/manager').send({ permissions: {}, revision: 0 });
  const other = await rbac.resolvePermissionsForUser('manager', { email: 'other@trendocean.de', tenantId: 'other', accessProfile: { tenantId: 'other', accessRole: 'manager' } });
  expect(other.permissions.invoices.write).toBe(true);
  const id = `${Buffer.from('default').toString('base64url')}__manager`;
  policyDocuments.set(id, { ...policyDocuments.get(id), tenantId: 'other' });
  await expect(rbac.resolvePermissionsForUser('manager', { email: 'manager@trendocean.de', accessProfile: { ...profile, accessRole: 'manager' } })).rejects.toThrow('nicht sicher');
  expect((await rbac.resolvePermissionsForUser('owner', { email, accessProfile: profile })).roles).toEqual(['admin']);
});
