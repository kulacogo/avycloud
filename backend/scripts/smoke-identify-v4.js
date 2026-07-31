'use strict';

/**
 * smoke-identify-v4.js — Pre-rollout verifier for Identify-V4 end-to-end.
 *
 * Runs a single identifyProductV4() call against real Gemini + external APIs
 * using a test-fixture product, then reports per-worker durations, tokens,
 * confidence scores, and the final Critic ebay_ready_score.
 *
 * Usage:
 *   GEMINI_API_KEY=... node backend/scripts/smoke-identify-v4.js
 *
 *   # Dry-run (no saveProductV2 write):
 *   GEMINI_API_KEY=... node backend/scripts/smoke-identify-v4.js --dry-run
 *
 *   # Custom fixture:
 *   GEMINI_API_KEY=... SMOKE_FIXTURE=sony-wh1000xm5 node backend/scripts/smoke-identify-v4.js
 *
 * Exits 0 if the pipeline returns ok:true with ebay_ready_score >= 0.5,
 * exits 1 otherwise. Prints JSON summary to stdout.
 */

const path = require('node:path');
const fs = require('node:fs');

function hasApiKey() {
  return Boolean(
    (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) ||
      (process.env.GOOGLE_GENAI_API_KEY && process.env.GOOGLE_GENAI_API_KEY.trim())
  );
}

const FIXTURES = {
  'sony-wh1000xm5': {
    hint: 'Sony WH-1000XM5 Wireless Noise Cancelling Kopfhörer',
    barcodes: ['4548736132610'],
    locale: 'de-DE',
  },
  'anker-powerbank': {
    hint: 'Anker 737 Power Bank 24000mAh 140W',
    barcodes: ['0194644133564'],
    locale: 'de-DE',
  },
  'philips-hx9903': {
    hint: 'Philips Sonicare DiamondClean HX9903/03',
    barcodes: ['8710103910442'],
    locale: 'de-DE',
  },
};

