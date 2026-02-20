const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');

const USERS_COLLECTION = 'users';
const ROLES_COLLECTION = 'roles';
const GROUPS_COLLECTION = 'groups';
const AUDIT_COLLECTION = 'auditLogs';

const ROLE_IDS = ['admin', 'manager', 'operation', 'catalog'];

function normalizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const defaultRoles = () => ({
  admin: {
    name: 'Admin',
    permissions: { '*': { '*': true } },
  },
  manager: {
    name: 'Manager',
    permissions: {
      dashboard: { read: true },
      products: { read: true },
    },
  },
  operation: {
    name: 'Operation',
    permissions: {
      dashboard: { read: true },
      products: { read: true },
      inventories: { read: true },
      warehouse: { read: true, write: true },
      orders: { read: true, pick: true, pack: true },
      baselinker: { read: true },
      identify: { run: true },
      jobs: { read: true },
    },
  },
  catalog: {
    name: 'Catalog',
    permissions: {
      dashboard: { read: true },
      products: { read: true, write: true, delete: true },
      categories: { read: true, write: true },
      baselinker: { read: true, sync: true },
      identify: { run: true },
      jobs: { read: true },
      ai: { chat: true, improve: true },
    },
  },
});

async function ensureDefaultRoles() {
  const roles = defaultRoles();
  await Promise.all(
    ROLE_IDS.map(async (roleId) => {
      const ref = firestore.collection(ROLES_COLLECTION).doc(roleId);
      const snap = await ref.get();
      if (snap.exists) return;
      await ref.set(
        {
          roleId,
          ...roles[roleId],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    })
  );
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

async function listUsers({ limit = 500 } = {}) {
  const capped = Math.min(Math.max(parseInt(String(limit || 0), 10) || 500, 1), 1000);
  const snap = await firestore.collection(USERS_COLLECTION).limit(capped).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function listGroups({ limit = 200 } = {}) {
  const capped = Math.min(Math.max(parseInt(String(limit || 0), 10) || 200, 1), 1000);
  const snap = await firestore.collection(GROUPS_COLLECTION).limit(capped).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function createGroup({ actorUid, groupId, name, roleIds = [] }) {
  const id = groupId ? normalizeId(groupId) : normalizeId(name);
  if (!id) throw new Error('groupId/name is required');
  const cleanedRoles = Array.from(new Set((roleIds || []).map((r) => String(r).trim().toLowerCase()))).filter(Boolean);
  cleanedRoles.forEach((r) => {
    if (!ROLE_IDS.includes(r)) throw new Error(`Unknown role: ${r}`);
  });

  const ref = firestore.collection(GROUPS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (snap.exists) {
    const err = new Error('Group already exists');
    err.statusCode = 409;
    throw err;
  }
  await ref.set({
    groupId: id,
    name: String(name || id).trim(),
    roleIds: cleanedRoles,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'group.create',
    targetUid: id,
    diff: { name: String(name || id).trim(), roleIds: cleanedRoles },
  });
  return { id };
}

async function updateGroup({ actorUid, groupId, patch }) {
  const id = normalizeId(groupId);
  if (!id) throw new Error('groupId is required');
  const ref = firestore.collection(GROUPS_COLLECTION).doc(id);

  const nextPatch = { ...(patch || {}) };
  if (Array.isArray(nextPatch.roleIds)) {
    const cleanedRoles = Array.from(
      new Set((nextPatch.roleIds || []).map((r) => String(r).trim().toLowerCase()))
    ).filter(Boolean);
    cleanedRoles.forEach((r) => {
      if (!ROLE_IDS.includes(r)) throw new Error(`Unknown role: ${r}`);
    });
    nextPatch.roleIds = cleanedRoles;
  }
  if (typeof nextPatch.name === 'string') {
    nextPatch.name = nextPatch.name.trim();
  }

  await ref.set(
    {
      ...nextPatch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'group.update',
    targetUid: id,
    diff: nextPatch || null,
  });
}

async function deleteGroup({ actorUid, groupId }) {
  const id = normalizeId(groupId);
  if (!id) throw new Error('groupId is required');
  await firestore.collection(GROUPS_COLLECTION).doc(id).delete();

  // Best-effort cleanup: remove groupId from users that reference it (limited scan).
  const snap = await firestore
    .collection(USERS_COLLECTION)
    .where('groupIds', 'array-contains', id)
    .limit(1000)
    .get();
  await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data() || {};
      const groupIds = Array.isArray(data.groupIds) ? data.groupIds : [];
      const next = groupIds.filter((g) => String(g).toLowerCase() !== id);
      await d.ref.set({ groupIds: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    })
  );

  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'group.delete',
    targetUid: id,
  });
}

async function setUserRoles({ actorUid, targetUid, roles }) {
  const cleaned = Array.from(new Set((roles || []).map((r) => String(r).trim().toLowerCase()))).filter(Boolean);
  cleaned.forEach((r) => {
    if (!ROLE_IDS.includes(r)) {
      throw new Error(`Unknown role: ${r}`);
    }
  });

  await upsertUserProfile(String(targetUid), {
    roles: cleaned,
  });

  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'user.roles.update',
    targetUid: String(targetUid),
    diff: { roles: cleaned },
  });
}

async function setUserGroups({ actorUid, targetUid, groupIds }) {
  const cleaned = Array.from(new Set((groupIds || []).map((g) => normalizeId(g)))).filter(Boolean);
  await upsertUserProfile(String(targetUid), { groupIds: cleaned });
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'user.groups.update',
    targetUid: String(targetUid),
    diff: { groupIds: cleaned },
  });
}

