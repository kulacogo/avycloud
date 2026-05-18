#!/usr/bin/env node
/**
 * audit-gcs-cruft.js — Read-only GCS bucket audit.
 *
 * Lists all GCS buckets in the active project (default creds) and for each
 * enumerates a sample of up to 200 objects, then reports:
 *   - Object count grouped by top-level prefix
 *   - Objects older than 90 days
 *   - Files matching test-/dev-/temp-/mock- patterns
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-gcs-cruft-YYYY-MM-DD.md
 *
 * READ-ONLY. Never deletes / mutates buckets or objects.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-gcs-cruft';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;
const SAMPLE_PER_BUCKET = 200;
const AGE_THRESHOLD_DAYS = 90;

const SUSPICIOUS_PREFIXES = ['test-', 'dev-', 'temp-', 'mock-'];

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

function escapePipe(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(rows) {
  if (rows.length <= MAX_ROWS_PER_CATEGORY) return { rows, overflow: 0 };
  return { rows: rows.slice(0, MAX_ROWS_PER_CATEGORY), overflow: rows.length - MAX_ROWS_PER_CATEGORY };
}

function writeRunReport(markdown) {
  try {
    if (!fs.existsSync(AUDIT_RUNS_DIR)) {
      fs.mkdirSync(AUDIT_RUNS_DIR, { recursive: true });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(AUDIT_RUNS_DIR, `${SCRIPT_NAME}-${stamp}.md`);
    fs.writeFileSync(dest, markdown, 'utf8');
    return dest;
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

function topPrefix(name) {
  const idx = name.indexOf('/');
  return idx === -1 ? '(root)' : name.slice(0, idx);
}

function formatBytes(b) {
  return (b / 1024 / 1024).toFixed(2);
}

function isSuspicious(name) {
  const base = name.split('/').pop() || '';
  return SUSPICIOUS_PREFIXES.some((p) => base.startsWith(p));
}

async function auditBucket(bucket) {
  const findings = [];
  const errors = [];
  let files = [];
  try {
    const [list] = await bucket.getFiles({ maxResults: SAMPLE_PER_BUCKET });
    files = list;
  } catch (err) {
    errors.push(`${bucket.name}: getFiles failed: ${err.message}`);
    return { findings, errors, totalSampled: 0 };
  }

  const byPrefix = new Map();
  const ninetyDaysAgo = Date.now() - AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  for (const file of files) {
    try {
      const prefix = topPrefix(file.name);
      const meta = file.metadata || {};
      const size = Number(meta.size || 0);
      const updated = meta.updated ? new Date(meta.updated).getTime() : 0;
      const created = meta.timeCreated ? new Date(meta.timeCreated).getTime() : 0;
      const ageRef = updated || created;

      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, {
          count: 0,
          totalSize: 0,
          oldestTs: Infinity,
          oldestName: '',
          oldCount: 0,
          suspiciousCount: 0,
        });
      }
      const agg = byPrefix.get(prefix);
      agg.count += 1;
      agg.totalSize += size;
      if (ageRef && ageRef < agg.oldestTs) {
        agg.oldestTs = ageRef;
        agg.oldestName = file.name;
      }
      if (ageRef && ageRef < ninetyDaysAgo) agg.oldCount += 1;
      if (isSuspicious(file.name)) agg.suspiciousCount += 1;
    } catch (err) {
      errors.push(`${bucket.name}/${file.name}: ${err.message}`);
    }
  }

  for (const [prefix, agg] of byPrefix.entries()) {
    let classification = 'ACTIVE';
    const reasons = [];
    if (agg.oldCount === agg.count && agg.count > 0) {
      classification = 'STALE';
      reasons.push(`all ${agg.count} objects > ${AGE_THRESHOLD_DAYS}d old`);
    } else if (agg.oldCount > 0) {
      reasons.push(`${agg.oldCount} objects > ${AGE_THRESHOLD_DAYS}d`);
    }
    if (agg.suspiciousCount > 0) {
      if (classification === 'ACTIVE') classification = 'SUSPECT';
      reasons.push(`${agg.suspiciousCount} test/dev/temp/mock files`);
    }
    findings.push({
      bucket: bucket.name,
      prefix,
      objectCount: agg.count,
      totalSizeMB: formatBytes(agg.totalSize),
      oldestObject: agg.oldestTs === Infinity ? '?' : `${new Date(agg.oldestTs).toISOString().slice(0, 10)} (${agg.oldestName})`,
      classification,
      reasons: reasons.join('; '),
    });
  }

  return { findings, errors, totalSampled: files.length };
}

function renderMarkdown(allFindings, meta, errors) {
  const out = [
    `# GCS Cruft Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Project: \`${meta.project_id || 'unknown'}\``,
    `Buckets scanned: ${meta.bucket_count}`,
    `Sample per bucket: ${SAMPLE_PER_BUCKET}`,
    `Errors: ${meta.errors_count}`,
    '',
    '## Bucket × Prefix',
    '',
    '| Bucket | Prefix | ObjectCount | TotalSizeMB | OldestObject | Classification |',
    '|--------|--------|-------------|-------------|--------------|----------------|',
  ];
  const { rows: shown, overflow } = truncate(allFindings);
  for (const r of shown) {
    const cls = r.reasons ? `${r.classification} (${r.reasons})` : r.classification;
    out.push(
      `| ${escapePipe(r.bucket)} | ${escapePipe(r.prefix)} | ${escapePipe(r.objectCount)} | ${escapePipe(r.totalSizeMB)} | ${escapePipe(r.oldestObject)} | ${escapePipe(cls)} |`,
    );
  }
  if (overflow > 0) out.push(`| ... | | | | | ${overflow} more (truncated) |`);
  out.push('');

  if (errors.length > 0) {
    out.push('## Errors');
    out.push('');
    for (const e of errors.slice(0, 50)) out.push(`- ${e}`);
    if (errors.length > 50) out.push(`- ... ${errors.length - 50} more (truncated)`);
  }
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  let projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;

  let Storage = null;
  try {
    ({ Storage } = require('@google-cloud/storage'));
  } catch (err) {
    const meta = {
      script: SCRIPT_NAME,
      generated_at: new Date().toISOString(),
      project_id: projectId,
      bucket_count: 0,
      errors_count: 1,
    };
    const md = `# GCS Cruft Audit — ${meta.generated_at.slice(0, 10)}\n\n_STORAGE_SDK_NOT_AVAILABLE_: ${err.message}\n`;
    meta.report_file = writeRunReport(md);
    if (args.json) {
      process.stdout.write(JSON.stringify({ meta, findings: [], errors: [err.message] }, null, 2) + '\n');
    } else {
      process.stdout.write(md);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  let storage;
  try {
    storage = new Storage();
  } catch (err) {
    const meta = { script: SCRIPT_NAME, generated_at: new Date().toISOString(), project_id: projectId, bucket_count: 0, errors_count: 1 };
    const md = `# GCS Cruft Audit — ${meta.generated_at.slice(0, 10)}\n\n_STORAGE_INIT_FAILED_: ${err.message}\n`;
    meta.report_file = writeRunReport(md);
    if (args.json) process.stdout.write(JSON.stringify({ meta, findings: [], errors: [err.message] }, null, 2) + '\n');
    else {
      process.stdout.write(md);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  if (!projectId) {
    try {
      projectId = await storage.getProjectId();
    } catch (_e) {
      // fine
    }
  }

  let buckets = [];
  try {
    const [list] = await storage.getBuckets();
    buckets = list;
  } catch (err) {
    const meta = { script: SCRIPT_NAME, generated_at: new Date().toISOString(), project_id: projectId, bucket_count: 0, errors_count: 1 };
    const md = `# GCS Cruft Audit — ${meta.generated_at.slice(0, 10)}\n\n_GCS_LIST_FAILED_: ${err.message}\n`;
    meta.report_file = writeRunReport(md);
    if (args.json) process.stdout.write(JSON.stringify({ meta, findings: [], errors: [err.message] }, null, 2) + '\n');
    else {
      process.stdout.write(md);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  const allFindings = [];
  for (const bucket of buckets) {
    try {
      const { findings, errors: bucketErrors } = await auditBucket(bucket);
      allFindings.push(...findings);
      errors.push(...bucketErrors);
    } catch (err) {
      errors.push(`${bucket.name}: ${err.message}`);
    }
  }

  allFindings.sort((a, b) => (a.bucket + a.prefix).localeCompare(b.bucket + b.prefix));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    project_id: projectId,
    bucket_count: buckets.length,
    errors_count: errors.length,
  };

  const markdown = renderMarkdown(allFindings, meta, errors);
  meta.report_file = writeRunReport(markdown);

  if (args.json) {
    process.stdout.write(JSON.stringify({ meta, findings: allFindings, errors: errors.slice(0, 50) }, null, 2) + '\n');
  } else {
    process.stdout.write(markdown);
    process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[${SCRIPT_NAME}] fatal: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { topPrefix, isSuspicious };
