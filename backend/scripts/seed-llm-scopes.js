#!/usr/bin/env node
// CommonJS. 2 Spaces. Single Quotes.
//
// seed-llm-scopes.js — Phase F.2 Master-Seed
//
// Reads ALL scope JSON files from backend/lib/llm-prompts/scopes/*.json and
// seeds them into Firestore collection `llmScopes`.
//
// Per file:
//   - If scope doc doesn't exist:
//       create scope doc + initial active version, activate it.
//   - If scope doc exists AND content differs from active version:
//       create a NEW version, do NOT auto-activate
//       (requires manual review in admin UI).
//   - If scope doc exists AND content matches active version:
//       no-op.
//
// Idempotent. Defaults to --dry-run when no flag passed.
//
// Graceful-Stub-Mode: if Firestore cannot be loaded (e.g. local without
// credentials), the script still runs in dry-run mode against the parsed JSON
// files and reports what *would* be created without crashing — exits 0.
//
// Usage:
//   node scripts/seed-llm-scopes.js --dry-run    (default)
//   node scripts/seed-llm-scopes.js --apply
//   node scripts/seed-llm-scopes.js --dir <path>
//
// Output: JSON summary at /tmp/llm-scopes-seed-summary.json
//   { scopes_processed, scopes_created, versions_created, no_op,
//     errors, applied, startedAt, finishedAt, details[] }
//
// Exit 0 on success, 1 on hard failure.

'use strict';

const fs = require('fs');
const path = require('path');

const SUMMARY_PATH = '/tmp/llm-scopes-seed-summary.json';
const DEFAULT_SCOPES_DIR = path.resolve(__dirname, '..', 'lib', 'llm-prompts', 'scopes');

const VERSION_CONTENT_FIELDS = Object.freeze([
  'promptText',
  'rulesText',
  'promptMode',
  'rulesMode',
  'userTemplate',
  'outputSchemaHint',
  'modelOverride',
  'generationConfig',
]);

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, dir: DEFAULT_SCOPES_DIR, help: false };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dir' && list[i + 1]) args.dir = path.resolve(list[++i]);
    else if (a.startsWith('--dir=')) args.dir = path.resolve(a.slice('--dir='.length));
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (!args.dryRun && !args.apply) args.dryRun = true;
  return args;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`Usage: node scripts/seed-llm-scopes.js [--dry-run|--apply] [--dir <path>]

  --dry-run   Identify what would be created/updated; no writes (default).
  --apply     Persist the seed operations to Firestore.
  --dir       Override the scopes directory (default: ${DEFAULT_SCOPES_DIR}).

Output summary: ${SUMMARY_PATH}
`);
}

function readScopeFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    const e = new Error(`seed-llm-scopes: cannot read dir '${dir}': ${err.message}`);
    e.cause = err;
    throw e;
  }
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = JSON.parse(raw);
      out.push({ file, full, payload: parsed });
    } catch (err) {
      out.push({ file, full, parseError: err.message });
    }
  }
  return out;
}

/**
 * Returns the canonical scope-id for a file payload, accepting either
 * `scopeId` (F.2.B-style) or `id` (F.2.A-style) — F.2.A files use a mix and we
 * must seed both unchanged.
 */
function extractScopeId(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.scopeId === 'string' && p.scopeId.trim()) return p.scopeId.trim();
  if (typeof p.id === 'string' && p.id.trim()) return p.id.trim();
  return '';
}

/**
 * Returns the version source-block. Two F.2 shapes are supported:
 *   1. Nested: payload.version is an object with promptText/rulesText/... fields.
 *   2. Flat:   payload.version is a string label (e.g. 'v1.0-phase-f2') and the
 *              prompt-fields live at the top of the payload.
 */
function extractVersionSource(p) {
  if (!p || typeof p !== 'object') return {};
  if (p.version && typeof p.version === 'object') return p.version;
  // Flat-shape fallback: pick fields from top-level.
  return {
    promptText: p.promptText,
    rulesText: p.rulesText,
    promptMode: p.promptMode,
    rulesMode: p.rulesMode,
    note: p.note || (typeof p.version === 'string' ? p.version : null),
    userTemplate: p.userTemplate,
    outputSchemaHint: p.outputSchemaHint,
    modelOverride: p.modelOverride,
    generationConfig: p.generationConfig,
  };
}

function validateScopePayload(p) {
  if (!p || typeof p !== 'object') return 'payload not an object';
  const scopeId = extractScopeId(p);
  if (!scopeId) return 'scopeId/id missing';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'name missing';
  if (typeof p.purpose !== 'string') return 'purpose missing';
  const v = extractVersionSource(p);
  if (!v || typeof v !== 'object') return 'version source missing';
  if (typeof v.promptText !== 'string') return 'promptText missing';
  if (typeof v.rulesText !== 'string') return 'rulesText missing';
  return null;
}

