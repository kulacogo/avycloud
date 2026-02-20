/* eslint-disable no-console */
const { dryRunSync, applySync, createOperationalReports } = require('../lib/ebay-direct');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseItemIds() {
  const raw = argValue('--item-ids', '');
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

async function main() {
  const actor = argValue('--actor', 'script:ebay-apply-corrections');
  const itemIds = parseItemIds();
  const doApply = hasFlag('--apply');
  const withReports = hasFlag('--reports') || doApply;

  console.log(
    JSON.stringify(
      {
        action: 'ebay-apply-corrections',
        mode: doApply ? 'apply' : 'dry-run',
        actor,
        itemIds: itemIds || 'ALL_READY',
        reports: withReports,
      },
      null,
      2
    )
  );

  if (!doApply) {
    const preview = await dryRunSync({ itemIds, actor });
    console.log(JSON.stringify({ ok: true, preview }, null, 2));
    if (withReports) {
      const report = await createOperationalReports();
      console.log(JSON.stringify({ reports: report }, null, 2));
    }
    return;
  }

  const result = await applySync({ itemIds, actor });
  console.log(JSON.stringify({ ok: true, result }, null, 2));

  if (withReports) {
    const report = await createOperationalReports({ applyResults: result?.results || [] });
    console.log(JSON.stringify({ reports: report }, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
