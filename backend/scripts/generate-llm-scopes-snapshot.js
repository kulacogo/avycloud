#!/usr/bin/env node
// CommonJS. 2 Spaces. Single Quotes.
//
// generate-llm-scopes-snapshot.js — Phase F.1a Bundled Snapshot
//
// Reads the active scope-versions from Firestore (`llmScopes`) and writes a
// single bundled snapshot file:
//
//   backend/lib/llm-scopes-snapshot.json
//
// The snapshot ships with the Cloud-Run image so that `loadScopeWithFallback()`
// can serve scope-configs even when Firestore is unreachable (cold-start,
// regional outage, mis-permissioned service account). This avoids drift back
// to in-code hardcoded defaults.
//
// Usage:
//   node scripts/generate-llm-scopes-snapshot.js
//   node scripts/generate-llm-scopes-snapshot.js --out /path/to/snapshot.json
//
// JSON shape:
//   {
//     snapshotGeneratedAt: ISO-string,
//     scopes: [
//       {
//         id, name, purpose, defaultModelEnvKey, activeVersionId, versionId,
//         promptText, rulesText, promptMode, rulesMode,
//         userTemplate, outputSchemaHint, modelOverride, generationConfig,
//         tenantOverrides
//       },
//       ...
//     ]
//   }
//
// Exit 0 on success, 1 on failure.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_OUT = path.resolve(__dirname, '..', 'lib', 'llm-scopes-snapshot.json');

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, help: false, afterSeed: false };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--out' && list[i + 1]) {
      args.out = path.resolve(list[++i]);
    } else if (a.startsWith('--out=')) {
      args.out = path.resolve(a.slice('--out='.length));
    } else if (a === '--after-seed') {
      // F.2.B addition: signals that this run follows a seed-llm-scopes apply
      // and is expected to find all 12 scopes (8 F.2.A + 4 F.2.B).
      args.afterSeed = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

const EXPECTED_SCOPE_IDS_AFTER_SEED = Object.freeze([
  'identify.attributes',
  'identify.category',
  'identify.critic',
  'identify.gpsr',
  'identify.identity',
  'identify.image',
  'identify.pricing',
  'identify.seo_description',
  'identify.seo_title',
  'chat.product',
  'chat.update_datasheet',
  'quality.gate',
]);

function pickVersionFields(versionData) {
  const v = versionData || {};
  return {
    promptText: String(v.promptText || ''),
    rulesText: String(v.rulesText || ''),
    promptMode: v.promptMode === 'replace' ? 'replace' : 'append',
    rulesMode: v.rulesMode === 'replace' ? 'replace' : 'append',
    note: typeof v.note === 'string' ? v.note : null,
    userTemplate: typeof v.userTemplate === 'string' ? v.userTemplate : '',
    outputSchemaHint: typeof v.outputSchemaHint === 'string' ? v.outputSchemaHint : '',
    modelOverride: typeof v.modelOverride === 'string' ? v.modelOverride : null,
    generationConfig:
      v.generationConfig && typeof v.generationConfig === 'object' ? v.generationConfig : {},
  };
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(`Usage: node scripts/generate-llm-scopes-snapshot.js [--out <file>]

Reads active scope-versions from Firestore and writes them to <file>
(default: ${DEFAULT_OUT}).
`);
    process.exit(0);
  }

  let firestore;
  try {
    ({ firestore } = require('../lib/firestore'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[generate-llm-scopes-snapshot] Cannot load firestore: ${err.message}`);
    process.exit(1);
  }

  let scopeSnap;
  try {
    scopeSnap = await firestore.collection('llmScopes').get();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[generate-llm-scopes-snapshot] Failed to list llmScopes: ${err.message}`);
    process.exit(1);
  }

  const scopes = [];
  for (const sDoc of scopeSnap.docs || []) {
    const scopeId = sDoc.id;
    const scopeData = sDoc.data() || {};
    const activeVersionId = scopeData.activeVersionId || null;

    let versionPayload = pickVersionFields({});
    let versionIdResolved = null;
    if (activeVersionId) {
      try {
        const vSnap = await sDoc.ref.collection('versions').doc(String(activeVersionId)).get();
        if (vSnap.exists) {
          versionPayload = pickVersionFields(vSnap.data());
          versionIdResolved = vSnap.id;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[generate-llm-scopes-snapshot] Failed to read version ${activeVersionId} for scope ${scopeId}: ${err.message}`
        );
      }
    }

    scopes.push({
      id: scopeId,
      name: typeof scopeData.name === 'string' ? scopeData.name : scopeId,
      purpose: typeof scopeData.purpose === 'string' ? scopeData.purpose : '',
      defaultModelEnvKey: typeof scopeData.defaultModelEnvKey === 'string' ? scopeData.defaultModelEnvKey : '',
      activeVersionId,
      versionId: versionIdResolved,
      tenantOverrides:
        scopeData.tenantOverrides && typeof scopeData.tenantOverrides === 'object'
          ? scopeData.tenantOverrides
          : {},
      ...versionPayload,
    });
  }

  const payload = {
    snapshotGeneratedAt: new Date().toISOString(),
    schemaVersion: 'v1.0-phase-f1a',
    scopes,
  };

  // F.2.B addition: when --after-seed is set, warn (don't fail) on missing
  // scope-ids. This is the post-seed integration handshake.
  let missingAfterSeed = [];
  if (args.afterSeed) {
    const presentIds = new Set(scopes.map((s) => s.id));
    missingAfterSeed = EXPECTED_SCOPE_IDS_AFTER_SEED.filter((id) => !presentIds.has(id));
    if (missingAfterSeed.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[generate-llm-scopes-snapshot] --after-seed: ${missingAfterSeed.length} expected scope(s) missing: ${missingAfterSeed.join(', ')}`
      );
    }
    payload.afterSeedMissing = missingAfterSeed;
  }

  try {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[generate-llm-scopes-snapshot] Failed to write ${args.out}: ${err.message}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[generate-llm-scopes-snapshot] Wrote ${scopes.length} scope(s) -> ${args.out} ` +
      `(generatedAt=${payload.snapshotGeneratedAt})${args.afterSeed ? ` afterSeed-missing=${missingAfterSeed.length}` : ''}`
  );
  process.exit(0);
}

module.exports = { parseArgs, pickVersionFields, DEFAULT_OUT, EXPECTED_SCOPE_IDS_AFTER_SEED };

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[generate-llm-scopes-snapshot] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
