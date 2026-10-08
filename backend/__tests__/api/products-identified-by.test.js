'use strict';

/**
 * GET /api/products/identified-by — "Erfasst von" fuer Mitarbeiter.
 *
 * Betreiber-Anweisung 2026-10-08: der Filter "Erfasst von" in den Produktdaten
 * muss fuer die Mitarbeiter-Rolle verfuegbar sein. Vorher hing die Route an
 * admin.users.read — ein Recht, das ausser dem Inhaber niemand haben kann
 * (es steht nicht im Rechte-Katalog). Jetzt: Produkt-Schreibrecht.
 *
 * Laeuft mit dem ECHTEN Rechte-Resolver (wie access-workflows.test.js), damit
 * die Rollen-Matrix nicht nachgebaut, sondern geprueft wird.
 */

const express = require('express');
const request = require('supertest');
require('./_patchGcp');
require('./_patchLocalModules');
const { firestoreModule } = require('./_setupMocks');

delete require.cache[require.resolve('../../lib/rbac')];
const rbac = require('../../lib/rbac');

// audit_log-Abfrage mitschneiden: welche Filter, welches Limit, welche Sortierung.
const auditCalls = { where: [], orderBy: [], limit: [] };
let auditDocs = [];
const originalCollection = firestoreModule.firestore.collection.getMockImplementation();
firestoreModule.firestore.collection.mockImplementation((name) => {
  if (name === 'accessRolePolicies') {
    return { doc: (id) => ({ id, path: `${name}/${id}`, get: async () => ({ exists: false, data: () => undefined }) }) };
  }
  if (name === 'audit_log') {
    const chain = {
      where: (...args) => { auditCalls.where.push(args); return chain; },
      orderBy: (...args) => { auditCalls.orderBy.push(args); return chain; },
      limit: (n) => { auditCalls.limit.push(n); return chain; },
      get: async () => ({ docs: auditDocs.map((d) => ({ data: () => d })) }),
    };
    return chain;
  }
  return originalCollection(name);
});

const { router } = require('../../routes/products');

rbac.listUsers = async () => [
  { uid: 'u-efe', displayName: 'Efe' },
  { uid: 'u-yasemin', firstName: 'Yasemin', lastName: 'K.' },
];

const profile = { accessRole: 'employee', tenantId: 'default' };
let current = profile;
let email = 'mitarbeiter@trendocean.de';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { uid: 'u-test', email, tenantId: 'default', accessProfile: current }; next(); });
app.use('/api', router);

beforeEach(() => {
  current = { ...profile };
  email = 'mitarbeiter@trendocean.de';
  auditCalls.where.length = 0;
  auditCalls.orderBy.length = 0;
  auditCalls.limit.length = 0;
  auditDocs = [];
});

describe('GET /api/products/identified-by — Zugriff', () => {
  for (const role of ['employee', 'manager']) {
    it(`${role}: darf die Erfasser-Zuordnung laden`, async () => {
      current = { ...profile, accessRole: role };
      const res = await request(app).get('/api/products/identified-by');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  }

  it('Inhaber (admin) darf weiterhin', async () => {
    email = 'admin@trendocean.de';
    current = { tenantId: 'default' };
    expect((await request(app).get('/api/products/identified-by')).status).toBe(200);
  });

  for (const role of ['viewer', 'partner', 'developer']) {
    it(`${role}: bleibt gesperrt (kein Produkt-Schreibrecht)`, async () => {
      current = { ...profile, accessRole: role };
      expect((await request(app).get('/api/products/identified-by')).status).toBe(403);
    });
  }
});

describe('GET /api/products/identified-by — Abfrage und Zuordnung', () => {
  it('liest nur product.identified des Tenants, ohne Kappung', async () => {
    await request(app).get('/api/products/identified-by');
    expect(auditCalls.where).toEqual(expect.arrayContaining([
      ['tenantId', '==', 'default'],
      ['action', '==', 'product.identified'],
    ]));
    // Das alte limit(10000) ueber ALLE Aktionen schnitt die aeltesten Erfassungen ab.
    expect(auditCalls.limit).toEqual([]);
  });

  it('der ERSTE Erfasser gewinnt, unabhaengig von der Lieferreihenfolge', async () => {
    auditDocs = [
      { action: 'product.identified', tenantId: 'default', userId: 'u-yasemin', resourceId: 'p1', timestamp: '2026-09-02T10:00:00.000Z' },
      { action: 'product.identified', tenantId: 'default', userId: 'u-efe', details: { productId: 'p1' }, timestamp: '2026-08-01T10:00:00.000Z' },
      { action: 'product.identified', tenantId: 'default', userId: 'u-yasemin', details: { productId: 'p2' }, timestamp: '2026-09-03T10:00:00.000Z' },
    ];
    const res = await request(app).get('/api/products/identified-by');
    expect(res.body.data).toEqual({
      p1: { uid: 'u-efe', name: 'Efe' },
      p2: { uid: 'u-yasemin', name: 'Yasemin K.' },
    });
  });

  it('System-Eintraege zaehlen nicht, unbekannte Nutzer fallen auf die E-Mail zurueck', async () => {
    auditDocs = [
      { action: 'product.identified', tenantId: 'default', userId: 'system', resourceId: 'p1', timestamp: '2026-08-01T10:00:00.000Z' },
      { action: 'product.identified', tenantId: 'default', userId: 'u-weg', userEmail: 'ehemalig@trendocean.de', resourceId: 'p3', timestamp: '2026-08-01T10:00:00.000Z' },
    ];
    const res = await request(app).get('/api/products/identified-by');
    expect(res.body.data).toEqual({ p3: { uid: 'u-weg', name: 'ehemalig@trendocean.de' } });
  });
});
