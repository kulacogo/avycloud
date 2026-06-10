'use strict';

/**
 * Tests for the shared destructive-script safety guard.
 * Default = dry-run; --apply opts into real mutations.
 */

const { parseApplyArgs } = require('../../scripts/_apply-guard');

describe('parseApplyArgs', () => {
  const origTenantEnv = process.env.TENANT_ID;
  let logSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.TENANT_ID;
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (origTenantEnv === undefined) delete process.env.TENANT_ID;
    else process.env.TENANT_ID = origTenantEnv;
  });

  it('defaults to dry-run (apply=false) when no flag is passed', () => {
    const { apply } = parseApplyArgs([]);
    expect(apply).toBe(false);
  });

  it('sets apply=true only when --apply is present', () => {
    expect(parseApplyArgs(['--apply']).apply).toBe(true);
    expect(parseApplyArgs(['--something-else']).apply).toBe(false);
  });

  it('defaults tenant to "default" and respects --tenant override', () => {
    expect(parseApplyArgs([]).tenant).toBe('default');
    expect(parseApplyArgs(['--tenant', 'trendocean']).tenant).toBe('trendocean');
  });

  it('falls back to TENANT_ID env when --tenant is absent', () => {
    process.env.TENANT_ID = 'trendocean';
    expect(parseApplyArgs([]).tenant).toBe('trendocean');
    // explicit --tenant still wins over env
    expect(parseApplyArgs(['--tenant', 'other']).tenant).toBe('other');
  });

  it('prints a DRY RUN banner in dry-run mode and an APPLY banner in apply mode', () => {
    parseApplyArgs([]);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/DRY RUN/);
    logSpy.mockClear();
    parseApplyArgs(['--apply']);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/APPLY MODE/);
  });
});
