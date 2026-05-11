'use strict';

/**
 * D.0b — Tests for scripts/audit-getAllProducts-callers.js
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * The audit script is the pre-D.0c gate: it must report zero
 * production-callers of the legacy getAllProducts() helper. This test
 * spawns the script as a subprocess and asserts:
 *   1. Exit code is 0.
 *   2. JSON output parses cleanly.
 *   3. production_callers is an empty array.
 *   4. total_unique_files / counts are consistent with the report.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'audit-getAllProducts-callers.js');

describe('audit-getAllProducts-callers.js (pre-D.0c gate)', () => {
  it('exits 0 and reports zero production callers', () => {
    const res = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(res.status).toBe(0);

    const out = JSON.parse(res.stdout);
    expect(Array.isArray(out.production_callers)).toBe(true);
    expect(out.production_callers).toEqual([]);
    expect(out.production_caller_count).toBe(0);

    // sanity: script_callers field is a list (may still be non-empty until
    // D.0c migrates ad-hoc scripts).
    expect(Array.isArray(out.script_callers)).toBe(true);
    expect(out.script_caller_count).toBe(out.script_callers.length);
    expect(out.total_unique_files).toBeGreaterThanOrEqual(out.script_callers.length === 0 ? 0 : 1);
  });

  // ── CC4-C-4 fix: V2 callers are tracked separately and surface
  //    routes/marketplace.js entries that were previously invisible. ─────────
  it('CC4-C-4: also reports getAllProductsV2 callers in a separate bucket', () => {
    const res = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);

    // Shape contract
    expect(Array.isArray(out.production_callers_v2)).toBe(true);
    expect(Array.isArray(out.script_callers_v2)).toBe(true);
    expect(typeof out.production_caller_count_v2).toBe('number');
    expect(typeof out.script_caller_count_v2).toBe('number');
    expect(out.production_caller_count_v2).toBe(out.production_callers_v2.length);
    expect(out.script_caller_count_v2).toBe(out.script_callers_v2.length);

    // We expect at least the three known marketplace.js call-sites to surface.
    const marketplaceHits = out.production_callers_v2.filter((c) =>
      c.file.endsWith('routes/marketplace.js')
    );
    expect(marketplaceHits.length).toBeGreaterThanOrEqual(3);
    for (const hit of marketplaceHits) {
      expect(hit.code).toMatch(/getAllProductsV2\s*\(/);
    }

    // V2 callers must NOT cause exit-code != 0 (informational bucket only).
    expect(res.status).toBe(0);
  });

  it('CC4-C-4: findV2Callers detects calls but ignores destructuring imports', () => {
    const { findV2Callers } = require('../../scripts/audit-getAllProducts-callers');
    const marketplace = path.resolve(__dirname, '..', '..', 'routes', 'marketplace.js');
    const hits = findV2Callers(marketplace);
    // 3 known call-sites
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const hit of hits) {
      // Only actual invocations — never lines that look like
      // `const { getAllProductsV2 } = require(...)`.
      expect(hit.code).not.toMatch(/=\s*require\(/);
      expect(hit.code).toMatch(/getAllProductsV2\s*\(/);
    }
  });
});
