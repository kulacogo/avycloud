'use strict';

// One versioned, code-reviewed policy. Firestore role documents, groups and
// per-user wildcards are deliberately NOT authorization inputs anymore.
const ACCESS_POLICY_VERSION = 1;
const ROLE_IDS = ['admin', 'manager', 'employee', 'partner', 'viewer', 'developer'];

function defaultRoles() {
  const read = {
    dashboard: { read: true }, products: { read: true }, categories: { read: true },
    inventories: { read: true }, warehouse: { read: true }, orders: { read: true },
    returns: { read: true },
  };
  const employee = {
    ...read, products: { read: true, write: true }, warehouse: { read: true, write: true },
    orders: { read: true, pick: true, pack: true, ship: true },
    returns: { read: true, process: true }, identify: { run: true },
    ai: { chat: true, improve: true }, jobs: { read: true },
  };
  return {
    admin: { name: 'Administrator', description: 'Inhaber: vollständiger Zugriff, Finanzen und Verwaltung.', permissions: { '*': { '*': true } } },
    manager: {
      name: 'Manager', description: 'Alle operativen Abläufe, Auftragskorrekturen, Regeln und Lagerkonfiguration. Keine Finanzen oder Unternehmensverwaltung.',
      permissions: { ...employee, products: { read: true, write: true, delete: true },
        categories: { read: true, write: true }, warehouse: { read: true, write: true, configure: true },
        orders: { read: true, pick: true, pack: true, ship: true, edit: true, write: true }, rules: { read: true, write: true } },
    },
    employee: { name: 'Mitarbeiter', description: 'Produkte erfassen und pflegen, einlagern, kommissionieren, wiegen, packen, versenden und Labels drucken.', permissions: employee },
    partner: { name: 'Gesellschafter / Partner', description: 'Operative Übersicht und Finanzberichte lesen. Keine Änderungen.', permissions: { ...read, invoices: { read: true }, admin: { 'reports.read': true } } },
    viewer: { name: 'Nur Lesen', description: 'Produkte, Bestellungen und Lager ansehen. Keine Änderungen und keine Finanzberichte.', permissions: read },
    developer: { name: 'Entwickler · Lesen', description: 'Operative Daten und technische Diagnose ansehen. Keine Änderungen, Finanzen, Zugangsdaten oder Personalverwaltung.', permissions: { ...read, rules: { read: true }, jobs: { read: true }, system: { read: true }, integrations: { status: true }, orders: { read: true, 'settings.read': true }, warehouse: { read: true, 'settings.read': true } } },
  };
}

function selectAccessRole(profile, { isOwner = false } = {}) {
  if (isOwner) return 'admin';
  const role = profile?.accessRole;
  return ROLE_IDS.includes(role) && role !== 'admin' ? role : null;
}

function validateRoleAssignment(roles, targetIsOwner) {
  if (!Array.isArray(roles) || roles.length !== 1 || !ROLE_IDS.includes(roles[0])) {
    const error = new Error('Bitte genau ein gültiges Zugriffsprofil wählen.');
    error.statusCode = 400;
    throw error;
  }
  const role = roles[0];
  if ((role === 'admin') !== Boolean(targetIsOwner)) {
    const error = new Error('Das Administratorprofil ist ausschließlich dem Inhaberkonto zugeordnet.');
    error.statusCode = 403;
    throw error;
  }
  return role;
}

module.exports = { ACCESS_POLICY_VERSION, ROLE_IDS, defaultRoles, selectAccessRole, validateRoleAssignment };
