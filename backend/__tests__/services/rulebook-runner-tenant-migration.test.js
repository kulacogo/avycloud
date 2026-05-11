'use strict';

/**
 * D.0b Tenant-Migration snapshot test for services/rulebook-runner.js.
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * The rulebook runner is a Firestore-backed queue worker — instantiating it
 * pulls in p-queue, Firestore, and several side-effectful libs. Hence a
 * static assertion that the source has been migrated to read from the
 * tenant-scoped helper, with the legacy global helper only as a fallback for
 * pre-D.0b jobs.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.resolve(__dirname, '..', '..', 'services', 'rulebook-runner.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('D.0b — rulebook-runner.js migrated to getAllProductsForTenant', () => {
  it('imports getAllProductsForTenant from lib/firestore', () => {
    expect(SOURCE).toMatch(/getAllProductsForTenant[^;]*=\s*require\(['"]\.\.\/lib\/firestore['"]\)/);
  });

  it('reads tenantId from the job payload', () => {
    expect(SOURCE).toMatch(/jobSnapshot\?\.payload\?\.tenantId/);
  });

  it('uses getAllProductsForTenant when payload carries tenantId, falls back to getAllProducts otherwise', () => {
    expect(SOURCE).toMatch(
      /payloadTenantId\s*\?\s*await\s+getAllProductsForTenant\(payloadTenantId\)\s*:\s*await\s+getAllProducts\(\)/
    );
  });
});
