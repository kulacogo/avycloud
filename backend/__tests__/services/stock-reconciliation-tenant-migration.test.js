'use strict';

/**
 * D.0b Tenant-Migration snapshot test for services/stock-reconciliation.js.
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * Verifies reconcileFullScan() uses the tenant-scoped helper. The module
 * already exposes `tenantId` as an explicit parameter (default 'default'),
 * so this is the cleanest of the migrations.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'services', 'stock-reconciliation.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — stock-reconciliation.js migrated to getAllProductsForTenant', () => {
  it('imports getAllProductsForTenant from lib/firestore', () => {
    expect(SOURCE).toMatch(/getAllProductsForTenant[^;]*=\s*require\(['"]\.\.\/lib\/firestore['"]\)/);
  });

  it('reconcileFullScan uses tenant-scoped read with tenantId argument', () => {
    const fn = SOURCE.match(/async function reconcileFullScan\([\s\S]*?\n}\n/);
    expect(fn).not.toBeNull();
    const body = fn[0];
    expect(body).toMatch(/getAllProductsForTenant\(tenantId\)/);
  });
});
