'use strict';

/**
 * D.0b Tenant-Migration snapshot test for routes/products.js
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * Two call-sites were migrated:
 *   1. POST /products/bulk-improve  — line 1448 (was getAllProducts())
 *   2. GET  /products               — line 1502 (was getAllProducts() inside Promise.all)
 *
 * Both routes now read req.user?.tenantId and pass it to
 * getAllProductsForTenant(). Loading routes/products.js would pull in the
 * entire Firestore stack; instead we lock in the migration via lexical
 * assertions on the source.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'routes', 'products.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — routes/products.js migrated to getAllProductsForTenant', () => {
  it('imports getAllProductsForTenant from lib/firestore', () => {
    expect(SOURCE).toMatch(/getAllProductsForTenant,/);
  });

  it('POST /products/bulk-improve reads req.user?.tenantId and uses the tenant helper', () => {
    const route = SOURCE.match(
      /router\.post\(\s*['"]\/products\/bulk-improve['"][\s\S]*?\n\}\);\n/
    );
    expect(route).not.toBeNull();
    const body = route[0];
    expect(body).toMatch(/req\.user\?\.tenantId/);
    expect(body).toMatch(/getAllProductsForTenant\(tenantId\)/);
  });

  it('GET /products reads req.user?.tenantId and uses the tenant helper in Promise.all', () => {
    const route = SOURCE.match(
      /router\.get\(\s*['"]\/products['"][\s\S]*?\n\}\);\n/
    );
    expect(route).not.toBeNull();
    const body = route[0];
    expect(body).toMatch(/req\.user\?\.tenantId/);
    expect(body).toMatch(/getAllProductsForTenant\(tenantId\)/);
  });
});
