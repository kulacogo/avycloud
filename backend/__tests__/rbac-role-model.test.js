'use strict';

/**
 * RBAC role-model rework (2026-07-03).
 *
 * Root cause of "everyone is admin": only 4 rigid roles, badly cut — a normal
 * worker couldn't do their job without admin. This introduces 6 job-based roles
 * (additive; admin + legacy roles untouched). Each role must grant EVERY
 * permission its job needs and NONE of the dangerous ones — so we test both
 * "darf" and "darf nicht" per role. Pure test over defaultRoles() + hasPermission().
 *
 * Vitest CJS — globals enabled.
 */

const { defaultRoles, hasPermission, ROLE_IDS } = require('../lib/rbac');

const can = (role, mod, action) => hasPermission(defaultRoles()[role].permissions, mod, action);

describe('new job-based roles exist and are assignable', () => {
  it('ROLE_IDS includes the 6 new roles + admin', () => {
    for (const r of ['betrachter', 'lager-versand', 'produktpflege', 'einkauf-bestand', 'buchhaltung', 'leitung', 'admin']) {
      expect(ROLE_IDS).toContain(r);
    }
  });

  it('every new role has a German display name', () => {
    for (const r of ['betrachter', 'lager-versand', 'produktpflege', 'einkauf-bestand', 'buchhaltung', 'leitung']) {
      expect(typeof defaultRoles()[r].name).toBe('string');
      expect(defaultRoles()[r].name.length).toBeGreaterThan(0);
    }
  });
});

describe('betrachter (Basis-Rolle jedes neuen Nutzers)', () => {
  it('darf: nur lesen', () => {
    expect(can('betrachter', 'dashboard', 'read')).toBe(true);
    expect(can('betrachter', 'products', 'read')).toBe(true);
    expect(can('betrachter', 'orders', 'read')).toBe(true);
  });
  it('darf nicht: irgendetwas ändern', () => {
    expect(can('betrachter', 'products', 'write')).toBe(false);
    expect(can('betrachter', 'orders', 'pick')).toBe(false);
    expect(can('betrachter', 'orders', 'ship')).toBe(false);
  });
});

describe('lager-versand (Lager & Versand)', () => {
  it('darf: den kompletten Versand-Weg', () => {
    expect(can('lager-versand', 'orders', 'pick')).toBe(true);
    expect(can('lager-versand', 'orders', 'pack')).toBe(true);
    expect(can('lager-versand', 'orders', 'ship')).toBe(true);
    expect(can('lager-versand', 'orders', 'edit')).toBe(true);
    expect(can('lager-versand', 'warehouse', 'write')).toBe(true);
    expect(can('lager-versand', 'returns', 'process')).toBe(true);
    expect(can('lager-versand', 'invoices', 'read')).toBe(true);
  });
  it('darf nicht: Preise/Produkte, Geld erstatten, Rechnungen schreiben', () => {
    expect(can('lager-versand', 'products', 'write')).toBe(false);
    expect(can('lager-versand', 'returns', 'refund')).toBe(false);
    expect(can('lager-versand', 'invoices', 'write')).toBe(false);
  });
});

describe('produktpflege (Produktpflege)', () => {
  it('darf: Produkte bearbeiten, erfassen, KI, Angebote pflegen', () => {
    expect(can('produktpflege', 'products', 'write')).toBe(true);
    expect(can('produktpflege', 'categories', 'write')).toBe(true);
    expect(can('produktpflege', 'identify', 'run')).toBe(true);
    expect(can('produktpflege', 'ai', 'chat')).toBe(true);
    expect(can('produktpflege', 'integrations', 'read')).toBe(true);
  });
  it('darf nicht: löschen, versenden, Geld', () => {
    expect(can('produktpflege', 'products', 'delete')).toBe(false);
    expect(can('produktpflege', 'orders', 'ship')).toBe(false);
    expect(can('produktpflege', 'returns', 'refund')).toBe(false);
  });
});

describe('einkauf-bestand (Einkauf & Bestand)', () => {
  it('darf: Wareneingang, Bestände, Produkte anlegen', () => {
    expect(can('einkauf-bestand', 'warehouse', 'write')).toBe(true);
    expect(can('einkauf-bestand', 'products', 'write')).toBe(true);
    expect(can('einkauf-bestand', 'inventories', 'read')).toBe(true);
  });
  it('darf nicht: versenden, Rechnungen', () => {
    expect(can('einkauf-bestand', 'orders', 'ship')).toBe(false);
    expect(can('einkauf-bestand', 'invoices', 'write')).toBe(false);
  });
});

describe('buchhaltung (Buchhaltung)', () => {
  it('darf: Rechnungen, Erstattungen freigeben, Finanzzahlen', () => {
    expect(can('buchhaltung', 'invoices', 'write')).toBe(true);
    expect(can('buchhaltung', 'returns', 'refund')).toBe(true);
    expect(can('buchhaltung', 'admin', 'reports.read')).toBe(true);
  });
  it('darf nicht: Produkte ändern, versenden', () => {
    expect(can('buchhaltung', 'products', 'write')).toBe(false);
    expect(can('buchhaltung', 'orders', 'ship')).toBe(false);
  });
});

describe('leitung (Leitung)', () => {
  it('darf: alles Operative inkl. löschen, Marktplätze, Firmendaten, Finanzen', () => {
    expect(can('leitung', 'products', 'delete')).toBe(true);
    expect(can('leitung', 'orders', 'ship')).toBe(true);
    expect(can('leitung', 'invoices', 'write')).toBe(true);
    expect(can('leitung', 'returns', 'refund')).toBe(true);
    expect(can('leitung', 'integrations', 'write')).toBe(true);
    expect(can('leitung', 'settings', 'company.write')).toBe(true);
    expect(can('leitung', 'admin', 'reports.read')).toBe(true);
  });
  it('darf nicht: Mitarbeiter/Rechte verwalten, API-Zugänge', () => {
    expect(can('leitung', 'admin', 'users.write')).toBe(false);
    expect(can('leitung', 'admin', 'roles.write')).toBe(false);
    expect(can('leitung', 'settings', 'write')).toBe(false); // api-keys
  });
});

describe('admin bleibt unverändert (Vollzugriff)', () => {
  it('darf alles (Wildcard)', () => {
    expect(can('admin', 'admin', 'users.write')).toBe(true);
    expect(can('admin', 'anything', 'whatever')).toBe(true);
  });
});