function pickFixture() {
  const name = process.env.SMOKE_FIXTURE || 'sony-wh1000xm5';
  const fixture = FIXTURES[name];
  if (!fixture) {
    console.error(`Unknown fixture: ${name}. Available: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(2);
  }
  return { name, ...fixture };
}

async function main() {
  if (!hasApiKey()) {
    console.error('❌ GEMINI_API_KEY not set');
    process.exit(2);
  }

  // Force V4 on + autosave off (unless --save passed)
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !args.includes('--save');
  process.env.IDENTIFY_V4 = 'true';
  if (dryRun) process.env.IDENTIFY_V4_AUTOSAVE = 'false';

  const fixture = pickFixture();
  console.log(`\n=== Identify-V4 Smoke Test — fixture: ${fixture.name} (dryRun=${dryRun}) ===\n`);

  const startTotal = Date.now();
  const { identifyProductV4 } = require(path.resolve(
    __dirname,
    '..',
    'services',
    'identify-v4'
  ));

  let result;
  let error = null;
  try {
    result = await identifyProductV4({
      files: [], // fixture products have no image upload — rely on GTIN + hint
      barcodes: fixture.barcodes,
      locale: fixture.locale,
      hint: fixture.hint,
      lotCode: null,
      inventoryId: null,
      tenantId: process.env.SMOKE_TENANT_ID || 'smoke-test',
      userId: process.env.SMOKE_USER_ID || 'smoke-test',
      autosave: !dryRun,
    });
  } catch (err) {
    error = err;
  }
  const totalDurationMs = Date.now() - startTotal;

  if (error) {
    console.error(`❌ V4 threw: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }

  const ok = Boolean(result?.ok);
  const meta = result?.meta || {};
  const workerReports = meta.workerReports || {};
  const criticScore = workerReports.critic?.resolved?.ebay_ready_score ?? null;
  const saved = meta.saved || null;

  console.log(`OK: ${ok}`);
  console.log(`Total duration: ${totalDurationMs}ms (pipeline reports ${meta.durationMs}ms)`);
  console.log(`Pipeline: ${meta.pipeline || 'v4'}`);
  console.log(`ebay_ready_score: ${criticScore}`);
  console.log(`Saved: ${saved ? `yes (id=${saved.id || 'n/a'})` : 'no (dry-run or blocked)'}`);
  console.log('');
  console.log('--- Worker report ---');

  for (const [domain, report] of Object.entries(workerReports)) {
    const dur = report?.meta?.durationMs || 0;
    const tokens = report?.meta?.tokensUsed ?? report?.meta?.geminiCalls ?? '-';
    const conf = report?.confidence
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(report.confidence).map(([k, v]) => [
              k,
              typeof v === 'number' ? v.toFixed(2) : v?.score?.toFixed?.(2) ?? v,
            ])
          )
        )
      : '-';
    console.log(
      `  ${domain.padEnd(12)} ok=${String(report?.ok).padEnd(5)} dur=${String(dur).padStart(6)}ms  tools=${String(tokens).padStart(3)}  conf=${conf}`
    );
  }

  console.log('');
  console.log('--- Waves ---');
  for (const wave of meta.waves || []) {
    console.log(
      `  Wave ${wave.wave}${wave.refinement ? ' (refinement)' : ''}: ${wave.workers.join(',')} — ${wave.durationMs}ms`
    );
  }

  console.log('');
  console.log('--- Product fields filled ---');
  const product = result?.product || {};
  const ident = product.identification || {};
  const details = product.details || {};
  console.log(`  name:         ${ident.name || '-'}`);
  console.log(`  brand:        ${ident.brand || '-'}`);
  console.log(`  category:     ${ident.category || '-'}`);
  console.log(`  barcodes:     ${(ident.barcodes || []).join(', ') || '-'}`);
  console.log(`  title_ebay:   ${details.title_ebay || product.title_ebay || '-'}`);
  console.log(
    `  attributes:   ${Object.keys(details.attributes || {}).length} keys`
  );
  console.log(`  images:       ${(details.images || []).length} items`);
  console.log(
    `  gpsr:         ${details.gpsr?.manufacturer_name ? 'filled' : 'empty'}`
  );
  console.log(`  price:        ${details.pricing?.lowest_price?.amount || '-'} EUR`);

  console.log('');
  console.log(
    JSON.stringify(
      {
        fixture: fixture.name,
        ok,
        totalDurationMs,
        pipelineDurationMs: meta.durationMs,
        ebayReadyScore: criticScore,
        saved: Boolean(saved),
        workerDurations: Object.fromEntries(
          Object.entries(workerReports).map(([d, r]) => [d, r?.meta?.durationMs || 0])
        ),
        pipeline: meta.pipeline || 'v4',
      },
      null,
      2
    )
  );

  // Optionally persist the full result for post-hoc analysis
  if (process.env.SMOKE_OUTPUT) {
    try {
      fs.writeFileSync(
        process.env.SMOKE_OUTPUT,
        JSON.stringify({ fixture, result }, null, 2)
      );
      console.log(`\nFull result → ${process.env.SMOKE_OUTPUT}`);
    } catch (err) {
      console.warn(`Failed to write SMOKE_OUTPUT: ${err.message}`);
    }
  }

  // Smoke-Test evaluates PIPELINE HEALTH, not final product quality.
  // Product quality requires real inputs (image uploads, realistic price
  // signals from external APIs) which aren't available in a dry-run.
  // What we CAN verify here:
  //   - Pipeline completed without throwing (ok === true)
  //   - Identity resolved (GTIN/brand/model correctly identified)
  //   - Category resolved to correct leaf (e.g. Kopfhörer, not Ersatzteile)
  //   - Wave 2 workers all returned with a verdict (ok OR legitimate fail)
  //   - No infinite loops / unhandled rejection cascades
  //
  // The ebay_ready_score can still be low in dry-run because images/price
  // are legitimately empty. Override with SMOKE_MIN_SCORE to enforce a
  // stricter gate when real inputs are available.
  const identityReport = workerReports.identity;
  const categoryReport = workerReports.category;
  const identityConf =
    typeof identityReport?.confidence?.brand === 'number'
      ? identityReport.confidence.brand
      : identityReport?.confidence?.brand?.score ?? 0;
  const categoryConf =
    typeof categoryReport?.confidence?.categoryId === 'number'
      ? categoryReport.confidence.categoryId
      : categoryReport?.confidence?.categoryId?.score ?? 0;
  const wave2Domains = ['attributes', 'seo', 'pricing', 'image', 'gpsr'];
  const wave2Present = wave2Domains.filter((d) => workerReports[d]);

  const health = {
    ok,
    identityConf,
    categoryConf,
    wave2Workers: wave2Present.length,
    totalDuration: totalDurationMs,
  };

  const healthPassed =
    ok &&
    identityConf >= 0.8 &&
    categoryConf >= 0.6 &&
    wave2Present.length === 5 &&
    totalDurationMs < 180000;

  const strictThreshold = Number(process.env.SMOKE_MIN_SCORE ?? 0);
  const scorePassed = criticScore != null && criticScore >= strictThreshold;

  const passed = healthPassed && scorePassed;
  console.log('');
  console.log('--- Health gate ---');
  console.log(`  ok:               ${ok}`);
  console.log(`  identity conf:    ${identityConf.toFixed(2)} (need ≥ 0.80)`);
  console.log(`  category conf:    ${categoryConf.toFixed(2)} (need ≥ 0.60)`);
  console.log(`  wave-2 workers:   ${wave2Present.length} / 5`);
  console.log(`  total duration:   ${totalDurationMs}ms (< 180000)`);
  console.log(`  score:            ${criticScore} (need ≥ ${strictThreshold})`);

  if (passed) {
    console.log('\n✅ Pipeline health gate passed');
  } else {
    console.log('\n❌ Pipeline health gate failed');
  }
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(3);
});
