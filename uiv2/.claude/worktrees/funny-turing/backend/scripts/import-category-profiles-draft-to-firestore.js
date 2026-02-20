/* eslint-disable no-console */
/**
 * Import Category Profiles draft JSON into Firestore collection `categoryProfiles/{ebayCategoryId}`.
 *
 * This does NOT change any products. It just seeds the profile documents that `saveProduct()`
 * can use for attribute alias normalization.
 *
 * Safety:
 * - Default mode is DRY RUN (no writes).
 * - You can optionally enable imported profiles (enabled=true) if you explicitly pass --enable.
 *
 * Usage:
 *   node backend/scripts/import-category-profiles-draft-to-firestore.js \
 *     --in exports/reconciliation/category-profiles-draft_YYYYMMDD-HHMMSS.json --dry-run
 *
 *   node backend/scripts/import-category-profiles-draft-to-firestore.js \
 *     --in exports/reconciliation/category-profiles-draft_YYYYMMDD-HHMMSS.json --apply
 *
 *   node backend/scripts/import-category-profiles-draft-to-firestore.js \
 *     --in exports/reconciliation/category-profiles-draft_YYYYMMDD-HHMMSS.json --apply --enable
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');

function parseArgs(argv) {
  const args = { inPath: null, dryRun: true, enable: false };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.inPath = argv[i + 1];
      i += 1;
    } else if (t === '--apply') {
      args.dryRun = false;
    } else if (t === '--dry-run') {
      args.dryRun = true;
    } else if (t === '--enable') {
      args.enable = true;
    }
  }
  return args;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.inPath) throw new Error('Missing --in <path-to-draft.json>');
  const abs = path.isAbsolute(args.inPath) ? args.inPath : path.join(process.cwd(), args.inPath);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const profiles = raw?.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const ids = Object.keys(profiles).map(String).filter(Boolean);
  if (!ids.length) throw new Error('Draft contains no profiles');

  const out = { total: ids.length, wouldWrite: 0, wrote: 0, skipped: 0 };

  for (const id of ids) {
    const p = profiles[id];
    if (!p || typeof p !== 'object') {
      out.skipped += 1;
      continue;
    }
    const payload = {
      id: safeString(p.id || id),
      enabled: Boolean(args.enable ? true : p.enabled),
      canonicalAttributes: Array.isArray(p.canonicalAttributes) ? p.canonicalAttributes : [],
      attributeAliases: p.attributeAliases && typeof p.attributeAliases === 'object' ? p.attributeAliases : {},
      notes: safeString(p.notes || ''),
      updatedAtIso: new Date().toISOString(),
    };

    out.wouldWrite += 1;
    if (args.dryRun) continue;
    await firestore.collection('categoryProfiles').doc(String(id)).set(payload, { merge: true });
    out.wrote += 1;
  }

  console.log('[category-profiles-import]', JSON.stringify({ in: abs, dryRun: args.dryRun, enable: args.enable, ...out }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

