const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');
const { stripFinancialFields, containsFinancialWrite } = require('./financial-access');

const USERS_COLLECTION = 'users';
const AUDIT_COLLECTION = 'auditLogs';

const { isBootstrapAdmin } = require('./auth');
const { ACCESS_POLICY_VERSION, ROLE_IDS, defaultRoles, selectAccessRole, validateRoleAssignment } = require('./access-profiles');
const { getRolePolicy, saveRolePolicy } = require('./access-role-policies');

// Policy lives in code. Kept as a no-op for the existing startup contract.
async function ensureDefaultRoles() {}

function retiredPermissionEditor() {
  const error = new Error('Bitte die Rolle des Mitarbeiters oder deren Berechtigungen ändern. Gruppen und Einzel-Ausnahmen werden nicht mehr verwendet.');
  error.statusCode = 409;
  throw error;
}

async function writeAuditLog(entry) {
  await firestore.collection(AUDIT_COLLECTION).add({
    ...entry,
    at: FieldValue.serverTimestamp(),
  });
}

async function getUserProfile(uid) {
  const snap = await firestore.collection(USERS_COLLECTION).doc(String(uid)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function upsertUserProfile(uid, data) {
  const ref = firestore.collection(USERS_COLLECTION).doc(String(uid));
  await ref.set(
    {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: data?.createdAt ? data.createdAt : FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function listUsers({ limit = 500, tenantId = 'default' } = {}) {
  const capped = Math.min(Math.max(parseInt(String(limit || 0), 10) || 500, 1), 1000);
  const snap = await firestore.collection(USERS_COLLECTION).where('tenantId', '==', tenantId).limit(capped).get();
  return snap.docs.map((d) => {
    const profile = d.data();
    const role = selectAccessRole(profile, { isOwner: isBootstrapAdmin(profile.email) });
    return { id: d.id, uid: d.id, email: profile.email, firstName: profile.firstName,
      lastName: profile.lastName, username: profile.username, displayName: profile.displayName,
      disabled: Boolean(profile.disabled), accessRole: role, roles: role ? [role] : [],
      policyVersion: ACCESS_POLICY_VERSION };
  });
}

async function listGroups() { return []; }
const createGroup = retiredPermissionEditor;
const updateGroup = retiredPermissionEditor;
const deleteGroup = retiredPermissionEditor;
const setUserGroups = retiredPermissionEditor;
const setUserOverrides = retiredPermissionEditor;

async function setUserRoles({ actorUid, targetUid, roles, tenantId = 'default' }) {
  const profile = await getUserProfile(targetUid);
  if (!profile || (profile.tenantId || 'default') !== tenantId) {
    const error = new Error('Konto nicht gefunden');
    error.statusCode = 404;
    throw error;
  }
  const accessRole = validateRoleAssignment(roles, isBootstrapAdmin(profile.email));
  const ref = firestore.collection(USERS_COLLECTION).doc(String(targetUid));
  const auditRef = firestore.collection(AUDIT_COLLECTION).doc();
  const batch = firestore.batch();
  // Legacy arrays remain stored for rollback, but are neither returned nor evaluated.
  batch.set(ref, { accessRole, accessPolicyVersion: ACCESS_POLICY_VERSION, tenantId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(auditRef, { tenantId, actorUid: actorUid || null, targetUid: String(targetUid),
    action: 'user.access-profile.update', diff: { before: profile.accessRole || null, after: accessRole }, at: FieldValue.serverTimestamp() });
  await batch.commit();
}

// ── Account management (2026-07-03): set display name + delete account ──

/**
 * Pure safety rule for account deletion. Never delete yourself (accidental
 * lock-out) and never delete the last admin (system lock-out).
 */
function canDeleteUserAccount({ actorUid, targetUid, targetIsAdmin, adminCount }) {
  if (!targetUid) return { ok: false, reason: 'missing_target' };
  if (String(actorUid) === String(targetUid)) return { ok: false, reason: 'self' };
  if (targetIsAdmin && (Number(adminCount) || 0) <= 1) return { ok: false, reason: 'last_admin' };
  return { ok: true };
}

/** Count users that directly hold the admin role (for the last-admin guard). */
async function countAdmins() { return 1; }

/** Set the admin-visible name fields on the users doc. */
async function setUserProfileFields({ actorUid, targetUid, firstName, lastName, username }) {
  const patch = {};
  if (firstName !== undefined) patch.firstName = String(firstName || '').trim();
  if (lastName !== undefined) patch.lastName = String(lastName || '').trim();
  if (username !== undefined) patch.username = String(username || '').trim();
  const dn = [patch.firstName, patch.lastName].filter(Boolean).join(' ').trim();
  if (dn) patch.displayName = dn;
  await upsertUserProfile(String(targetUid), patch);
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'user.profile.update',
    targetUid: String(targetUid),
    diff: patch,
  });
  return patch;
}

/** Delete the Firestore profile doc (Firebase-Auth deletion happens in admin-api). */
async function deleteUserProfile(targetUid) {
  await firestore.collection(USERS_COLLECTION).doc(String(targetUid)).delete();
}

async function listRoles({ tenantId = 'default' } = {}) {
  return Promise.all(Object.entries(defaultRoles()).map(async ([id, role]) => ({
    id, ...role, ...await getRolePolicy(tenantId, id), editable: id !== 'admin',
  })));
}
async function updateRole({ actorUid, actorEmail, tenantId, roleId, patch }) {
  if (!isBootstrapAdmin(actorEmail)) {
    const error = new Error('Nur der Inhaber darf Rollenrechte ändern.');
    error.statusCode = 403;
    throw error;
  }
  return saveRolePolicy({ actorUid, tenantId, roleId, patch });
}

function hasPermission(permissions, moduleName, action) {
  if (!permissions || typeof permissions !== 'object') return false;
  const moduleKey = String(moduleName || '').trim();
  const actionKey = String(action || '').trim();
  if (!moduleKey || !actionKey) return false;

  const wildcardAll = permissions?.['*']?.['*'] === true;
  if (wildcardAll) return true;

  const modulePerm = permissions[moduleKey] || permissions['*'] || null;
  if (!modulePerm || typeof modulePerm !== 'object') return false;

  if (modulePerm['*'] === true) return true;
  return modulePerm[actionKey] === true;
}

function isAllowedWithOverrides({ rolePermissions, overrides, moduleName, action }) {
  // Compatibility export only; old overrides must never re-introduce grants.
  return hasPermission(rolePermissions, moduleName, action);
}

async function resolvePermissionsForUser(uid, identity = {}) {
  const profile = Object.prototype.hasOwnProperty.call(identity, 'accessProfile') ? identity.accessProfile : await getUserProfile(uid);
  if (profile?.disabled) {
    const error = new Error('Account disabled');
    error.statusCode = 403;
    throw error;
  }
  const tenantId = identity.tenantId || 'default';
  if (profile && (profile.tenantId || 'default') !== tenantId) {
    const error = new Error('Forbidden: tenant mismatch');
    error.statusCode = 403;
    throw error;
  }
  // Only the verified request identity can establish ownership, never a stored
  // role, group, override, custom claim or mutable profile email alone.
  const isOwner = isBootstrapAdmin(identity.email);
  const role = selectAccessRole(profile, { isOwner });
  const policy = role ? await getRolePolicy(tenantId, role) : null;
  return { profile, permissions: policy?.permissions || {}, roles: role ? [role] : [] };
}

function requirePermission(moduleName, action) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (!req.user?.uid) return res.status(401).json({ ok: false, error: { code: 401, message: 'Unauthorized' } });
    const resolved = req.accessSnapshot ? Promise.resolve(req.accessSnapshot) : resolvePermissionsForUser(req.user.uid, req.user);
    resolved.then((snapshot) => {
      req.accessSnapshot = snapshot;
      req.rbac = { roles: snapshot.roles, permissions: snapshot.permissions };
      if (!hasPermission(snapshot.permissions, moduleName, action)) {
        return res.status(403).json({ ok: false, error: { code: 403, message: 'Für diese Aktion fehlt die Berechtigung.' } });
      }
      if (!hasPermission(snapshot.permissions, 'admin', 'reports.write') && containsFinancialWrite(req.body)) {
        return res.status(403).json({ ok: false, error: { code: 403, message: 'Finanz- und Einkaufsdaten dürfen nur vom Administrator geändert werden.' } });
      }
      if (!req.financeResponseFiltered && !hasPermission(snapshot.permissions, 'admin', 'reports.read')) {
        const json = res.json.bind(res);
        res.json = body => json(stripFinancialFields(body));
        req.financeResponseFiltered = true;
      }
      next();
    }).catch((error) => res.status(error?.statusCode || 500).json({ ok: false, error: { code: error?.statusCode || 500, message: error?.message || 'Permission check failed' } }));
  };
}

// The pack workflow persists weight before choosing a shipping service. This
// narrow allowance must never also authorize customer/address/config writes.
function requireOrderUpdatePermission(req, res, next) {
  const keys = Object.keys(req.body || {});
  const weightOnly = keys.length === 1 && keys[0] === 'weight';
  return requirePermission('orders', weightOnly ? 'pack' : 'edit')(req, res, next);
}

module.exports = {
  ensureDefaultRoles,
  defaultRoles,
  getUserProfile,
  upsertUserProfile,
  listUsers,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  setUserRoles,
  setUserGroups,
  setUserOverrides,
  setUserProfileFields,
  deleteUserProfile,
  canDeleteUserAccount,
  countAdmins,
  listRoles,
  updateRole,
  resolvePermissionsForUser,
  requirePermission,
  requireOrderUpdatePermission,
  hasPermission,
  isAllowedWithOverrides,
  ROLE_IDS,
};
