/* eslint-disable no-console */
const { syncLiveListingsAndAudit, createOperationalReports } = require('../lib/ebay-direct');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const runId = argValue('--run-id', `sync-${Date.now()}`);
  const maxPages = Number(argValue('--max-pages', '10'));
  const entriesPerPage = Number(argValue('--entries-per-page', '100'));
  const detailConcurrency = Number(argValue('--detail-concurrency', '4'));
  const timeoutMs = Number(argValue('--timeout-ms', '25000'));
  const actor = argValue('--actor', 'script:ebay-sync-live-listings');
  const withReports = hasFlag('--reports');

  console.log(
    JSON.stringify(
      {
        action: 'ebay-sync-live-listings',
        runId,
        maxPages,
        entriesPerPage,
        detailConcurrency,
        timeoutMs,
        actor,
        reports: withReports,
      },
      null,
      2
    )
  );

  const summary = await syncLiveListingsAndAudit({
    runId,
    maxPages,
    entriesPerPage,
    detailConcurrency,
    timeoutMs,
    actor,
  });

  console.log(JSON.stringify({ ok: true, summary }, null, 2));

  if (withReports) {
    const report = await createOperationalReports();
    console.log(JSON.stringify({ reports: report }, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
