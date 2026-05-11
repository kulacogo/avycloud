#!/usr/bin/env node
// CommonJS. 2 Spaces. Single Quotes.
//
// migrate-llm-scope-schema.js — Phase F.1a Schema-Migration
//
// Idempotent backfill of the 5 new optional fields on every scope-version doc
// in Firestore collection `llmScopes/{scopeId}/versions/{versionId}`.
//
// New fields (defaults):
//   userTemplate     : ''
//   outputSchemaHint : ''
//   modelOverride    : null
//   generationConfig : {}
//   tenantOverrides  : {}    (stored on the SCOPE doc, not on version docs)
//
// Migration version marker (on each touched doc): migrationVersion = 'v1.0-phase-f1a'.
//
// Usage:
//   node scripts/migrate-llm-scope-schema.js --dry-run
//   node scripts/migrate-llm-scope-schema.js --apply
//
// Output: JSON summary at /tmp/llm-scope-migration-summary.json
//   { scoped_total, migrated, skipped, errors, applied: bool, startedAt, finishedAt }
//
// Exit 0 on success, 1 on hard failure.

'use strict';

const fs = require('fs');
const path = require('path');

const SUMMARY_PATH = '/tmp/llm-scope-migration-summary.json';
const MIGRATION_VERSION = 'v1.0-phase-f1a';

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    if (a === '--apply') args.apply = true;
    if (a === '--help' || a === '-h') args.help = true;
  }
  // Default to dry-run when neither flag is provided to be safe.
  if (!args.dryRun && !args.apply) args.dryRun = true;
  return args;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`Usage: node scripts/migrate-llm-scope-schema.js [--dry-run|--apply]

  --dry-run   Identify scopes/versions that would be migrated; no writes.
  --apply     Persist the additive backfill.

Output summary: ${SUMMARY_PATH}
`);
}

function needsBackfill(data) {
  if (!data || typeof data !== 'object') return true;
  const fields = ['userTemplate', 'outputSchemaHint', 'modelOverride', 'generationConfig'];
  return fields.every((f) => typeof data[f] === 'undefined');
}

function buildBackfillPayload() {
  return {
    userTemplate: '',
    outputSchemaHint: '',
    modelOverride: null,
    generationConfig: {},
    migrationVersion: MIGRATION_VERSION,
  };
}

function needsScopeTenantOverrides(scopeData) {
  if (!scopeData || typeof scopeData !== 'object') return true;
  return typeof scopeData.tenantOverrides === 'undefined';
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const apply = !!args.apply && !args.dryRun;

  const startedAt = new Date().toISOString();
  const summary = {
    startedAt,
    finishedAt: null,
    applied: apply,
    mode: apply ? 'apply' : 'dry-run',
    scoped_total: 0,
    versions_total: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  let firestore;
  try {
    // Lazy-require so unit tests that don't touch GCP can import this file
    // (e.g. to call parseArgs/needsBackfill) without crashing.
    ({ firestore } = require('../lib/firestore'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[migrate-llm-scope-schema] Cannot load firestore client: ${err.message}`);
    summary.errors++;
    summary.finishedAt = new Date().toISOString();
    safeWriteSummary(summary);
    process.exit(1);
  }

  let scopeDocs;
  try {
    const snap = await firestore.collection('llmScopes').get();
    scopeDocs = snap.docs || [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[migrate-llm-scope-schema] Failed to list llmScopes: ${err.message}`);
    summary.errors++;
    summary.finishedAt = new Date().toISOString();
    safeWriteSummary(summary);
    process.exit(1);
  }

  summary.scoped_total = scopeDocs.length;

  for (const scopeSnap of scopeDocs) {
    const scopeId = scopeSnap.id;
    const scopeData = scopeSnap.data() || {};
    const scopeRef = scopeSnap.ref;

    // Step 1 — ensure tenantOverrides field on the scope-doc itself.
    try {
      if (needsScopeTenantOverrides(scopeData)) {
        if (apply) {
          await scopeRef.set(
            { tenantOverrides: {}, migrationVersion: MIGRATION_VERSION },
            { merge: true }
          );
        }
        summary.details.push({
          scopeId,
          versionId: null,
          action: 'scope_tenantOverrides_backfilled',
          applied: apply,
        });
        summary.migrated++;
      } else {
        summary.details.push({ scopeId, versionId: null, action: 'scope_already_migrated', applied: false });
        summary.skipped++;
      }
    } catch (err) {
      summary.errors++;
      summary.details.push({
        scopeId,
        versionId: null,
        action: 'scope_error',
        error: err.message,
      });
    }

    // Step 2 — backfill each version-doc under the scope.
    let versionDocs = [];
    try {
      const vsnap = await scopeRef.collection('versions').get();
      versionDocs = vsnap.docs || [];
    } catch (err) {
      summary.errors++;
      summary.details.push({
        scopeId,
        versionId: null,
        action: 'versions_list_error',
        error: err.message,
      });
      continue;
    }

    summary.versions_total += versionDocs.length;

    for (const vSnap of versionDocs) {
      const versionId = vSnap.id;
      try {
        const vData = vSnap.data() || {};
        if (!needsBackfill(vData)) {
          summary.skipped++;
          summary.details.push({ scopeId, versionId, action: 'version_already_migrated', applied: false });
          continue;
        }
        const payload = buildBackfillPayload();
        if (apply) {
          await vSnap.ref.set(payload, { merge: true });
        }
        summary.migrated++;
        summary.details.push({ scopeId, versionId, action: 'version_backfilled', applied: apply });
      } catch (err) {
        summary.errors++;
        summary.details.push({
          scopeId,
          versionId,
          action: 'version_error',
          error: err.message,
        });
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  safeWriteSummary(summary);

  // eslint-disable-next-line no-console
  console.log(
    `[migrate-llm-scope-schema] mode=${summary.mode} scopes=${summary.scoped_total} versions=${summary.versions_total} ` +
      `migrated=${summary.migrated} skipped=${summary.skipped} errors=${summary.errors} -> ${SUMMARY_PATH}`
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

function safeWriteSummary(summary) {
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[migrate-llm-scope-schema] Failed to write summary file: ${err.message}`);
  }
}

module.exports = {
  parseArgs,
  needsBackfill,
  needsScopeTenantOverrides,
  buildBackfillPayload,
  MIGRATION_VERSION,
  SUMMARY_PATH,
};

if (require.main === module) {
  // Top-level await polyfill via promise chain.
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[migrate-llm-scope-schema] Fatal: ${err.stack || err.message}`);
    try {
      fs.writeFileSync(
        SUMMARY_PATH,
        JSON.stringify({ error: err.message, finishedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch (_) {}
    process.exit(1);
  });
}

// path used implicitly by safeWriteSummary but require it once to satisfy lint
void path;