function buildVersionPayload(versionFromFile) {
  const v = versionFromFile || {};
  return {
    promptText: String(v.promptText || ''),
    rulesText: String(v.rulesText || ''),
    promptMode: v.promptMode === 'replace' ? 'replace' : 'append',
    rulesMode: v.rulesMode === 'replace' ? 'replace' : 'append',
    note: v.note ? String(v.note).slice(0, 500) : null,
    userTemplate: typeof v.userTemplate === 'string' ? v.userTemplate : '',
    outputSchemaHint: typeof v.outputSchemaHint === 'string' ? v.outputSchemaHint : '',
    modelOverride: typeof v.modelOverride === 'string' ? v.modelOverride : null,
    generationConfig:
      v.generationConfig && typeof v.generationConfig === 'object' ? v.generationConfig : {},
    seededByScript: 'seed-llm-scopes',
    sourceFile: null, // filled by caller
  };
}

/**
 * Compares the version payload from the JSON file against the active version
 * already in Firestore. Returns true if content is identical (all whitelisted
 * fields match).
 */
function versionContentMatches(filePayload, existingVersionData) {
  if (!existingVersionData || typeof existingVersionData !== 'object') return false;
  for (const key of VERSION_CONTENT_FIELDS) {
    const a = filePayload[key];
    const b = existingVersionData[key];
    // generationConfig is an object — deep-equal via JSON serialization.
    if (key === 'generationConfig') {
      const aSer = JSON.stringify(a || {});
      const bSer = JSON.stringify(b || {});
      if (aSer !== bSer) return false;
      continue;
    }
    // Other fields are strings or null. Coerce empty/null to '' for comparison.
    const aNorm = a == null ? '' : a;
    const bNorm = b == null ? '' : b;
    if (aNorm !== bNorm) return false;
  }
  return true;
}

function tryLoadFirestore() {
  try {
    const { firestore } = require('../lib/firestore');
    if (!firestore || typeof firestore.collection !== 'function') {
      return { firestore: null, error: 'firestore export missing or invalid' };
    }
    return { firestore, error: null };
  } catch (err) {
    return { firestore: null, error: err.message };
  }
}

function tryLoadFieldValue() {
  try {
    const mod = require('@google-cloud/firestore');
    if (mod && mod.FieldValue) return mod.FieldValue;
  } catch (_) { /* ignore */ }
  return { serverTimestamp: () => new Date().toISOString() };
}

