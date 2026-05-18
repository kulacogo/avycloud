#!/usr/bin/env node
/**
 * audit-repo-cruft.js — Read-only repo cruft audit.
 *
 * Walks the repository (skipping node_modules / .git / .firebase / .worktrees /
 * .playwright-mcp / .serena / .tmp) and flags potentially-removable files:
 *
 *   - Backup/legacy/binary patterns (*.bak, *_old.*, *-deprecated.*,
 *     *_backup.*, .DS_Store, *.xls, *.xlsx, *.csv, *.docx, *.pdf, *.pptx,
 *     *.html in root or docs/)
 *   - Plan/prompt markdowns under docs/plans, docs/superpowers/{plans,specs},
 *     docs/prompts
 *   - Files larger than 100KB outside docs/kb, components, backend/lib,
 *     backend/services, backend/routes
 *   - Suspicious file names: enrichment_backup.js, mock-*, dummy-*,
 *     test-*.json
 *   - BaseLinker-related scripts under backend/scripts (grep for
 *     'baselinker' or 'BL_')
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-repo-cruft-YYYY-MM-DD.md
 *
 * READ-ONLY. Never mutates source files.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-repo-cruft';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;
const LARGE_FILE_THRESHOLD = 100 * 1024;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.firebase',
  '.worktrees',
  '.playwright-mcp',
  '.serena',
  '.tmp',
  '.next',
  '.cache',
  'dist',
  'build',
  'coverage',
]);

const LARGE_FILE_SAFE_PREFIXES = [
  'docs/kb/',
  'components/',
  'backend/lib/',
  'backend/services/',
  'backend/routes/',
];

const BACKUP_PATTERNS = [
  { re: /\.bak$/i, reason: 'Backup file (.bak)' },
  { re: /_old\.[a-z0-9]+$/i, reason: 'Legacy file (_old)' },
  { re: /-deprecated\.[a-z0-9]+$/i, reason: 'Deprecated marker' },
  { re: /_backup\.[a-z0-9]+$/i, reason: 'Backup file (_backup)' },
];

const BINARY_EXT_ALWAYS = new Set(['.xls', '.xlsx', '.csv', '.docx', '.pdf', '.pptx']);
const HTML_IN_ROOT_OR_DOCS = /\.(html)$/i;

const SUSPICIOUS_NAME_PATTERNS = [
  { re: /^enrichment_backup\.js$/, reason: 'Old enrichment service backup' },
  { re: /^mock-/i, reason: 'Mock fixture (prefix mock-)' },
  { re: /^dummy-/i, reason: 'Dummy fixture (prefix dummy-)' },
  { re: /^test-.*\.json$/i, reason: 'Test fixture JSON' },
];

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
  };
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_e) {
    return null;
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === '.DS_Store') {
      out.push(path.join(dir, entry.name));
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(full);
    }
  }
  return out;
}

function relPath(p) {
  return path.relative(REPO_ROOT, p);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function classifyFile(absPath, rel, stat) {
  const base = path.basename(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const dir = path.dirname(rel);

  if (base === '.DS_Store') {
    return { type: 'system-junk', action: 'DELETE', reason: '.DS_Store (macOS metadata)' };
  }

  for (const p of BACKUP_PATTERNS) {
    if (p.re.test(base)) {
      return { type: 'backup-legacy', action: 'DELETE', reason: p.reason };
    }
  }

  for (const p of SUSPICIOUS_NAME_PATTERNS) {
    if (p.re.test(base)) {
      return { type: 'suspicious-name', action: 'ARCHIVE', reason: p.reason };
    }
  }

  if (BINARY_EXT_ALWAYS.has(ext)) {
    return { type: 'binary-doc', action: 'ARCHIVE', reason: `Binary doc (${ext})` };
  }

  if (HTML_IN_ROOT_OR_DOCS.test(base)) {
    if (dir === '' || dir === '.' || dir === 'docs' || dir.startsWith('docs/')) {
      return { type: 'html-asset', action: 'ARCHIVE', reason: `HTML in ${dir || 'root'}` };
    }
  }

  return null;
}

function isPlanPromptPath(rel) {
  return (
    rel.startsWith('docs/plans/') ||
    rel.startsWith('docs/superpowers/plans/') ||
    rel.startsWith('docs/superpowers/specs/') ||
    rel.startsWith('docs/prompts/')
  );
}

function isInSafePrefix(rel) {
  return LARGE_FILE_SAFE_PREFIXES.some((p) => rel.startsWith(p));
}

function makeRow(rel, type, size, lastModified, action, reason) {
  return {
    path: rel,
    type,
    size,
    lastModified,
    action,
    reason,
  };
}

function findBaselinkerScripts() {
  const dir = path.join(REPO_ROOT, 'backend', 'scripts');
  const rows = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return rows;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip audit-* scripts: they reference baselinker only to AUDIT for it,
    // not to use it. False-positive avoidance.
    if (/^audit-/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (_e) {
      continue;
    }
    if (/baselinker/i.test(content) || /\bBL_[A-Z0-9_]+/.test(content) || /baselinker/i.test(entry.name)) {
      const stat = safeStat(full);
      rows.push(
        makeRow(
          relPath(full),
          'baselinker-script',
          stat ? formatSize(stat.size) : '?',
          stat ? stat.mtime.toISOString().slice(0, 10) : '?',
          'DELETE',
          'BaseLinker is TABU (CLAUDE.md rule #9)',
        ),
      );
    }
  }
  return rows;
}

function summarisePlanPromptDir(rel, paths) {
  const stats = paths.map((p) => safeStat(p)).filter(Boolean);
  if (stats.length === 0) return null;
  const newest = stats.reduce((a, b) => (a.mtime > b.mtime ? a : b));
  return {
    path: rel,
    type: 'plan-prompt-dir',
    size: `${paths.length} files`,
    lastModified: newest.mtime.toISOString().slice(0, 10),
    action: 'ARCHIVE',
    reason: `Plan/prompt directory (${paths.length} markdown files)`,
  };
}

function truncate(rows) {
  if (rows.length <= MAX_ROWS_PER_CATEGORY) return { rows, overflow: 0 };
  return {
    rows: rows.slice(0, MAX_ROWS_PER_CATEGORY),
    overflow: rows.length - MAX_ROWS_PER_CATEGORY,
  };
}

function escapePipe(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMarkdown(reportRows, meta) {
  const header = [
    `# Repo Cruft Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Repo root: \`${REPO_ROOT}\``,
    `Total findings: ${meta.total_findings}`,
    '',
  ];

  const out = [...header];
  const byType = new Map();
  for (const r of reportRows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }

  for (const [type, rows] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${type} (${rows.length})`);
    out.push('');
    out.push('| Path | Type | Size | LastModified | Suggested-Action | Reason |');
    out.push('|------|------|------|--------------|------------------|--------|');
    const { rows: shown, overflow } = truncate(rows);
    for (const r of shown) {
      out.push(
        `| ${escapePipe(r.path)} | ${escapePipe(r.type)} | ${escapePipe(r.size)} | ${escapePipe(r.lastModified)} | ${escapePipe(r.action)} | ${escapePipe(r.reason)} |`,
      );
    }
    if (overflow > 0) {
      out.push(`| ... | | | | | ${overflow} more (truncated) |`);
    }
    out.push('');
  }

  if (reportRows.length === 0) {
    out.push('_No findings._');
    out.push('');
  }
  return out.join('\n');
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = [];
  const errors = [];

  const allPaths = walk(REPO_ROOT);

  // Group plan/prompt files by their root directory.
  const planPromptGroups = new Map();

  for (const abs of allPaths) {
    try {
      const rel = relPath(abs);
      const stat = safeStat(abs);
      if (!stat || !stat.isFile()) continue;

      if (isPlanPromptPath(rel)) {
        let key;
        if (rel.startsWith('docs/plans/')) key = 'docs/plans';
        else if (rel.startsWith('docs/superpowers/plans/')) key = 'docs/superpowers/plans';
        else if (rel.startsWith('docs/superpowers/specs/')) key = 'docs/superpowers/specs';
        else if (rel.startsWith('docs/prompts/')) key = 'docs/prompts';
        if (key) {
          if (!planPromptGroups.has(key)) planPromptGroups.set(key, []);
          planPromptGroups.get(key).push(abs);
          continue;
        }
      }

      const klass = classifyFile(abs, rel, stat);
      if (klass) {
        rows.push(
          makeRow(
            rel,
            klass.type,
            formatSize(stat.size),
            stat.mtime.toISOString().slice(0, 10),
            klass.action,
            klass.reason,
          ),
        );
        continue;
      }

      if (stat.size > LARGE_FILE_THRESHOLD && !isInSafePrefix(rel)) {
        rows.push(
          makeRow(
            rel,
            'large-file',
            formatSize(stat.size),
            stat.mtime.toISOString().slice(0, 10),
            'ARCHIVE',
            `>100KB outside safe prefixes`,
          ),
        );
      }
    } catch (err) {
      errors.push(`${abs}: ${err.message}`);
    }
  }

  for (const [key, paths] of planPromptGroups) {
    try {
      const summary = summarisePlanPromptDir(key, paths);
      if (summary) rows.push(summary);
    } catch (err) {
      errors.push(`plan-prompt:${key}: ${err.message}`);
    }
  }

  try {
    rows.push(...findBaselinkerScripts());
  } catch (err) {
    errors.push(`baselinker-scan: ${err.message}`);
  }

  rows.sort((a, b) => (a.type + a.path).localeCompare(b.type + b.path));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    total_findings: rows.length,
    errors_count: errors.length,
  };

  const markdown = renderMarkdown(rows, meta);
  const written = writeRunReport(markdown);
  meta.report_file = written;

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ meta, findings: rows, errors: errors.slice(0, 50) }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(markdown);
    if (errors.length > 0) {
      process.stdout.write(`\n_Encountered ${errors.length} per-item errors (suppressed)._\n`);
    }
    process.stdout.write(`\n_Report written to_ \`${written}\`\n`);
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

module.exports = { walk, classifyFile, isPlanPromptPath, isInSafePrefix };
