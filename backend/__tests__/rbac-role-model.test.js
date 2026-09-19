'use strict';
const { defaultRoles, ROLE_IDS, hasPermission } = require('../lib/rbac');
const profiles = require('../lib/access-profiles');
it('RBAC und Rollen-API verwenden dieselbe verbindliche Policy', () => {
  expect(defaultRoles()).toEqual(profiles.defaultRoles());
  expect(ROLE_IDS).toEqual(profiles.ROLE_IDS);
});
it('nur das Adminprofil hat einen Wildcard-Zugriff', () => {
  for (const role of ROLE_IDS) {
    expect(hasPermission(defaultRoles()[role].permissions, 'admin', 'users.write')).toBe(role === 'admin');
    expect(hasPermission(defaultRoles()[role].permissions, 'settings', 'company.write')).toBe(role === 'admin');
  }
});
it('Mitarbeiter kann Versand ohne allgemeine Konfigurationsrechte', () => {
  const p = defaultRoles().employee.permissions;
  for (const action of ['pick', 'pack', 'ship']) expect(hasPermission(p, 'orders', action)).toBe(true);
  expect(hasPermission(p, 'orders', 'write')).toBe(false);
});
