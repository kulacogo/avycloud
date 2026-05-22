/**
 * Hardening Wave 6 — RBAC + IDOR-Guards on settings DELETE endpoints
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HARDEN Wave 6: settings DELETE has tenant-scoped guard', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'routes', 'settings.js'),
    'utf8'
  );

  it('defines safeDeleteTenantScoped helper', () => {
    expect(source).toMatch(/async function safeDeleteTenantScoped/);
    // Reads doc first, checks tenantId match, then deletes.
    expect(source).toMatch(/snap\.exists/);
    expect(source).toMatch(/docTenant\s*!==\s*tenantId/);
    expect(source).toMatch(/forbidden_tenant_mismatch/);
    // Legacy docs without tenantId are refused (defense-in-depth).
    expect(source).toMatch(/forbidden_legacy_doc_no_tenant/);
  });

  it('DELETE /api/settings/api-keys/:id uses requirePermission + safeDelete', () => {
    expect(source).toMatch(/router\.delete\(\s*['"]\/settings\/api-keys\/:id['"][\s\S]{0,200}requirePermission\(['"]settings['"],\s*['"]delete['"]\)/);
    expect(source).toMatch(/safeDeleteTenantScoped[\s\S]{0,200}collection:\s*['"]api_keys['"]/);
  });

  it('DELETE /api/settings/webhooks/:id uses requirePermission + safeDelete', () => {
    expect(source).toMatch(/router\.delete\(\s*['"]\/settings\/webhooks\/:id['"][\s\S]{0,200}requirePermission\(['"]settings['"],\s*['"]delete['"]\)/);
    expect(source).toMatch(/safeDeleteTenantScoped[\s\S]{0,200}collection:\s*['"]webhooks['"]/);
  });
});
