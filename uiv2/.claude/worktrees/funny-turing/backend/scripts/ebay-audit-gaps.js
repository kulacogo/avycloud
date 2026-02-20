/* eslint-disable no-console */
const { auditListingGaps, createOperationalReports } = require('../lib/ebay-direct');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const runId = argValue('--run-id', `gaps-${Date.now()}`);
  const actor = argValue('--actor', 'script:ebay-audit-gaps');
  const reports = hasFlag('--reports');

  console.log(
    JSON.stringify(
      {
        action: 'ebay-audit-gaps',
        runId,
        actor,
        reports,
      },
      null,
      2
    )
  );

  const summary = await auditListingGaps({ runId, actor });
  console.log(JSON.stringify({ ok: true, summary }, null, 2));

  if (reports) {
    const out = await createOperationalReports();
    console.log(JSON.stringify({ reports: out }, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
