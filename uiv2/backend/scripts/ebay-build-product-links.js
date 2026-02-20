/* eslint-disable no-console */
const { buildProductListingLinks, createOperationalReports } = require('../lib/ebay-direct');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const runId = argValue('--run-id', `link-${Date.now()}`);
  const actor = argValue('--actor', 'script:ebay-build-product-links');
  const reports = hasFlag('--reports');

  console.log(
    JSON.stringify(
      {
        action: 'ebay-build-product-links',
        runId,
        actor,
        reports,
      },
      null,
      2
    )
  );

  const summary = await buildProductListingLinks({ runId, actor });
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
