'use strict';

/**
 * D.0b Tenant-Migration snapshot test for lib/ebay-direct.js
 * (specifically buildProductListingLinks).
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * ebay-direct.js is a Yellow-Zone marketplace integration. Loading it pulls
 * in the eBay client + Firestore, so we use the same lexical assertion
 * approach as the other D.0b snapshot tests.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'lib', 'ebay-direct.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — lib/ebay-direct.js migrated to getAllProductsForTenant', () => {
  it('imports getAllProductsForTenant alongside the legacy helper', () => {
    expect(SOURCE).toMatch(/getAllProductsForTenant[^;]*=\s*require\(['"]\.\/firestore['"]\)/);
  });

  it('buildProductListingLinks accepts a tenantId argument', () => {
    expect(SOURCE).toMatch(/async function buildProductListingLinks\(\{[^}]*\btenantId\b[^}]*\}/);
  });

  it('buildProductListingLinks uses getAllProductsForTenant when tenantId is supplied', () => {
    expect(SOURCE).toMatch(
      /tenantId\s*\?\s*await\s+getAllProductsForTenant\(tenantId\)\s*:\s*await\s+getAllProducts\(\)/
    );
  });
});
