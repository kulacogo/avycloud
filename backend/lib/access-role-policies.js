'use strict';

const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');
const { defaultRoles, ROLE_IDS } = require('./access-profiles');
const catalog = require('./access-permission-catalog.json');
const COLLECTION = 'accessRolePolicies';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const entries = catalog.flatMap(m => m.actions.map(a => ({ ...a, module: m.id, key: `${m.id}.${a.action}` })));
const known = new Set(entries.map(e => e.key));

function validatePermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Berechtigungen fehlen.');
  const permissions = {};
  for (const [module, actions] of Object.entries(value)) {
    if (!catalog.some(m => m.id === module) || !actions || typeof actions !== 'object' || Array.isArray(actions)) {
      throw fail('Unbekannter oder geschützter Berechtigungsbereich.');
    }
    permissions[module] = {};
    for (const [action, allowed] of Object.entries(actions)) {
      if (!known.has(`${module}.${action}`) || typeof allowed !== 'boolean') throw fail('Unbekannte oder geschützte Berechtigung.');
      permissions[module][action] = allowed;
    }
  }
  const allowed = key => { const dot = key.indexOf('.'); return permissions[key.slice(0, dot)]?.[key.slice(dot + 1)] === true; };
  for (const entry of entries) {
    if (allowed(entry.key) && entry.requires.some(key => !allowed(key))) throw fail(`Für „${entry.label}“ fehlen erforderliche Leserechte oder Arbeitsrechte.`);
  }
  return permissions;
}

function policyRef(tenantId, roleId) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw fail('Mandant fehlt.');
  if (!ROLE_IDS.includes(roleId) || roleId === 'admin') throw fail('Der Inhaberzugang ist nicht veränderbar.');
  return firestore.collection(COLLECTION).doc(`${Buffer.from(tenantId).toString('base64url')}__${roleId}`);
}

function resolvePolicy(snap, tenantId, roleId) {
  const fallback = { permissions: defaultRoles()[roleId].permissions, revision: 0, customized: false };
  if (!snap.exists) return fallback;
  const policy = snap.data();
  if (policy.tenantId !== tenantId || policy.roleId !== roleId || policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.revision) || policy.revision < 1) {
    throw fail('Rollenrechte konnten nicht sicher geladen werden.', 500);
  }
  return { permissions: validatePermissions(policy.permissions), revision: policy.revision, customized: true };
}

async function getRolePolicy(tenantId, roleId) {
  if (roleId === 'admin') return { permissions: defaultRoles().admin.permissions, revision: 0, customized: false };
  return resolvePolicy(await policyRef(tenantId, roleId).get(), tenantId, roleId);
}

async function saveRolePolicy({ tenantId, roleId, actorUid, patch }) {
  const ref = policyRef(tenantId, roleId);
  if (!actorUid || !patch || Object.keys(patch).some(key => !['permissions', 'revision'].includes(key))) throw fail('Ungültige Rollenänderung.');
  if (!Number.isSafeInteger(patch.revision) || patch.revision < 0) throw fail('Versionsstand fehlt. Bitte neu laden.');
  const permissions = validatePermissions(patch.permissions);
  const auditRef = firestore.collection('auditLogs').doc();
  return firestore.runTransaction(async tx => {
    const before = resolvePolicy(await tx.get(ref), tenantId, roleId);
    if (before.revision !== patch.revision) throw fail('Die Rolle wurde inzwischen geändert. Bitte neu laden.', 409);
    const revision = before.revision + 1;
    const at = FieldValue.serverTimestamp();
    tx.set(ref, { tenantId, roleId, schemaVersion: 1, permissions, revision, updatedBy: actorUid, updatedAt: at });
    tx.set(auditRef, { tenantId, actorUid, action: 'role.permissions.update', roleId,
      diff: { before: before.permissions, after: permissions }, revision, at });
    return { permissions, revision, customized: true };
  });
}

module.exports = { getRolePolicy, saveRolePolicy, validatePermissions };