async function setUserOverrides({ actorUid, targetUid, overrides }) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const allow = safe.allow && typeof safe.allow === 'object' ? safe.allow : {};
  const deny = safe.deny && typeof safe.deny === 'object' ? safe.deny : {};
  await upsertUserProfile(String(targetUid), { overrides: { allow, deny } });
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'user.overrides.update',
    targetUid: String(targetUid),
    diff: { overrides: { allow, deny } },
  });
}

async function listRoles() {
  const snap = await firestore.collection(ROLES_COLLECTION).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function updateRole({ actorUid, roleId, patch }) {
  const id = String(roleId).trim().toLowerCase();
  if (!id) throw new Error('roleId is required');
  const ref = firestore.collection(ROLES_COLLECTION).doc(id);
  await ref.set(
    {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await writeAuditLog({
    actorUid: actorUid || null,
    action: 'role.update',
    targetUid: id,
    diff: patch || null,
  });
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
  const deny = overrides?.deny;
  if (deny && hasPermission(deny, moduleName, action)) return false;
  const allow = overrides?.allow;
  if (allow && hasPermission(allow, moduleName, action)) return true;
  return hasPermission(rolePermissions, moduleName, action);
}

async function resolvePermissionsForUser(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) {
    return { profile: null, permissions: null, roles: [] };
  }

  if (profile.disabled) {
    const err = new Error('Account disabled');
    err.statusCode = 403;
    throw err;
  }

  const directRoles = Array.isArray(profile.roles) ? profile.roles.map((r) => String(r).toLowerCase()) : [];
  const groupIds = Array.isArray(profile.groupIds) ? profile.groupIds.map((g) => normalizeId(g)) : [];

  const groupDocs = await Promise.all(
    groupIds.map(async (gid) => {
      const snap = await firestore.collection(GROUPS_COLLECTION).doc(gid).get();
      return snap.exists ? snap.data() : null;
    })
  );
  const groupRoleIds = groupDocs
    .flatMap((g) => (Array.isArray(g?.roleIds) ? g.roleIds : []))
    .map((r) => String(r).toLowerCase());

  const uniqueRoles = Array.from(new Set([...directRoles, ...groupRoleIds])).filter(Boolean);

  if (!uniqueRoles.length) {
    return { profile, permissions: null, roles: [] };
  }

  const roleDocs = await Promise.all(
    uniqueRoles.map(async (roleId) => {
      const snap = await firestore.collection(ROLES_COLLECTION).doc(roleId).get();
      return snap.exists ? snap.data() : null;
    })
  );

  // Merge permissions: OR across roles.
  const merged = {};
  for (const role of roleDocs) {
    const perms = role?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const [mod, actions] of Object.entries(perms)) {
      if (!merged[mod]) merged[mod] = {};
      if (actions && typeof actions === 'object') {
        for (const [act, allowed] of Object.entries(actions)) {
          if (allowed === true) merged[mod][act] = true;
        }
      }
    }
  }

  return { profile, permissions: merged, roles: uniqueRoles };
}

function requirePermission(moduleName, action) {
  return (req, res, next) => {
    // CORS preflight already handled, but keep it safe.
    if (req.method === 'OPTIONS') return next();
    if (req.user?.isAdmin) return next();

    resolvePermissionsForUser(req.user?.uid)
      .then(({ profile, permissions, roles }) => {
        if (!profile) {
          return res.status(403).json({
            ok: false,
            error: { code: 403, message: 'Forbidden: no user profile / roles assigned' },
          });
        }
        if (!permissions) {
          return res.status(403).json({
            ok: false,
            error: { code: 403, message: 'Forbidden: no permissions assigned' },
          });
        }

        const allowed = isAllowedWithOverrides({
          rolePermissions: permissions,
          overrides: profile.overrides || null,
          moduleName,
          action,
        });
        if (!allowed) {
          return res.status(403).json({
            ok: false,
            error: {
              code: 403,
              message: `Forbidden: missing permission ${String(moduleName)}.${String(action)}`,
            },
          });
        }

        req.rbac = { roles, permissions };
        return next();
      })
      .catch((error) => {
        const code = error?.statusCode || 500;
        return res.status(code).json({
          ok: false,
          error: { code, message: error?.message || 'RBAC check failed' },
        });
      });
  };
}

module.exports = {
  ensureDefaultRoles,
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
  listRoles,
  updateRole,
  resolvePermissionsForUser,
  requirePermission,
  hasPermission,
  isAllowedWithOverrides,
  ROLE_IDS,
};

