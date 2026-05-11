'use strict';

/**
 * D.0b Tenant-Migration snapshot test for routes/admin.js
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * routes/admin.js had two relevant migrations:
 *   1. GET /metrics/product-coverage — now uses getAllProductsForTenant.
 *   2. POST /bulk/run — injects req.user?.tenantId into the job payload so
 *      the background admin-bulk runner can scope its read.
 *   3. POST /rulebook/apply — injects tenantId into the rulebook job payload.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'routes', 'admin.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — routes/admin.js migrated to getAllProductsForTenant', () => {
  it('GET /metrics/product-coverage uses tenant-scoped read', () => {
    const route = SOURCE.match(
      /router\.get\(\s*['"]\/metrics\/product-coverage['"][\s\S]*?\n\}\);\n/
    );
    expect(route).not.toBeNull();
    const body = route[0];
    expect(body).toMatch(/getAllProductsForTenant/);
    expect(body).toMatch(/req\.user\?\.tenantId/);
    // Defensive: legacy helper must NOT be called inside this route any more.
    expect(body).not.toMatch(/await\s+getAllProducts\(\)/);
  });

  it('POST /bulk/run injects tenantId into the job payload', () => {
    const route = SOURCE.match(
      /router\.post\(\s*['"]\/bulk\/run['"][\s\S]*?\n\}\);\n/
    );
    expect(route).not.toBeNull();
    const body = route[0];
    // payload object literal must contain a tenantId key.
    expect(body).toMatch(/tenantId:\s*typeof body\.tenantId === 'string'/);
    expect(body).toMatch(/req\.user\?\.tenantId/);
  });

  it('POST /rulebook/apply injects tenantId into the job payload', () => {
    const route = SOURCE.match(
      /router\.post\(\s*['"]\/rulebook\/apply['"][\s\S]*?\n\}\);\n/
    );
    expect(route).not.toBeNull();
    const body = route[0];
    expect(body).toMatch(/req\.user\?\.tenantId/);
    expect(body).toMatch(/payload:\s*\{[^}]*tenantId[^}]*\}/);
  });
});
