/* eslint-disable no-console */
/**
 * Repair products whose identification.category is NOT in the Avy taxonomy.
 *
 * It uses the previously generated LLM apply_report.json as source of truth.
 * No new categorization is performed here.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules \
 *     node backend/scripts/avy-repair-invalid-categories.js \
 *     --report "exports/avy-category-llm/20260203-042824/apply_report.json" --apply
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

  const taxonomyPath = path.join(process.cwd(), 'backend', 'avy-taxonomy', 'avy-taxonomy.json');
  const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
  const taxonomySet = new Set((taxonomy?.categories || []).map((x) => safeString(x)).filter(Boolean));

  const reportPath = path.isAbsolute(args.report) ? args.report : path.join(process.cwd(), args.report);
  const reportRaw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const reportList = Array.isArray(reportRaw) ? reportRaw : [];
  const reportMap = new Map();
  for (const r of reportList) {
    if (r?.status === 'update' && r?.docId && r?.category_after) {
      reportMap.set(String(r.docId), safeString(r.category_after));
    }
  }

  const snap = await firestore.collection('products').get();
  const invalid = [];
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const cat = safeString(data?.identification?.category);
    if (!cat) return;
    if (taxonomySet.has(cat)) return;
    invalid.push({ id: doc.id, before: cat });
  });

  console.log(
    JSON.stringify(
      {
        action: 'avy-repair-invalid-categories',
        project: PROJECT_ID,
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        total: snap.size,
        taxonomy: taxonomySet.size,
        invalid: invalid.length,
        report_items: reportList.length,
        report_map: reportMap.size,
      },
      null,
      2
    )
  );

  if (!args.apply) return;

  let batch = firestore.batch();
  let batchCount = 0;
  let fixed = 0;
  let missingInReport = 0;
  const commit = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  const nowIso = new Date().toISOString();
  for (const item of invalid) {
    const target = reportMap.get(item.id);
    if (!target || !taxonomySet.has(target)) {
      missingInReport += 1;
      continue;
    }
    const ref = firestore.collection('products').doc(item.id);
    batch.update(ref, {
      'identification.category': target,
      'ops.avy_category': {
        by: 'repair_from_report',
        updated_iso: nowIso,
        previous: item.before,
        source_report: path.basename(reportPath),
      },
    });
    batchCount += 1;
    fixed += 1;
    if (batchCount >= 400) {
      await commit();
      console.log(JSON.stringify({ progress_fixed: fixed, remaining: invalid.length - fixed }, null, 2));
    }
  }
  await commit();

  console.log(JSON.stringify({ done: true, fixed, missingInReport }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

