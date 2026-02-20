/* eslint-disable no-console */
/**
 * Apply Avy category assignments from a previously generated LLM report.
 *
 * Why:
 * - The categorization run already produced a deterministic `apply_report.json` (docId -> category_after).
 * - This script reliably (re)applies those categories to Firestore with progress output.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules \
 *     node backend/scripts/avy-apply-categories-from-report.js \
 *     --report "exports/avy-category-llm/20260203-042824/apply_report.json" --apply
 *
 * Options:
 *   --report <path>     (required)
 *   --dry-run | --apply
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv) {
  const args = { report: '', dryRun: true, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--report') args.report = String(argv[i + 1] || ''), i += 1;
    else if (t === '--apply') args.apply = true, args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true, args.apply = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.report) throw new Error('Missing --report <path>');
  const reportPath = path.isAbsolute(args.report) ? args.report : path.join(process.cwd(), args.report);
  const raw = fs.readFileSync(reportPath, 'utf8');
  const items = JSON.parse(raw);
  const list = Array.isArray(items) ? items : [];

  const updates = list.filter((x) => x && x.status === 'update' && x.docId && x.category_after);

  console.log(
    JSON.stringify(
      {
        action: 'avy-apply-categories-from-report',
        project: PROJECT_ID,
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        reportPath,
        reportItems: list.length,
        updates: updates.length,
      },
      null,
      2
    )
  );

  if (!args.apply) return;

  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 10, maxOpsPerSecond: 50 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[avy-apply] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  const nowIso = new Date().toISOString();
  let applied = 0;
  for (const item of updates) {
    const docId = safeString(item.docId);
    const categoryAfter = safeString(item.category_after);
    if (!docId || !categoryAfter) continue;
    const patch = {
      'identification.category': categoryAfter,
      'ops.avy_category': {
        by: item.via === 'llm' ? 'gemini' : safeString(item.via || 'report'),
        model: safeString(item.model) || null,
        confidence: Number.isFinite(item.confidence) ? item.confidence : null,
        reason: safeString(item.reasonText) || null,
        used_fields: Array.isArray(item.used_fields) ? item.used_fields.slice(0, 20) : [],
        updated_iso: nowIso,
        previous: item.category_before ? safeString(item.category_before) : null,
        source_report: path.basename(reportPath),
      },
    };
    bulkWriter.update(firestore.collection('products').doc(docId), patch);
    applied += 1;
    if (applied % 100 === 0) console.log(JSON.stringify({ progress: applied, total: updates.length }, null, 2));
  }
  await bulkWriter.close();
  console.log(JSON.stringify({ done: true, applied }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

