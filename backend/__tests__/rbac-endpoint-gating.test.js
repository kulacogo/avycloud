'use strict';

/**
 * RBAC endpoint gating (2026-07-03 rework).
 *
 * These endpoints were reachable by ANY logged-in user (only requireAuth, no
 * requirePermission) — including issuing REFUNDS (money) and changing the
 * company/Impressum identity. That was the security hole behind "everyone is
 * admin". This locks each sensitive endpoint to the permission its role owns.
 * Source-level assertion (same pattern as hardening-wave6).
 *
 * Admin (wildcard) still passes everything, so existing flows keep working.
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

// Match: router.<verb>('<path>', ... requirePermission('<mod>', '<action>')
const gated = (src, verb, routePath, mod, action) => {
  const p = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `router\\.${verb}\\(\\s*['"]${p}['"][\\s\\S]{0,160}?requirePermission\\(\\s*['"]${mod}['"]\\s*,\\s*['"]${action}['"]\\s*\\)`
  );
  return re.test(src);
};

describe('returns.js — the money endpoints are gated', () => {
  const src = read('routes/returns.js');
  it('imports requirePermission', () => expect(src).toMatch(/requirePermission/));
  it('POST /returns/:id/refund requires returns.refund (Geldbewegung)', () => {
    expect(gated(src, 'post', '/returns/:id/refund', 'returns', 'refund')).toBe(true);
  });
  it('POST /returns/:id/process requires returns.process', () => {
    expect(gated(src, 'post', '/returns/:id/process', 'returns', 'process')).toBe(true);
  });
  it('GET /returns requires returns.read', () => {
    expect(gated(src, 'get', '/returns', 'returns', 'read')).toBe(true);
  });
  it('POST /returns requires returns.process', () => {
    expect(gated(src, 'post', '/returns', 'returns', 'process')).toBe(true);
  });
});

describe('settings.js — company identity + technical config are gated', () => {
  const src = read('routes/settings.js');
  it('GET /settings/company requires settings.company.read', () => {
    expect(gated(src, 'get', '/settings/company', 'settings', 'company.read')).toBe(true);
  });
  it('PUT /settings/company requires settings.company.write (Impressum/USt-ID)', () => {
    expect(gated(src, 'put', '/settings/company', 'settings', 'company.write')).toBe(true);
  });
  it('POST /settings/api-keys requires settings.write (admin-only)', () => {
    expect(gated(src, 'post', '/settings/api-keys', 'settings', 'write')).toBe(true);
  });
  it('POST /settings/webhooks requires settings.write (admin-only)', () => {
    expect(gated(src, 'post', '/settings/webhooks', 'settings', 'write')).toBe(true);
  });
});

describe('invoices.js — invoice endpoints use the invoices module', () => {
  const src = read('routes/invoices.js');
  it('GET /invoices requires invoices.read', () => {
    expect(gated(src, 'get', '/invoices', 'invoices', 'read')).toBe(true);
  });
  it('POST /invoices requires invoices.write', () => {
    expect(gated(src, 'post', '/invoices', 'invoices', 'write')).toBe(true);
  });
});

describe('rules.js — automation rules are gated (admin-only for now)', () => {
  const src = read('routes/rules.js');
  it('imports requirePermission', () => expect(src).toMatch(/requirePermission/));
  it('GET / requires rules.read', () => {
    expect(gated(src, 'get', '/', 'rules', 'read')).toBe(true);
  });
  it('POST / requires rules.write', () => {
    expect(gated(src, 'post', '/', 'rules', 'write')).toBe(true);
  });
});

describe('marketplace.js — eBay connect is an integrations action, not products', () => {
  const src = read('routes/marketplace.js');
  it('GET /ebay/oauth/start requires integrations.write', () => {
    expect(gated(src, 'get', '/ebay/oauth/start', 'integrations', 'write')).toBe(true);
  });
});
