#!/usr/bin/env node
/**
 * audit-deps.js — Read-only dependency-usage audit.
 *
 * Reads root and backend package.json, then walks all *.ts / *.tsx / *.js /
 * *.cjs / *.mjs files (excluding node_modules, dist, build, .git, etc.),
 * greps for require()/import statements and computes:
 *
 *   - Declared but unused → DEAD
 *   - Imported but undeclared → ERROR
 *   - DevDependencies unused in tests/scripts (e.g. playwright with no
 *     .spec.ts) → DEV_DEAD
 *   - OK otherwise → USED
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-deps-YYYY-MM-DD.md
 *
 * READ-ONLY. Never installs or removes packages.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-deps';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;

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
  'archive',
]);

const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx']);

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises', 'string_decoder',
  'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util',
  'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

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
    if (!fs.existsSync(AUDIT_RUNS_DIR)) fs.mkdirSync(AUDIT_RUNS_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(AUDIT_RUNS_DIR, `${SCRIPT_NAME}-${stamp}.md`);
    fs.writeFileSync(dest, markdown, 'utf8');
    return dest;
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

function readPkg(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
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
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function packageRoot(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const root = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!root) return null;
  if (NODE_BUILTINS.has(root)) return null;
  if (NODE_BUILTINS.has(specifier)) return null;
  return root;
}

function extractImports(src) {
  const pkgs = new Set();
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const root = packageRoot(m[1]);
      if (root) pkgs.add(root);
    }
  }
  return pkgs;
}

function classifyDevDep(name, hasSpecFiles, hasInTestFile, hasInScriptFile) {
  if (name === 'playwright' || name === '@playwright/test') {
    if (!hasSpecFiles) return 'DEV_DEAD: no .spec.ts/.spec.tsx files found';
  }
  if (name === 'vitest' || name === 'jest' || name === 'mocha' || name === 'supertest') {
    if (!hasInTestFile) return 'DEV_DEAD: no usage in test files';
  }
  if (!hasInTestFile && !hasInScriptFile) return 'DEV_DEAD: not used in tests/scripts';
  return null;
}

function renderMarkdown(rows, meta) {
  const out = [
    `# Deps Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Root package: \`${meta.root_pkg}\``,
    `Backend package: \`${meta.backend_pkg}\``,
    `Files scanned: ${meta.files_scanned}`,
    '',
    '## Findings',
    '',
    '| Package | Section | Declared? | Used? | Classification |',
    '|---------|---------|-----------|-------|----------------|',
  ];
  const { rows: shown, overflow } = truncate(rows);
  for (const r of shown) {
    out.push(
      `| ${escapePipe(r.package)} | ${escapePipe(r.section)} | ${escapePipe(r.declared ? 'yes' : 'no')} | ${escapePipe(r.used ? 'yes' : 'no')} | ${escapePipe(r.classification)} |`,
    );
  }
  if (overflow > 0) out.push(`| ... | | | | ${overflow} more (truncated) |`);
  out.push('');
  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rootPkgPath = path.join(REPO_ROOT, 'package.json');
  const backendPkgPath = path.join(REPO_ROOT, 'backend', 'package.json');
  const rootPkg = readPkg(rootPkgPath) || {};
  const backendPkg = readPkg(backendPkgPath) || {};

  const allFiles = walk(REPO_ROOT);
  const allUsedRoots = new Set();
  const usedInTests = new Set();
  const usedInScripts = new Set();
  let hasSpecFiles = false;

  for (const f of allFiles) {
    const rel = path.relative(REPO_ROOT, f);
    if (/\.(spec|test)\.(t|j)sx?$/.test(f)) hasSpecFiles = true;

    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch (_e) {
      continue;
    }
    const pkgs = extractImports(src);
    const inTest = /__tests__|\.test\./.test(rel) || /\.spec\./.test(rel);
    const inScripts = rel.includes('/scripts/') || rel.startsWith('scripts/');
    for (const p of pkgs) {
      allUsedRoots.add(p);
      if (inTest) usedInTests.add(p);
      if (inScripts) usedInScripts.add(p);
    }
  }

  const rows = [];
  const seen = new Set();

  function addDeclared(pkgJson, isBackend) {
    const sections = [
      { key: 'dependencies', label: 'deps' },
      { key: 'devDependencies', label: 'devDeps' },
    ];
    for (const { key, label } of sections) {
      const deps = pkgJson[key] || {};
      for (const name of Object.keys(deps)) {
        const seenKey = `${isBackend ? 'backend' : 'root'}:${name}:${label}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        const used = allUsedRoots.has(name);
        let classification = used ? 'USED' : (label === 'deps' ? 'DEAD' : 'DEV_DEAD');
        if (label === 'devDeps' && used) {
          const devNote = classifyDevDep(name, hasSpecFiles, usedInTests.has(name), usedInScripts.has(name));
          if (devNote && !usedInTests.has(name) && !usedInScripts.has(name)) classification = devNote;
        } else if (label === 'devDeps' && !used) {
          const devNote = classifyDevDep(name, hasSpecFiles, false, false);
          if (devNote) classification = devNote;
        }
        rows.push({
          package: name,
          section: `${isBackend ? 'backend' : 'root'}/${label}`,
          declared: true,
          used,
          classification,
        });
      }
    }
  }

  addDeclared(rootPkg, false);
  addDeclared(backendPkg, true);

  // Imported but not declared anywhere.
  const declaredSet = new Set();
  for (const k of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(rootPkg[k] || {})) declaredSet.add(name);
    for (const name of Object.keys(backendPkg[k] || {})) declaredSet.add(name);
  }
  for (const used of allUsedRoots) {
    if (declaredSet.has(used)) continue;
    rows.push({
      package: used,
      section: 'undeclared',
      declared: false,
      used: true,
      classification: 'ERROR: imported but not declared',
    });
  }

  rows.sort((a, b) => a.package.localeCompare(b.package));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    root_pkg: rootPkgPath,
    backend_pkg: backendPkgPath,
    files_scanned: allFiles.length,
  };
  const markdown = renderMarkdown(rows, meta);
  meta.report_file = writeRunReport(markdown);

  if (args.json) {
    process.stdout.write(JSON.stringify({ meta, findings: rows }, null, 2) + '\n');
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

module.exports = { extractImports, packageRoot };
