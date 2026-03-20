/**
 * Pricing Runner
 *
 * Periodischer Runner der runRepricingJob() für alle Produkte mit aktiven Regeln aufruft.
 *
 * Feature-Flag: PRICING_RUNNER_ENABLED=true (default: false)
 * Intervall: PRICING_RUNNER_INTERVAL_MS (default: 4 Stunden)
 * Initial-Delay: PRICING_RUNNER_INITIAL_DELAY_MS (default: 5 Minuten nach Server-Start)
 */
const { runRepricingJob } = require('./pricing-engine');

const PRICING_RUNNER_ENABLED = process.env.PRICING_RUNNER_ENABLED === 'true';
const PRICING_RUNNER_INTERVAL_MS = parseInt(
  process.env.PRICING_RUNNER_INTERVAL_MS || String(4 * 60 * 60 * 1000),
  10
);
const PRICING_RUNNER_INITIAL_DELAY_MS = parseInt(
  process.env.PRICING_RUNNER_INITIAL_DELAY_MS || String(5 * 60 * 1000),
  10
);

let runnerTimer = null;
let runInFlight = false;
let lastRunAt = null;
let lastRunResult = null;

async function runPricingCycle() {
  if (runInFlight) {
    console.log('[PricingRunner] Run already in flight, skipping.');
    return;
  }
  runInFlight = true;
  console.log('[PricingRunner] Starting repricing cycle...');
  try {
    const results = await runRepricingJob();
    lastRunAt = new Date().toISOString();
    lastRunResult = results;
    console.log(
      `[PricingRunner] Cycle complete: processed=${results.processed}, updated=${results.updated}, errors=${results.errors}`
    );
  } catch (err) {
    console.error('[PricingRunner] Cycle failed:', err.message);
  } finally {
    runInFlight = false;
  }
}

function startPricingRunner() {
  if (!PRICING_RUNNER_ENABLED) {
    console.log('[PricingRunner] Disabled. Set PRICING_RUNNER_ENABLED=true to enable.');
    return;
  }
  console.log(
    `[PricingRunner] Starting — interval: ${PRICING_RUNNER_INTERVAL_MS}ms, initial delay: ${PRICING_RUNNER_INITIAL_DELAY_MS}ms`
  );
  setTimeout(() => runPricingCycle(), PRICING_RUNNER_INITIAL_DELAY_MS);
  runnerTimer = setInterval(() => runPricingCycle(), PRICING_RUNNER_INTERVAL_MS);
}

function stopPricingRunner() {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
}

function getPricingRunnerStatus() {
  return {
    enabled: PRICING_RUNNER_ENABLED,
    running: runnerTimer !== null,
    inFlight: runInFlight,
    lastRunAt,
    lastRunResult,
    intervalMs: PRICING_RUNNER_INTERVAL_MS,
  };
}

module.exports = { startPricingRunner, stopPricingRunner, getPricingRunnerStatus };
