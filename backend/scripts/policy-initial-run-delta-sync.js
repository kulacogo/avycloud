/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Policy Initial Run + Delta Sync
 *
 * Requirement:
 * - After each rule change, we MUST:
 *   1) run an initial pass over all affected products
 *   2) save the normalized products
 *
 * This script:
 * - loads all products
 * - applies the strict rulebook normalization (title + highlights + canonical attributes)
 * - saves only changed products
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --apply --expected-count 631
 *
 * Options:
 *   --limit <n>              Limit products processed (for testing)
 */

const { getAllProductsForTenant, getProduct, saveProduct } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const { normalizeProductStrict } = require('../lib/llm-rulebook');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function deepEqualJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const expectedCount = Number(argValue('--expected-count', '0') || 0);
  const limit = Number(argValue('--limit', '0') || 0);

  const all = await getAllProductsForTenant(TENANT_ID);
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];
  const total = products.length;

  if (apply) {
    if (!expectedCount || expectedCount <= 0) {
      throw new Error('ABORT: --apply requires --expected-count <number>');
    }
    if (expectedCount !== total) {
      throw new Error(`ABORT: expectedCount=${expectedCount} but got total=${total}`);
    }
  }

  const selected = limit && limit > 0 ? products.slice(0, limit) : products;
  console.log(JSON.stringify({ action: 'policy-initial-run-delta-sync', dryRun, total, selected: selected.length }, null, 2));

  let changed = 0;
  let unchanged = 0;
  let invalid = 0;
  const changedIds = [];
  const invalidIds = [];

  for (const p of selected) {
    const fresh = await getProduct(String(p.id)).catch(() => null);
    const current = fresh || p;
    const strict = normalizeProductStrict(current, { source: 'policy-initial-run' });
    if (!strict.ok) {
      invalid += 1;
      invalidIds.push({ id: current.id, issues: strict.issues });
      continue;
    }
    const next = strict.product;

    // Only compare fields we normalize here (title + highlights + attributes + short_description cleanup).
    const beforeSnap = {
      identification: { name: current?.identification?.name || '' },
      details: {
        key_features: Array.isArray(current?.details?.key_features) ? current.details.key_features : [],
        attributes:
          current?.details?.attributes && typeof current.details.attributes === 'object' && !Array.isArray(current.details.attributes)
            ? current.details.attributes
            : {},
        short_description: current?.details?.short_description || '',
      },
    };
    const afterSnap = {
      identification: { name: next?.identification?.name || '' },
      details: {
        key_features: Array.isArray(next?.details?.key_features) ? next.details.key_features : [],
        attributes:
          next?.details?.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)
            ? next.details.attributes
            : {},
        short_description: next?.details?.short_description || '',
      },
    };
    const isSame = deepEqualJson(beforeSnap, afterSnap);
    if (isSame) {
      unchanged += 1;
      continue;
    }

    changed += 1;
    changedIds.push(String(current.id));

    if (!dryRun) {
      await saveProduct(next, { source: 'policy-initial-run', overwriteTextFields: true });
    }
  }

  console.log(JSON.stringify({ done: true, total: selected.length, changed, unchanged, invalid }, null, 2));

  if (dryRun) {
    console.log('[policy-initial-run-delta-sync] DRY RUN: not saving.');
    return;
  }

  if (invalidIds.length) {
    console.log(
      JSON.stringify(
        {
          invalid_count: invalidIds.length,
          invalid_preview: invalidIds.slice(0, 20),
        },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

