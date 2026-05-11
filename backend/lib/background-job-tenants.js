'use strict';

/**
 * Multi-Tenant-Loop helpers for backend cron safety-net jobs.
 *
 * Mirrors the STOCK_FAILURE_DRAIN_TENANTS pattern. Set
 *   BACKGROUND_JOB_TENANTS=tenantA,tenantB
 * to fan a safety-net cron job out across multiple tenants. When the ENV
 * is unset or empty, behavior is identical to the legacy single-tenant
 * default (`['default']`) — no behavior change for existing deployments.
 *
 * Plan-D.0c — additive, opt-in, default-off.
 */

/**
 * Read BACKGROUND_JOB_TENANTS env-var and return the resolved tenant list.
 * Empty / unset → ['default'] (legacy single-tenant default).
 * Comma-separated → trimmed, non-empty entries only.
 * @returns {string[]}
 */
function getBackgroundJobTenants() {
  const raw = String(process.env.BACKGROUND_JOB_TENANTS || '').trim();
  if (!raw) return ['default'];
  const tenants = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return tenants.length > 0 ? tenants : ['default'];
}

/**
 * Run `jobFn(tenantId)` once per configured tenant. Errors per-tenant are
 * caught + logged so one bad tenant does not break the remaining iterations.
 * @param {string} jobName - log label
 * @param {(tenantId: string) => Promise<any> | any} jobFn
 * @returns {Promise<void>}
 */
async function runForEachBackgroundJobTenant(jobName, jobFn) {
  const tenants = getBackgroundJobTenants();
  for (const tenantId of tenants) {
    try {
      await jobFn(tenantId);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      console.error('[background-job][%s][%s] %s', jobName, tenantId, msg);
    }
  }
}

module.exports = {
  getBackgroundJobTenants,
  runForEachBackgroundJobTenant,
};
