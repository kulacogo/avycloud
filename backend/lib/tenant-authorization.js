'use strict';

// Tenant-authorization helper.
//
// Resolves the tenant a request should operate on, honoring optional
// body/query overrides while enforcing cross-tenant safety. Super-admins
// with `canImpersonate === true` may target any tenant; non-super users
// may only target their own tenant. Routes that intentionally allow
// impersonation pass `{ allowImpersonation: true }`.
//
// Throws an Error with `statusCode = 403` and `code = 'CROSS_TENANT_FORBIDDEN'`
// when a non-privileged user attempts to access a different tenant.

function resolveAuthorizedTenant(req, options = {}) {
  const { allowImpersonation = false } = options;
  const bodyTenant = req && req.body ? req.body.tenantId : undefined;
  const queryTenant = req && req.query ? req.query.tenantId : undefined;
  const userTenant = req && req.user ? req.user.tenantId : undefined;
  const isSuperAdmin = !!(req && req.user && req.user.isAdmin && req.user.canImpersonate === true);
  const requested = bodyTenant || queryTenant;
  if (requested) {
    if (allowImpersonation || isSuperAdmin) return requested;
    if (userTenant && requested !== userTenant) {
      const err = new Error('Cross-tenant access denied');
      err.statusCode = 403;
      err.code = 'CROSS_TENANT_FORBIDDEN';
      throw err;
    }
    return requested;
  }
  return userTenant || 'default';
}

module.exports = { resolveAuthorizedTenant };
