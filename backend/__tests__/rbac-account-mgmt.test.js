'use strict';

/**
 * Account management (2026-07-03): the owner could not delete accounts or set
 * names. Adds delete + profile-name endpoints. The load-bearing part is the
 * delete-safety rule (never delete yourself, never delete the last admin) —
 * tested here as a pure function.
 */

const fs = require('fs');
const path = require('path');
const { canDeleteUserAccount } = require('../lib/rbac');

describe('canDeleteUserAccount (Lösch-Sicherheit)', () => {
  it('verweigert Selbst-Löschen', () => {
    expect(canDeleteUserAccount({ actorUid: 'u1', targetUid: 'u1', targetIsAdmin: false, adminCount: 3 }))
      .toEqual({ ok: false, reason: 'self' });
  });
  it('verweigert den letzten Administrator', () => {
    expect(canDeleteUserAccount({ actorUid: 'u1', targetUid: 'u2', targetIsAdmin: true, adminCount: 1 }))
      .toEqual({ ok: false, reason: 'last_admin' });
  });
  it('erlaubt das Löschen eines von mehreren Admins', () => {
    expect(canDeleteUserAccount({ actorUid: 'u1', targetUid: 'u2', targetIsAdmin: true, adminCount: 2 }))
      .toEqual({ ok: true });
  });
  it('erlaubt das Löschen eines normalen Nutzers', () => {
    expect(canDeleteUserAccount({ actorUid: 'u1', targetUid: 'u2', targetIsAdmin: false, adminCount: 1 }))
      .toEqual({ ok: true });
  });
  it('verweigert ohne Ziel', () => {
    expect(canDeleteUserAccount({ actorUid: 'u1', targetUid: '', targetIsAdmin: false, adminCount: 2 }).ok).toBe(false);
  });
});

describe('admin account-mgmt endpoints exist and are gated (users.write)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  it('DELETE /users/:uid requires admin.users.write', () => {
    expect(/router\.delete\(\s*['"]\/users\/:uid['"][\s\S]{0,140}?requirePermission\(\s*['"]admin['"]\s*,\s*['"]users\.write['"]\s*\)/.test(src)).toBe(true);
  });
  it('PUT /users/:uid/profile requires admin.users.write', () => {
    expect(/router\.put\(\s*['"]\/users\/:uid\/profile['"][\s\S]{0,140}?requirePermission\(\s*['"]admin['"]\s*,\s*['"]users\.write['"]\s*\)/.test(src)).toBe(true);
  });
});
