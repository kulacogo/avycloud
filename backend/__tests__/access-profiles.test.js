'use strict';

const { defaultRoles, ROLE_IDS, selectAccessRole, validateRoleAssignment } = require('../lib/access-profiles');
const can = (role, module, action) => {
  const p = defaultRoles()[role].permissions;
  return p['*']?.['*'] === true || p[module]?.[action] === true;
};

describe('Verbindliche Zugriffsprofile', () => {
  it('hat sechs eindeutige Profile statt addierter Altrollen', () => {
    expect(ROLE_IDS).toEqual(['admin', 'manager', 'employee', 'partner', 'viewer', 'developer']);
  });
  for (const role of ['employee', 'manager']) {
    it(`${role}: kompletter Arbeitstag ohne Admin`, () => {
      for (const [m, a] of [['products','read'], ['products','write'], ['identify','run'], ['warehouse','read'], ['warehouse','write'], ['orders','read'], ['orders','pick'], ['orders','pack'], ['orders','ship']]) {
        expect(can(role, m, a), `${role}: ${m}.${a}`).toBe(true);
      }
    });
    it(`${role}: keine Finanz- und Verwaltungsrechte`, () => {
      for (const [m, a] of [['admin','reports.read'], ['admin','reports.write'], ['invoices','write'], ['returns','refund'], ['settings','company.write'], ['admin','users.write'], ['admin','roles.write'], ['integrations','write']]) {
        expect(can(role, m, a), `${role}: ${m}.${a}`).toBe(false);
      }
    });
  }
  it('Manager darf operative Konfiguration, Mitarbeiter nicht', () => {
    for (const [m,a] of [['orders','write'], ['warehouse','configure'], ['products','delete'], ['rules','write']]) {
      expect(can('manager', m, a)).toBe(true);
      expect(can('employee', m, a)).toBe(false);
    }
  });
  it('Partner und Betrachter erhalten ausschließlich Leserechte', () => {
    for (const role of ['partner', 'viewer', 'developer']) {
      for (const actions of Object.values(defaultRoles()[role].permissions)) {
        expect(Object.keys(actions).every(a => a === 'read' || a === 'status' || a.endsWith('.read'))).toBe(true);
      }
    }
    expect(can('partner', 'admin', 'reports.read')).toBe(true);
    expect(can('viewer', 'admin', 'reports.read')).toBe(false);
  });
  it('allein das bestätigte Inhaberkonto erhält Admin', () => {
    expect(selectAccessRole({ accessRole: 'employee' }, { isOwner: true })).toBe('admin');
    expect(selectAccessRole({ accessRole: 'admin' }, { isOwner: false })).toBe(null);
    expect(selectAccessRole({ roles: ['admin', 'leitung'], overrides: { allow: { '*': { '*': true } } } }, { isOwner: false })).toBe(null);
    expect(selectAccessRole({ accessRole: 'employee', roles: ['admin'] }, { isOwner: false })).toBe('employee');
  });
  it('Rollenvergabe verhindert Mehrfachrollen, Altrollen und zweiten Admin', () => {
    expect(() => validateRoleAssignment(['employee', 'manager'], false)).toThrow();
    expect(() => validateRoleAssignment(['leitung'], false)).toThrow();
    expect(() => validateRoleAssignment(['admin'], false)).toThrow();
    expect(() => validateRoleAssignment(['employee'], true)).toThrow();
    expect(validateRoleAssignment(['employee'], false)).toBe('employee');
    expect(validateRoleAssignment(['admin'], true)).toBe('admin');
  });
});
