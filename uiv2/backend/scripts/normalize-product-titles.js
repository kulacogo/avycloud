/* eslint-disable no-console */
/**
 * Normalize product titles to policy:
 * - Mobile-first + SEO: Brand + ProductType + Model/MPN must be within first ~60 chars
 * - Fixed order: [BRAND] [PRODUCT TYPE] [MODEL/MPN] [CORE SPEC] [VARIANT] [CONDITION]
 * - Optimal length 65–75 chars, hard max 80
 * - no SKU/internal ids, no emojis, no marketing fluff
 * - no "Gebraucht/Used" unless ops.condition_locked
 *
 * Safety:
 * - Update-only with strict pre/post count guard.
 * - By default, do NOT touch products last saved by UI (ops.last_saved_source === 'ui').
 *
 * Usage:
 *   node backend/scripts/normalize-product-titles.js --dry-run
 *   node backend/scripts/normalize-product-titles.js --apply --expected-count 420
 *
 * Optional:
 *   --include-ui   (also update UI-saved products; NOT recommended)
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { coerceTitleToPolicy, validateTitleToPolicy } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');
const { inferTitleCategory } = require('../lib/title-policy');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function pickSku(product, docId) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(docId) ||
    ''
  );
}

function needsFix(product, title = '') {
  const cfg = getRulebookConfigCached();
  const bucket = inferTitleCategory(product);
  const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
  const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
  const maxLen = Number(rule?.maxLen || 80);
  const mobileMaxLen = Number(rule?.mobileMaxLen || 60);
  const issues = validateTitleToPolicy(product, title, { maxLen, mobileMaxLen });
  return Array.isArray(issues) && issues.length > 0;
}

function findZustandKey(attributes) {
  if (!attributes || typeof attributes !== 'object') return null;
  const keys = Object.keys(attributes);
  return keys.find((k) => String(k || '').trim().toLowerCase() === 'zustand') || null;
}

function isUsedWord(text = '') {
  return /\b(gebraucht|used|pre[-\s]?owned|second hand|b-ware|refurb(?:ished)?|renewed)\b/i.test(String(text || ''));
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: 0, includeUi: false };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--include-ui') {
      args.includeUi = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'title-normalize', stamp);
  ensureDir(outDir);

  console.log(`[title-normalize] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[title-normalize] preCount=${preCount}`);
  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[title-normalize] ABORT: --apply requires --expected-count <number>');
    }
    if (preCount !== args.expectedCount) {
      throw new Error(`[title-normalize] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
    }
  }

  const report = [];
  const summary = {
    preCount,
    total: preCount,
    considered: 0,
    skipped_ui: 0,
    update: 0,
    noop: 0,
    invalid_after: 0,
    reasons: {},
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sku = pickSku(data, doc.id);
    const currentTitle = safeString(data?.identification?.name);
    const lastSource = safeString(data?.ops?.last_saved_source) || 'unknown';

    if (!args.includeUi && lastSource === 'ui') {
      summary.skipped_ui += 1;
      continue;
    }

    summary.considered += 1;
    const cfg = getRulebookConfigCached();
    const bucket = inferTitleCategory(data);
    const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
    const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
    const minLen = Number(rule?.minLen || 65);
    const softMaxLen = Number(rule?.softMaxLen || 75);
    const maxLen = Number(rule?.maxLen || 80);
    const mobileMaxLen = Number(rule?.mobileMaxLen || 60);

    const beforeIssues = validateTitleToPolicy(data, currentTitle, { maxLen, mobileMaxLen });
    if (!needsFix(data, currentTitle)) continue;

    const nextTitle = coerceTitleToPolicy(data, currentTitle, { minLen, maxLen, softMaxLen });
    const nextLen = safeString(nextTitle).length;
    const afterIssues = validateTitleToPolicy(data, nextTitle, { maxLen, mobileMaxLen });
    if (!nextTitle || nextLen === 0 || nextLen > 80) {
      summary.invalid_after += 1;
      summary.reasons.could_not_coerce = (summary.reasons.could_not_coerce || 0) + 1;
      report.push({
        docId: doc.id,
        sku,
        lastSource,
        status: 'skip',
        reason: 'could_not_coerce',
        before: currentTitle,
        before_len: currentTitle.length,
        before_issues: Array.isArray(beforeIssues) ? beforeIssues.join('|') : '',
        after: nextTitle,
        after_len: nextLen,
        after_issues: Array.isArray(afterIssues) ? afterIssues.join('|') : '',
      });
      continue;
    }

    if (nextTitle === currentTitle) {
      summary.noop += 1;
      continue;
    }

    // Zustand attribute sanitization:
    // If Zustand is "used/gebraucht" but not condition_locked, normalize to NEU to prevent downstream leakage.
    const attrs =
      data?.details?.attributes && typeof data.details.attributes === 'object'
        ? data.details.attributes
        : null;
    const zustandKey = findZustandKey(attrs);
    const conditionLocked = Boolean(data?.ops?.condition_locked);
    const zustandVal = zustandKey ? attrs[zustandKey] : null;
    const shouldSanitizeZustand = Boolean(zustandKey) && !conditionLocked && isUsedWord(zustandVal);

    const updates = {
      'identification.name': nextTitle,
      'ops.last_saved_source': 'title-normalize-v2',
      'ops.last_saved_iso': new Date().toISOString(),
      'ops.data_quality': {
        ...(data?.ops?.data_quality || {}),
        title_policy_v2: {
          iso: new Date().toISOString(),
          before: currentTitle,
          after: nextTitle,
          before_len: currentTitle.length,
          after_len: nextLen,
          before_issues: Array.isArray(beforeIssues) ? beforeIssues : [],
          after_issues: Array.isArray(afterIssues) ? afterIssues : [],
        },
      },
    };
    if (shouldSanitizeZustand) {
      updates[`details.attributes.${zustandKey}`] = 'NEU';
      updates['ops.data_quality'] = {
        ...(updates['ops.data_quality'] || {}),
        condition_sanitized_v1: {
          iso: new Date().toISOString(),
          before: String(zustandVal ?? ''),
          after: 'NEU',
          locked: false,
        },
      };
    }

    summary.update += 1;
    report.push({
      docId: doc.id,
      sku,
      lastSource,
      status: 'update',
      before: currentTitle,
      before_len: currentTitle.length,
      before_issues: Array.isArray(beforeIssues) ? beforeIssues.join('|') : '',
      after: nextTitle,
      after_len: nextLen,
      after_issues: Array.isArray(afterIssues) ? afterIssues.join('|') : '',
      updates: args.apply ? undefined : updates,
    });
  }

  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  // Also write a small CSV preview for easy filtering
  const headers = ['sku', 'docId', 'lastSource', 'status', 'before_len', 'after_len', 'before_issues', 'after_issues', 'before', 'after', 'reason'];
  const lines = [headers.join(',')];
  for (const row of report) {
    lines.push(
      headers
        .map((h) => csvEscape(row[h] ?? ''))
        .join(',')
    );
  }
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_rows.csv' : 'dryrun_rows.csv'), lines.join('\n'), 'utf8');

  console.log(`[title-normalize] considered=${summary.considered} skipped_ui=${summary.skipped_ui} update=${summary.update} noop=${summary.noop} invalid_after=${summary.invalid_after}`);

  if (!args.apply) {
    console.log('[title-normalize] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[title-normalize] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 30, maxOpsPerSecond: 200 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[title-normalize] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    if (item.status !== 'update') continue;
    const ref = firestore.collection('products').doc(item.docId);
    // Recompute updates from the snapshot we already have (stable for this run)
    const docData = snap.docs.find((d) => d.id === item.docId)?.data() || {};
    const currentTitle = safeString(docData?.identification?.name);
    const nextTitle = coerceTitleToPolicy(docData, currentTitle, { minLen: 65, maxLen: 80, softMaxLen: 75 });
    if (!nextTitle || nextTitle.length === 0 || nextTitle.length > 80) continue;
    if (nextTitle === currentTitle) continue;
    const attrs =
      docData?.details?.attributes && typeof docData.details.attributes === 'object'
        ? docData.details.attributes
        : null;
    const zustandKey = findZustandKey(attrs);
    const conditionLocked = Boolean(docData?.ops?.condition_locked);
    const zustandVal = zustandKey ? attrs[zustandKey] : null;
    const shouldSanitizeZustand = Boolean(zustandKey) && !conditionLocked && isUsedWord(zustandVal);
    const updates = {
      'identification.name': nextTitle,
      'ops.last_saved_source': 'title-normalize-v2',
      'ops.last_saved_iso': new Date().toISOString(),
      'ops.data_quality': {
        ...(docData?.ops?.data_quality || {}),
        title_policy_v2: {
          iso: new Date().toISOString(),
          before: currentTitle,
          after: nextTitle,
          before_len: currentTitle.length,
          after_len: nextTitle.length,
          before_issues: validateTitleToPolicy(docData, currentTitle, { maxLen: 80, mobileMaxLen: 60 }),
          after_issues: validateTitleToPolicy(docData, nextTitle, { maxLen: 80, mobileMaxLen: 60 }),
        },
      },
    };
    if (shouldSanitizeZustand) {
      updates[`details.attributes.${zustandKey}`] = 'NEU';
      updates['ops.data_quality'] = {
        ...(updates['ops.data_quality'] || {}),
        condition_sanitized_v1: {
          iso: new Date().toISOString(),
          before: String(zustandVal ?? ''),
          after: 'NEU',
          locked: false,
        },
      };
    }
    bulkWriter.update(ref, updates);
  }
  await bulkWriter.close();

  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[title-normalize] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[title-normalize] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[title-normalize] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


