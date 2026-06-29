'use strict';

/**
 * Process-role helpers for the web/worker split.
 *
 * AvyCloud deploys ONE image as TWO Cloud Run services:
 *   - product-hub-backend  (web)    : RUN_BACKGROUND_JOBS=false → serves HTTP only
 *   - product-hub-worker   (worker) : RUN_BACKGROUND_JOBS=true  → runs ALL runners + cron
 *
 * Gating all background work onto the worker keeps heavy marketplace syncs from
 * competing with user requests for a Cloud Run instance slot (root cause of the
 * 2026-06-29 "Produkt erfassen" Failed-to-fetch incident).
 *
 * Default is TRUE: any deployment / local dev WITHOUT the flag keeps the legacy
 * single-process behaviour (runs everything), so this change is inert until the
 * web service is explicitly switched to RUN_BACKGROUND_JOBS=false.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean} true → this process should start runners + cron jobs
 */
function shouldRunBackgroundJobs(env = process.env) {
  return env.RUN_BACKGROUND_JOBS !== 'false';
}

module.exports = { shouldRunBackgroundJobs };
