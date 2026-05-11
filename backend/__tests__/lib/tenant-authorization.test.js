'use strict';

// globals: true in vitest.config.js — describe/it/expect available globally.
// Pure unit tests, no GCP/firestore patching needed.

const { resolveAuthorizedTenant } = require('../../lib/tenant-authorization');

describe('resolveAuthorizedTenant', () => {
  it('returns user tenant when no override is provided', () => {
    const req = { user: { tenantId: 'tenant-a' }, body: {}, query: {} };
    expect(resolveAuthorizedTenant(req)).toBe('tenant-a');
  });

  it('allows body override when it matches the user tenant', () => {
    const req = {
      user: { tenantId: 'tenant-a' },
      body: { tenantId: 'tenant-a' },
      query: {},
    };
    expect(resolveAuthorizedTenant(req)).toBe('tenant-a');
  });

  it('throws 403 CROSS_TENANT_FORBIDDEN on cross-tenant override', () => {
    const req = {
      user: { tenantId: 'tenant-a' },
      body: { tenantId: 'tenant-b' },
      query: {},
    };
    let caught = null;
    try {
      resolveAuthorizedTenant(req);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.statusCode).toBe(403);
    expect(caught.code).toBe('CROSS_TENANT_FORBIDDEN');
  });

  it('allows super-admin (isAdmin + canImpersonate) to target any tenant', () => {
    const req = {
      user: { tenantId: 'tenant-a', isAdmin: true, canImpersonate: true },
      body: { tenantId: 'tenant-b' },
      query: {},
    };
    expect(resolveAuthorizedTenant(req)).toBe('tenant-b');
  });

  it('falls back to query tenantId when body tenantId is absent', () => {
    const req = {
      user: { tenantId: 'tenant-a' },
      body: {},
      query: { tenantId: 'tenant-a' },
    };
    expect(resolveAuthorizedTenant(req)).toBe('tenant-a');
  });

  it("returns 'default' when no user and no override is provided", () => {
    const req = { body: {}, query: {} };
    expect(resolveAuthorizedTenant(req)).toBe('default');
  });

  it('honors allowImpersonation option for non-super users', () => {
    const req = {
      user: { tenantId: 'tenant-a' },
      body: { tenantId: 'tenant-b' },
      query: {},
    };
    expect(resolveAuthorizedTenant(req, { allowImpersonation: true })).toBe('tenant-b');
  });
});
