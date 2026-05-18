#!/usr/bin/env node
/**
 * audit-cloud-run.js — Read-only Cloud Run service audit (via gcloud).
 *
 * Shells out to `gcloud run services list --format=json` and then for each
 * service to `gcloud run revisions list`. Classifies each service as:
 *   - active   — got traffic in last 7d AND lastDeploy < 30d
 *   - dormant  — got traffic in last 30d OR lastDeploy < 90d but stale
 *   - dead     — no traffic AND lastDeploy > 90d
 *
 * If `gcloud` is missing or unauthenticated, prints a friendly notice and
 * exits 0 with classification GCLOUD_NOT_AVAILABLE — never crashes.
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-cloud-run-YYYY-MM-DD.md
 *
 * READ-ONLY. Never mutates services.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_NAME = 'audit-cloud-run';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;
const REVISION_LIMIT = 50;
const ACTIVE_DAYS = 7;
const DORMANT_DAYS = 90;

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

function runGcloud(args) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function detectGcloud() {
  try {
    runGcloud(['--version']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function classifyService(svc, revisions) {
  const lastDeploy = svc.metadata?.creationTimestamp || svc.metadata?.updateTime || revisions[0]?.metadata?.creationTimestamp || null;
  const lastDeployMs = lastDeploy ? new Date(lastDeploy).getTime() : 0;
  const now = Date.now();
  const ageDays = lastDeployMs ? Math.floor((now - lastDeployMs) / (1000 * 60 * 60 * 24)) : null;

  const trafficAllocations = svc.status?.traffic || svc.spec?.traffic || [];
  const trafficByRev = new Map();
  for (const t of trafficAllocations) {
    const rev = t.revisionName || t.revision;
    if (rev) trafficByRev.set(rev, (trafficByRev.get(rev) || 0) + (t.percent || 0));
  }

  let oldestWithTraffic = null;
  for (const rev of revisions) {
    const name = rev.metadata?.name;
    if (name && trafficByRev.has(name) && (trafficByRev.get(name) || 0) > 0) {
      const ts = rev.metadata?.creationTimestamp ? new Date(rev.metadata.creationTimestamp).getTime() : 0;
      if (!oldestWithTraffic || ts < oldestWithTraffic.ts) {
        oldestWithTraffic = { name, ts };
      }
    }
  }

  let status = 'dead';
  if (ageDays !== null && ageDays <= ACTIVE_DAYS) status = 'active';
  else if (ageDays !== null && ageDays <= DORMANT_DAYS) status = 'dormant';
  if (trafficByRev.size > 0 && status === 'dead') status = 'dormant';

  return {
    status,
    ageDays,
    revisionsCount: revisions.length,
    oldestWithTraffic: oldestWithTraffic ? `${oldestWithTraffic.name} (${new Date(oldestWithTraffic.ts).toISOString().slice(0, 10)})` : 'none',
    lastDeploy: lastDeploy || 'unknown',
  };
}

function renderMarkdown(rows, meta, errors) {
  const out = [
    `# Cloud Run Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Project: \`${meta.project_id || 'unknown'}\``,
    `Services scanned: ${meta.service_count}`,
    `Errors: ${meta.errors_count}`,
    '',
    '## Services',
    '',
    '| Service | Region | Status | LastDeploy | RevisionsCount | OldestRevisionWithTraffic |',
    '|---------|--------|--------|------------|----------------|---------------------------|',
  ];
  const { rows: shown, overflow } = truncate(rows);
  for (const r of shown) {
    out.push(
      `| ${escapePipe(r.service)} | ${escapePipe(r.region)} | ${escapePipe(r.status)} | ${escapePipe(r.lastDeploy)} | ${escapePipe(r.revisionsCount)} | ${escapePipe(r.oldestWithTraffic)} |`,
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
  const errors = [];

  const detect = detectGcloud();
  if (!detect.ok) {
    const meta = {
      script: SCRIPT_NAME,
      generated_at: new Date().toISOString(),
      project_id: projectId,
      service_count: 0,
      errors_count: 1,
      classification: 'GCLOUD_NOT_AVAILABLE',
    };
    const md = `# Cloud Run Audit — ${meta.generated_at.slice(0, 10)}\n\n_GCLOUD_NOT_AVAILABLE_: ${detect.error}\n`;
    meta.report_file = writeRunReport(md);
    if (args.json) process.stdout.write(JSON.stringify({ meta, findings: [], errors: [detect.error] }, null, 2) + '\n');
    else {
      process.stdout.write(md);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  let services = [];
  try {
    const argv = ['run', 'services', 'list', '--format=json'];
    if (projectId) argv.push(`--project=${projectId}`);
    const out = runGcloud(argv);
    services = JSON.parse(out || '[]');
  } catch (err) {
    const meta = {
      script: SCRIPT_NAME,
      generated_at: new Date().toISOString(),
      project_id: projectId,
      service_count: 0,
      errors_count: 1,
      classification: 'GCLOUD_NOT_AVAILABLE',
    };
    const msg = err.stderr ? err.stderr.toString().slice(0, 400) : err.message;
    const md = `# Cloud Run Audit — ${meta.generated_at.slice(0, 10)}\n\n_GCLOUD_NOT_AVAILABLE_: ${msg}\n`;
    meta.report_file = writeRunReport(md);
    if (args.json) process.stdout.write(JSON.stringify({ meta, findings: [], errors: [msg] }, null, 2) + '\n');
    else {
      process.stdout.write(md);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  const rows = [];
  for (const svc of services) {
    const name = svc.metadata?.name;
    const region = svc.metadata?.labels?.['cloud.googleapis.com/location'] || svc.metadata?.region || svc.spec?.template?.metadata?.labels?.['cloud.googleapis.com/location'] || 'unknown';
    if (!name) continue;

    let revisions = [];
    try {
      const argv = [
        'run', 'revisions', 'list',
        `--service=${name}`,
        `--region=${region}`,
        '--format=json',
        `--limit=${REVISION_LIMIT}`,
      ];
      if (projectId) argv.push(`--project=${projectId}`);
      const out = runGcloud(argv);
      revisions = JSON.parse(out || '[]');
    } catch (err) {
      errors.push(`${name}: revisions list failed: ${(err.stderr || err.message).toString().slice(0, 200)}`);
    }

    try {
      const cls = classifyService(svc, revisions);
      rows.push({
        service: name,
        region,
        status: cls.status,
        lastDeploy: cls.lastDeploy === 'unknown' ? 'unknown' : cls.lastDeploy.slice(0, 10),
        revisionsCount: cls.revisionsCount,
        oldestWithTraffic: cls.oldestWithTraffic,
      });
    } catch (err) {
      errors.push(`${name}: classify failed: ${err.message}`);
    }
  }

  rows.sort((a, b) => a.service.localeCompare(b.service));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    project_id: projectId,
    service_count: rows.length,
    errors_count: errors.length,
  };
  const markdown = renderMarkdown(rows, meta, errors);
  meta.report_file = writeRunReport(markdown);

  if (args.json) {
    process.stdout.write(JSON.stringify({ meta, findings: rows, errors: errors.slice(0, 50) }, null, 2) + '\n');
  } else {
    process.stdout.write(markdown);
    process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[${SCRIPT_NAME}] fatal: ${err.message}\n`);
    process.exit(0);
  }
}

module.exports = { classifyService };
