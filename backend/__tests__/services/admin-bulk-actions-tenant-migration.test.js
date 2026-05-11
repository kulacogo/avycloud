'use strict';

/**
 * D.0b Tenant-Migration snapshot test for services/admin-bulk-actions.js.
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * Static-analysis assertions (no module side-effects, no Firestore I/O):
 *   1. admin-bulk-actions.js requires getAllProductsForTenant from lib/firestore.
 *   2. resolveTargetProducts() reads tenantId and forwards it to the
 *      tenant-scoped helper.
 *   3. runBulkRecategorizeV2 pre- and post-flight count guards use the
 *      tenant-scoped helper when tenantId is provided.
 *   4. runBulkAction propagates tenantId from the payload into every
 *      sub-action.
 *
 * Why static and not behavioural: admin-bulk-actions.js drags in Firestore,
 * Storage, p-queue, Kaufland-API at require-time. Loading it would crash any
 * unit test that has not patched all of those. The migration we need to lock
 * in is purely structural ("does the source call the tenant helper?") — that
 * lends itself to a fast lexical assertion.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'services', 'admin-bulk-actions.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — admin-bulk-actions.js migrated to getAllProductsForTenant', () => {
  it('imports getAllProductsForTenant from lib/firestore', () => {
    expect(SOURCE).toMatch(/getAllProductsForTenant[^;]*=\s*require\(['"]\.\.\/lib\/firestore['"]\)/);
  });

  it('resolveTargetProducts accepts tenantId and prefers the tenant helper', () => {
    const fn = SOURCE.match(/async function resolveTargetProducts\([^)]*\)\s*{[\s\S]*?\n}/);
    expect(fn).not.toBeNull();
    const body = fn[0];
    expect(body).toMatch(/\btenantId\b/);
    expect(body).toMatch(/getAllProductsForTenant\(tenantId\)/);
  });

  it('runBulkRecategorizeV2 pre-flight count guard uses tenant-scoped read when tenantId is set', () => {
    expect(SOURCE).toMatch(
      /tenantId\s*\?\s*await\s+getAllProductsForTenant\(tenantId\)\s*:\s*await\s+getAllProducts\(\)/
    );
  });

  it('runBulkAction destructures tenantId from payload', () => {
    const fn = SOURCE.match(/async function runBulkAction\([\s\S]*?\n}\n/);
    expect(fn).not.toBeNull();
    const body = fn[0];
    expect(body).toMatch(/payload\.tenantId/);
    // tenantId is threaded through every sub-action it dispatches.
    const dispatchCalls = [
      'runBulkPrice',
      'runBulkTitle',
      'runBulkCategory',
      'runBulkRecategorizeV2',
      'runBulkKType',
      'runBulkKauflandSync',
      'runExportMarketplace',
    ];
    for (const name of dispatchCalls) {
      const re = new RegExp(`${name}\\(\\{[^}]*tenantId[^}]*\\}`);
      expect(body).toMatch(re);
    }
  });
});
