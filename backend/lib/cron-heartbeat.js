'use strict';

/**
 * Lightweight in-process heartbeat + dead-man-switch for safety-net cron jobs.
 *
 * Problem it solves: the safety-net crons run via setInterval with only
 * `.catch(console.warn)`. If a job silently dies (a synchronous throw in the
 * callback, or it hangs forever), it simply stops running and NOTHING reports
 * the absence. For the stock-failure-drain that is catastrophic: it is the only
 * push-alert path AND a core oversell backstop — if it dies quietly, both go
 * dark at once.
 *
 * Usage:
 *   const hb = require('./lib/cron-heartbeat');
 *   hb.registerCronJob('stock-failure-drain', 6 * 60 * 1000); // expected <= 6min between beats
 *   // ...inside the job, after a successful run:
 *   hb.beat('stock-failure-drain');
 *   // ...once at startup:
 *   hb.startCronWatchdog();
 */

const _jobs = new Map(); // name -> { lastBeatMs, staleMs, alerted }

/**
 * Register a job to be watched. `staleMs` is the max time allowed between
 * successful beats before the watchdog alerts. Re-registering updates staleMs.
 */
function registerCronJob(name, staleMs) {
  const existing = _jobs.get(name);
  if (existing) {
    existing.staleMs = staleMs;
    return;
  }
  // Seed lastBeat with "now" so a freshly-registered job gets one grace window
  // before it can be considered stale.
  _jobs.set(name, { lastBeatMs: Date.now(), staleMs, alerted: false });
}

/** Record a successful run of `name`. Clears any active stall alert. */
function beat(name) {
  const job = _jobs.get(name);
  if (job) {
    job.lastBeatMs = Date.now();
    job.alerted = false;
  } else {
    // Auto-register without a staleMs → tracked but not watched until registered.
    _jobs.set(name, { lastBeatMs: Date.now(), staleMs: null, alerted: false });
  }
}

/**
 * Check all watched jobs. Returns the list of currently-stale jobs and fires a
 * one-shot ops alert per stall (re-armed on the next successful beat).
 */
function checkHeartbeats(now = Date.now()) {
  const stale = [];
  for (const [name, job] of _jobs.entries()) {
    if (!job.staleMs) continue;
    const ageMs = now - job.lastBeatMs;
    if (ageMs > job.staleMs) {
      stale.push({ name, ageMs, staleMs: job.staleMs });
      if (!job.alerted) {
        job.alerted = true; // alert once per stall
        try {
          require('./ops-alert').sendOpsAlert({
            source: 'cron-watchdog',
            severity: 'critical',
            message: `cron '${name}' has not completed for ${Math.round(ageMs / 1000)}s ` +
              `(expected <= ${Math.round(job.staleMs / 1000)}s). It may have silently died.`,
            context: { job: name, ageMs, staleMs: job.staleMs },
          }).catch(() => {});
        } catch (_) { /* alerting must never throw */ }
      }
    }
  }
  return stale;
}

/** Start the periodic watchdog. Returns the interval handle (unref'd). */
function startCronWatchdog(intervalMs = 5 * 60 * 1000) {
  const t = setInterval(() => {
    try { checkHeartbeats(); } catch (_) { /* never throw out of the watchdog */ }
  }, intervalMs);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

/** Test helper. */
function _reset() { _jobs.clear(); }

module.exports = { registerCronJob, beat, checkHeartbeats, startCronWatchdog, _reset };