async function processScopeFile(firestore, FieldValue, scope, { apply, summary }) {
  const { file, payload, parseError } = scope;
  if (parseError) {
    summary.errors++;
    summary.details.push({ file, action: 'parse_error', error: parseError });
    return;
  }
  const validationError = validateScopePayload(payload);
  if (validationError) {
    summary.errors++;
    summary.details.push({ file, scopeId: payload?.scopeId || null, action: 'validation_error', error: validationError });
    return;
  }

  const scopeId = extractScopeId(payload);
  summary.scopes_processed++;

  // Build version payload + scope-doc payload from the file.
  // versionSource handles both nested (payload.version: object) and flat
  // (top-level promptText/rulesText/...) F.2 file shapes.
  const versionSource = extractVersionSource(payload);
  const versionPayload = buildVersionPayload(versionSource);
  versionPayload.sourceFile = file;

  const scopeDocPayload = {
    scopeId,
    name: payload.name,
    purpose: payload.purpose || '',
    defaultModelEnvKey: typeof payload.defaultModelEnvKey === 'string' ? payload.defaultModelEnvKey : '',
    tenantOverrides:
      payload.tenantOverrides && typeof payload.tenantOverrides === 'object' ? payload.tenantOverrides : {},
    updatedAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString(),
  };

  // STUB-MODE: no firestore — report as would-be action only.
  if (!firestore) {
    summary.details.push({
      file,
      scopeId,
      action: 'stub_would_create_scope_and_version',
      applied: false,
    });
    summary.scopes_created++;
    summary.versions_created++;
    return;
  }

  const scopeRef = firestore.collection('llmScopes').doc(scopeId);
  let scopeSnap;
  try {
    scopeSnap = await scopeRef.get();
  } catch (err) {
    summary.errors++;
    summary.details.push({ file, scopeId, action: 'firestore_read_error', error: err.message });
    return;
  }

  // Case A — Scope doesn't exist: create scope-doc + first active version.
  if (!scopeSnap.exists) {
    if (!apply) {
      summary.scopes_created++;
      summary.versions_created++;
      summary.details.push({ file, scopeId, action: 'would_create_scope_and_version', applied: false });
      return;
    }
    try {
      // 1. Create the version doc first (to know its id), with createdAt.
      const versionRef = scopeRef.collection('versions').doc();
      await versionRef.set({
        ...versionPayload,
        createdAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString(),
        createdByUid: null,
      });
      // 2. Create scope doc with activeVersionId pointing to it.
      await scopeRef.set(
        {
          ...scopeDocPayload,
          activeVersionId: versionRef.id,
          createdAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString(),
          activatedByUid: null,
        },
        { merge: true }
      );
      summary.scopes_created++;
      summary.versions_created++;
      summary.details.push({
        file,
        scopeId,
        action: 'created_scope_and_version',
        versionId: versionRef.id,
        applied: true,
      });
    } catch (err) {
      summary.errors++;
      summary.details.push({ file, scopeId, action: 'create_error', error: err.message });
    }
    return;
  }

  // Case B — Scope exists. Compare with active version.
  const existingData = scopeSnap.data() || {};
  const activeVersionId = existingData.activeVersionId || null;

  let activeVersionData = null;
  if (activeVersionId) {
    try {
      const vSnap = await scopeRef.collection('versions').doc(String(activeVersionId)).get();
      if (vSnap.exists) activeVersionData = vSnap.data() || {};
    } catch (err) {
      summary.errors++;
      summary.details.push({ file, scopeId, action: 'firestore_read_version_error', error: err.message });
      return;
    }
  }

  if (activeVersionData && versionContentMatches(versionPayload, activeVersionData)) {
    summary.no_op++;
    summary.details.push({
      file,
      scopeId,
      action: 'no_op_identical',
      versionId: activeVersionId,
      applied: false,
    });
    return;
  }

  // Content differs — create a new version, but DO NOT auto-activate.
  if (!apply) {
    summary.versions_created++;
    summary.details.push({
      file,
      scopeId,
      action: 'would_create_new_version_no_auto_activate',
      activeVersionId,
      applied: false,
    });
    return;
  }

  try {
    const versionRef = scopeRef.collection('versions').doc();
    await versionRef.set({
      ...versionPayload,
      createdAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString(),
      createdByUid: null,
    });
    // Also refresh tenantOverrides + defaultModelEnvKey on scope-doc, but
    // DO NOT touch activeVersionId — that requires admin review.
    await scopeRef.set(
      {
        name: scopeDocPayload.name,
        purpose: scopeDocPayload.purpose,
        defaultModelEnvKey: scopeDocPayload.defaultModelEnvKey,
        updatedAt: scopeDocPayload.updatedAt,
      },
      { merge: true }
    );
    summary.versions_created++;
    summary.details.push({
      file,
      scopeId,
      action: 'created_new_version_pending_activation',
      versionId: versionRef.id,
      activeVersionId,
      applied: true,
    });
  } catch (err) {
    summary.errors++;
    summary.details.push({ file, scopeId, action: 'create_version_error', error: err.message });
  }
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
    dir: args.dir,
    scopes_processed: 0,
    scopes_created: 0,
    versions_created: 0,
    no_op: 0,
    errors: 0,
    stubMode: false,
    details: [],
  };

  let files = [];
  try {
    files = readScopeFiles(args.dir);
  } catch (err) {
    summary.errors++;
    summary.finishedAt = new Date().toISOString();
    summary.details.push({ action: 'dir_read_error', error: err.message });
    safeWriteSummary(summary);
    // eslint-disable-next-line no-console
    console.error(`[seed-llm-scopes] ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    summary.finishedAt = new Date().toISOString();
    safeWriteSummary(summary);
    // eslint-disable-next-line no-console
    console.log(`[seed-llm-scopes] No JSON files found in ${args.dir}. Exiting cleanly.`);
    process.exit(0);
  }

  const fsLoad = tryLoadFirestore();
  if (!fsLoad.firestore) {
    summary.stubMode = true;
    if (apply) {
      // Hard failure when --apply requested but no Firestore.
      summary.errors++;
      summary.finishedAt = new Date().toISOString();
      summary.details.push({ action: 'firestore_unavailable_under_apply', error: fsLoad.error });
      safeWriteSummary(summary);
      // eslint-disable-next-line no-console
      console.error(
        `[seed-llm-scopes] --apply requested but Firestore unavailable: ${fsLoad.error}. Aborting.`
      );
      process.exit(1);
    }
    // Dry-run is OK in stub mode — we still validate files + report what would happen.
    // eslint-disable-next-line no-console
    console.warn(
      `[seed-llm-scopes] Firestore unavailable (${fsLoad.error}). Running in DRY-RUN + STUB-MODE.`
    );
  }

  const FieldValue = tryLoadFieldValue();

  for (const scope of files) {
    // eslint-disable-next-line no-await-in-loop
    await processScopeFile(fsLoad.firestore, FieldValue, scope, { apply, summary });
  }

  summary.finishedAt = new Date().toISOString();
  safeWriteSummary(summary);

  // eslint-disable-next-line no-console
  console.log(
    `[seed-llm-scopes] mode=${summary.mode}${summary.stubMode ? ' (stub)' : ''} ` +
      `files=${files.length} scopes_processed=${summary.scopes_processed} ` +
      `scopes_created=${summary.scopes_created} versions_created=${summary.versions_created} ` +
      `no_op=${summary.no_op} errors=${summary.errors} -> ${SUMMARY_PATH}`
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

function safeWriteSummary(summary) {
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[seed-llm-scopes] Failed to write summary: ${err.message}`);
  }
}

module.exports = {
  parseArgs,
  readScopeFiles,
  extractScopeId,
  extractVersionSource,
  validateScopePayload,
  buildVersionPayload,
  versionContentMatches,
  processScopeFile,
  tryLoadFirestore,
  tryLoadFieldValue,
  VERSION_CONTENT_FIELDS,
  DEFAULT_SCOPES_DIR,
  SUMMARY_PATH,
};

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[seed-llm-scopes] Fatal: ${err.stack || err.message}`);
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
