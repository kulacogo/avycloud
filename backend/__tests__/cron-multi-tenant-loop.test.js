'use strict';

const MODULE_PATH = require.resolve('../lib/background-job-tenants');

function freshRequire() {
  delete require.cache[MODULE_PATH];
  return require('../lib/background-job-tenants');
}

describe('background-job-tenants multi-tenant loop wrapper', () => {
  const originalEnv = process.env.BACKGROUND_JOB_TENANTS;

  beforeEach(() => {
    delete process.env.BACKGROUND_JOB_TENANTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BACKGROUND_JOB_TENANTS;
    } else {
      process.env.BACKGROUND_JOB_TENANTS = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it("defaults to ['default'] when ENV not set", () => {
    const { getBackgroundJobTenants } = freshRequire();
    expect(getBackgroundJobTenants()).toEqual(['default']);
  });

  it('parses comma-separated tenant list', () => {
    process.env.BACKGROUND_JOB_TENANTS = 'trendocean, tenantB ,tenantC';
    const { getBackgroundJobTenants } = freshRequire();
    expect(getBackgroundJobTenants()).toEqual(['trendocean', 'tenantB', 'tenantC']);
  });

  it('calls jobFn once per tenant', async () => {
    process.env.BACKGROUND_JOB_TENANTS = 'tenantA,tenantB,tenantC';
    const { runForEachBackgroundJobTenant } = freshRequire();
    const calls = [];
    const jobFn = vi.fn(async (tenantId) => {
      calls.push(tenantId);
    });
    await runForEachBackgroundJobTenant('test-job', jobFn);
    expect(jobFn).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['tenantA', 'tenantB', 'tenantC']);
  });

  it('continues to next tenant when one throws', async () => {
    process.env.BACKGROUND_JOB_TENANTS = 'good1,bad,good2';
    const { runForEachBackgroundJobTenant } = freshRequire();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    const jobFn = vi.fn(async (tenantId) => {
      seen.push(tenantId);
      if (tenantId === 'bad') throw new Error('boom');
    });
    await runForEachBackgroundJobTenant('test-job', jobFn);
    expect(seen).toEqual(['good1', 'bad', 'good2']);
    expect(jobFn).toHaveBeenCalledTimes(3);
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('test-job');
    expect(logged).toContain('bad');
    expect(logged).toContain('boom');
  });
});
