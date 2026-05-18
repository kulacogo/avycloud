#!/usr/bin/env node
/**
 * audit-kb-coverage.js — Read-only KB coverage cross-check.
 *
 * Verifies that the canonical knowledge-base entries exist for each:
 *
 *   1. backend/routes/*.js                          → docs/kb/09-api/<name>.md
 *   2. components/**\/*View.tsx                     → mentioned in docs/kb/05-pages/README.md
 *   3. docs/features/<ID>/spec.md                   → docs/kb/06-features/<ID>.md
 *   4. ENV-Vars referenced in CLAUDE.md             → docs/kb/03-development/feature-flags.md
 *   5. backend/lib/integration-registry.js providers → docs/kb/08-integrations/<id>.md
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-kb-coverage-YYYY-MM-DD.md
 *
 * READ-ONLY. Never creates the missing KB files — only flags them.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-kb-coverage';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;

const ROUTES_DIR = path.join(REPO_ROOT, 'backend', 'routes');
const KB_API_DIR = path.join(REPO_ROOT, 'docs', 'kb', '09-api');
const COMPONENTS_DIR = path.join(REPO_ROOT, 'components');
const KB_PAGES_README = path.join(REPO_ROOT, 'docs', 'kb', '05-pages', 'README.md');
const FEATURES_DIR = path.join(REPO_ROOT, 'docs', 'features');
const KB_FEATURES_DIR = path.join(REPO_ROOT, 'docs', 'kb', '06-features');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const FEATURE_FLAGS_MD = path.join(REPO_ROOT, 'docs', 'kb', '03-development', 'feature-flags.md');
const INTEGRATION_REGISTRY = path.join(REPO_ROOT, 'backend', 'lib', 'integration-registry.js');
const KB_INTEGRATIONS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '08-integrations');

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

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_e) { return false; }
}

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_e) { return []; }
}

function writeRunReport(markdown) {
  try {
    if (!fs.existsSync(AUDIT_RUNS_DIR)) fs.mkdirSync(AUDIT_RUNS_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(AUDIT_RUNS_DIR, `${SCRIPT_NAME}-${stamp}.md`);
    fs.writeFileSync(dest, markdown, 'utf8');
    return dest;
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

function relFromRepo(p) {
  return path.relative(REPO_ROOT, p);
}

function checkRoutes(rows, errors) {
  for (const entry of safeReaddir(ROUTES_DIR)) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    try {
      const base = entry.name.replace(/\.js$/, '');
      const kbFile = path.join(KB_API_DIR, `${base}.md`);
      const documented = safeExists(kbFile);
      rows.push({
        item: relFromRepo(path.join(ROUTES_DIR, entry.name)),
        type: 'route',
        documented,
        suggested: relFromRepo(kbFile),
      });
    } catch (err) {
      errors.push(`route ${entry.name}: ${err.message}`);
    }
  }
}

function walkViews(dir, out = []) {
  for (const entry of safeReaddir(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkViews(full, out);
    else if (entry.isFile() && /View\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

function checkViews(rows, errors) {
  const pagesReadme = safeRead(KB_PAGES_README) || '';
  for (const abs of walkViews(COMPONENTS_DIR)) {
    try {
      const base = path.basename(abs);
      const documented = pagesReadme.includes(base) || pagesReadme.includes(base.replace(/\.tsx$/, ''));
      rows.push({
        item: relFromRepo(abs),
        type: 'view',
        documented,
        suggested: documented ? relFromRepo(KB_PAGES_README) : `mention in ${relFromRepo(KB_PAGES_README)}`,
      });
    } catch (err) {
      errors.push(`view ${abs}: ${err.message}`);
    }
  }
}

function checkFeatures(rows, errors) {
  for (const entry of safeReaddir(FEATURES_DIR)) {
    try {
      if (entry.isDirectory()) {
        const spec = path.join(FEATURES_DIR, entry.name, 'spec.md');
        if (!safeExists(spec)) continue;
        const kbFile = path.join(KB_FEATURES_DIR, `${entry.name}.md`);
        const documented = safeExists(kbFile);
        rows.push({
          item: relFromRepo(spec),
          type: 'feature',
          documented,
          suggested: relFromRepo(kbFile),
        });
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const base = entry.name.replace(/\.md$/, '');
        const kbFile = path.join(KB_FEATURES_DIR, entry.name);
        const documented = safeExists(kbFile);
        rows.push({
          item: relFromRepo(path.join(FEATURES_DIR, entry.name)),
          type: 'feature',
          documented,
          suggested: relFromRepo(kbFile),
        });
        void base;
      }
    } catch (err) {
      errors.push(`feature ${entry.name}: ${err.message}`);
    }
  }
}

function extractEnvVarsFromClaude(src) {
  const flags = new Set();
  const re = /`([A-Z][A-Z0-9_]{2,})(?:=[^`]*)?`/g;
  let m;
  while ((m = re.exec(src)) !== null) flags.add(m[1]);
  return flags;
}

const CLAUDE_NON_FLAG_TOKENS = new Set([
  'DEFAULT_CHAT_TEMPERATURE',
  'SOURCE_WEIGHTS',
  'BL_',
]);

function checkFeatureFlags(rows, errors) {
  const src = safeRead(CLAUDE_MD);
  const flagsDoc = safeRead(FEATURE_FLAGS_MD) || '';
  if (!src) {
    errors.push('CLAUDE.md not readable');
    return;
  }
  const flags = extractEnvVarsFromClaude(src);
  for (const flag of flags) {
    if (CLAUDE_NON_FLAG_TOKENS.has(flag)) continue;
    try {
      const documented = flagsDoc.includes(flag);
      rows.push({
        item: flag,
        type: 'env-flag',
        documented,
        suggested: relFromRepo(FEATURE_FLAGS_MD),
      });
    } catch (err) {
      errors.push(`flag ${flag}: ${err.message}`);
    }
  }
}

function extractIntegrationIds(src) {
  if (!src) return [];
  const ids = new Set();
  const re = /^\s*([a-z][a-zA-Z0-9_]*)\s*:\s*\{\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    ids.add(m[1]);
  }
  const re2 = /\bid\s*:\s*['"]([a-z0-9_\-]+)['"]/g;
  while ((m = re2.exec(src)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

function checkIntegrations(rows, errors) {
  const src = safeRead(INTEGRATION_REGISTRY);
  if (!src) {
    errors.push('integration-registry.js not readable');
    return;
  }
  const ids = extractIntegrationIds(src);
  for (const id of ids) {
    try {
      const kbFile = path.join(KB_INTEGRATIONS_DIR, `${id}.md`);
      const documented = safeExists(kbFile);
      rows.push({
        item: id,
        type: 'integration',
        documented,
        suggested: relFromRepo(kbFile),
      });
    } catch (err) {
      errors.push(`integration ${id}: ${err.message}`);
    }
  }
}

function renderMarkdown(rows, meta, errors) {
  const out = [
    `# KB Coverage Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Total items checked: ${rows.length}`,
    `Documented: ${rows.filter((r) => r.documented).length}`,
    `Missing: ${rows.filter((r) => !r.documented).length}`,
    `Errors: ${errors.length}`,
    '',
  ];

  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }

  for (const [type, typeRows] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const missing = typeRows.filter((r) => !r.documented);
    out.push(`## ${type} (${missing.length}/${typeRows.length} missing)`);
    out.push('');
    out.push('| Item | Type | Documented? | Suggested-File |');
    out.push('|------|------|-------------|----------------|');
    const { rows: shown, overflow } = truncate(typeRows);
    for (const r of shown) {
      out.push(
        `| ${escapePipe(r.item)} | ${escapePipe(r.type)} | ${escapePipe(r.documented ? 'yes' : 'NO')} | ${escapePipe(r.suggested)} |`,
      );
    }
    if (overflow > 0) out.push(`| ... | | | ${overflow} more (truncated) |`);
    out.push('');
  }

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
  const rows = [];
  const errors = [];

  try { checkRoutes(rows, errors); } catch (err) { errors.push(`checkRoutes: ${err.message}`); }
  try { checkViews(rows, errors); } catch (err) { errors.push(`checkViews: ${err.message}`); }
  try { checkFeatures(rows, errors); } catch (err) { errors.push(`checkFeatures: ${err.message}`); }
  try { checkFeatureFlags(rows, errors); } catch (err) { errors.push(`checkFeatureFlags: ${err.message}`); }
  try { checkIntegrations(rows, errors); } catch (err) { errors.push(`checkIntegrations: ${err.message}`); }

  rows.sort((a, b) => (a.type + a.item).localeCompare(b.type + b.item));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
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

module.exports = { extractEnvVarsFromClaude, extractIntegrationIds };
