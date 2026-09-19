'use strict';
const { ASSIGNMENTS, buildPlan, migrate } = require('../scripts/migrate-access-profiles');
const profiles = () => ASSIGNMENTS.map(([id, email]) => ({ id, email, roles: ['admin', 'leitung'] }));
it('ordnet die sieben Personen und zwei technischen Konten explizit zu', () => {
  const plan = buildPlan(profiles());
  expect(plan.filter(x => x.patch.accessRole === 'admin')).toHaveLength(1);
  expect(plan.filter(x => x.patch.accessRole === 'manager')).toHaveLength(2);
  expect(plan.filter(x => x.patch.accessRole === 'employee')).toHaveLength(2);
  expect(plan.find(x => x.email === 'support@trendocean.de').patch.disabled).toBe(true);
  expect(plan.find(x => x.email === 'operation@trendocean.de').patch.accessRole).toBe('developer');
  for (const { patch } of plan) { expect(patch.roles).toBeUndefined(); expect(patch.tenantId).toBe('default'); }
});
it('rät bei fehlenden, neuen oder falsch zugeordneten Identitäten nicht', () => {
  expect(() => buildPlan(profiles().slice(1))).toThrow();
  expect(() => buildPlan([...profiles(), { id: 'unknown' }])).toThrow();
  const wrong = profiles(); wrong[0].email = 'not-owner@trendocean.de';
  expect(() => buildPlan(wrong)).toThrow();
  const foreign = profiles(); foreign[1].tenantId = 'other';
  expect(() => buildPlan(foreign)).toThrow();
});
it('Trockenlauf schreibt nichts', async () => {
  const db = { collection: () => ({ doc: id => ({ id }), where: () => ({ get: async () => ({ docs: [] }) }) }), getAll: async () => profiles().map(p => ({ id: p.id, data: () => p })), runTransaction: vi.fn() };
  expect((await migrate({ db })).mode).toBe('dry-run');
  expect(db.runTransaction).not.toHaveBeenCalled();
});
const { operationalDashboardMetrics } = require('../lib/dashboard-access');
it('operatives Dashboard liefert Zählwerte, aber weder Umsatz noch neue Finanzfelder', () => {
  const input = { range: { label: 'Heute' }, orders: { open_current: 3 }, revenue: { total: 500 }, bank: { balance: 1000 }, returns: { value: 100 }, volume_7d: { days: [{ date: '2026-09-19', orders: 4, revenue: 1234, profit: 321 }] } };
  const output = operationalDashboardMetrics(input);
  expect(output.orders.open_current).toBe(3);
  expect(output.volume_7d.days).toEqual([{ date: '2026-09-19', orders: 4 }]);
  expect(output.revenue).toBeUndefined(); expect(output.bank).toBeUndefined(); expect(output.returns).toBeUndefined();
  expect(input.volume_7d.days[0].revenue).toBe(1234);
});
it('vorhandenes Migrationsbackup verhindert ein Überschreiben späterer Zuordnungen', async () => {
  const tx = { getAll: async () => [{ exists: true }, ...profiles().map(p => ({ id: p.id, data: () => p }))], set: vi.fn(), create: vi.fn() };
  const db = { collection: () => ({ doc: id => ({ id }), where: () => ({ get: async () => ({ docs: [] }) }) }), getAll: async () => profiles().map(p => ({ id: p.id, data: () => p })), runTransaction: fn => fn(tx) };
  expect((await migrate({ db, apply: true })).mode).toBe('already-applied');
  expect(tx.set).not.toHaveBeenCalled(); expect(tx.create).not.toHaveBeenCalled();
});
it('unbekannte Tenantkonten stoppen die Umstellung vor jeder Transaktion', async () => {
  const db = { collection: () => ({ doc: id => ({ id }), where: () => ({ get: async () => ({ docs: [{ id: 'new-user' }] }) }) }), runTransaction: vi.fn() };
  await expect(migrate({ db, apply: true })).rejects.toThrow('Neues Konto');
  expect(db.runTransaction).not.toHaveBeenCalled();
});
