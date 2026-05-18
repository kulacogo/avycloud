#!/usr/bin/env node
/**
 * audit-flags-extended.js — Read-only ENV flag cross-check (3-way).
 *
 * Walks CLAUDE.md for ENV-style tokens, then for each computes:
 *   - InCLAUDE?  — appears in CLAUDE.md backtick-fenced tokens
 *   - InCode?    — `process.env.X`, `process.env['X']` or env-helper calls
 *                  in any backend/**\/*.js file
 *   - InDeploy?  — referenced in cloudbuild.yaml (substitution `_X` or env
 *                  list `X=…` or `--update-env-vars X=`)
 *
 * Classification:
 *   - LIVE              — in code AND (in CLAUDE OR in deploy)
 *   - DOCUMENTED_ONLY   — in CLAUDE, not in code
 *   - UNDOCUMENTED      — in code, not in CLAUDE
 *   - DEPLOY_ONLY       — only in cloudbuild.yaml
 *   - DEAD              — in CLAUDE but neither code nor deploy
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-flags-extended-YYYY-MM-DD.md
 *
 * READ-ONLY. Never mutates files.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-flags-extended';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const CLOUDBUILD_YAML = path.join(BACKEND_DIR, 'cloudbuild.yaml');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '__snapshots__',
]);
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs']);

const DOC_NON_FLAG_TOKENS = new Set([
  'DEFAULT_CHAT_TEMPERATURE',
  'SOURCE_WEIGHTS',
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

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
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

function extractFlagsFromClaude(src) {
  const flags = new Set();
  const re = /`([A-Z][A-Z0-9_]{2,})(?:=[^`]*)?`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (DOC_NON_FLAG_TOKENS.has(m[1])) continue;
    flags.add(m[1]);
  }
  return flags;
}

function extractFlagsFromCode(src) {
  const flags = new Set();
  const dotRe = /process\.env\.([A-Z_][A-Z0-9_]+)/g;
  const bracketRe = /process\.env\[\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\]/g;
  const helperRe = /\b_?env[A-Z]\w*\(\s*['"]([A-Z_][A-Z0-9_]+)['"]/g;
  let m;
  while ((m = dotRe.exec(src)) !== null) flags.add(m[1]);
  while ((m = bracketRe.exec(src)) !== null) flags.add(m[1]);
  while ((m = helperRe.exec(src)) !== null) flags.add(m[1]);
  return flags;
}

function extractFlagsFromDeploy(src) {
  const flags = new Set();
  if (!src) return flags;
  // Cloud Build substitutions like `_FOO_BAR: value`
  const subRe = /^\s*_([A-Z][A-Z0-9_]+)\s*:/gm;
  // --update-env-vars 'FOO=...,BAR=...'
  const updateEnvRe = /--update-env-vars[^'"]*['"]?([A-Z][A-Z0-9_]+=[^'"\n]*)/g;
  // env: [ 'NODE_PATH=...', 'FOO=...' ]
  const envListRe = /['"]([A-Z][A-Z0-9_]+)=[^'"]*['"]/g;

  let m;
  while ((m = subRe.exec(src)) !== null) flags.add(m[1]);
  while ((m = updateEnvRe.exec(src)) !== null) {
    const pairs = m[1].split(',');
    for (const p of pairs) {
      const [k] = p.split('=');
      if (k && /^[A-Z][A-Z0-9_]+$/.test(k.trim())) flags.add(k.trim());
    }
  }
  while ((m = envListRe.exec(src)) !== null) flags.add(m[1]);
  return flags;
}

function classify(inClaude, inCode, inDeploy) {
  if (inCode && (inClaude || inDeploy)) return 'LIVE';
  if (inCode && !inClaude && !inDeploy) return 'UNDOCUMENTED';
  if (!inCode && inClaude && inDeploy) return 'DOCUMENTED_DEPLOY_NO_CODE';
  if (!inCode && !inClaude && inDeploy) return 'DEPLOY_ONLY';
  if (!inCode && inClaude && !inDeploy) return 'DOCUMENTED_ONLY';
  return 'UNKNOWN';
}

function renderMarkdown(rows, meta) {
  const out = [
    `# Flags Extended Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `CLAUDE.md: \`${meta.claude_md}\``,
    `cloudbuild.yaml: \`${meta.cloudbuild_yaml}\``,
    `Backend code root: \`${meta.backend_dir}\``,
    '',
    `Total flags inspected: ${rows.length}`,
    '',
    '## Flags',
    '',
    '| Flag | InCLAUDE? | InCode? | InDeploy? | Status |',
    '|------|-----------|---------|-----------|--------|',
  ];
  const { rows: shown, overflow } = truncate(rows);
  for (const r of shown) {
    out.push(
      `| ${escapePipe(r.flag)} | ${escapePipe(r.inClaude ? 'yes' : 'no')} | ${escapePipe(r.inCode ? 'yes' : 'no')} | ${escapePipe(r.inDeploy ? 'yes' : 'no')} | ${escapePipe(r.status)} |`,
    );
  }
  if (overflow > 0) out.push(`| ... | | | | ${overflow} more (truncated) |`);
  out.push('');
  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const claudeSrc = safeRead(CLAUDE_MD) || '';
  const cloudbuildSrc = safeRead(CLOUDBUILD_YAML) || '';
  const claudeFlags = extractFlagsFromClaude(claudeSrc);
  const deployFlags = extractFlagsFromDeploy(cloudbuildSrc);

  const codeFlags = new Set();
  const files = walk(BACKEND_DIR);
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (_e) { continue; }
    for (const fg of extractFlagsFromCode(src)) codeFlags.add(fg);
  }

  const allFlags = new Set([...claudeFlags, ...codeFlags, ...deployFlags]);
  const rows = [];
  for (const flag of allFlags) {
    try {
      const inClaude = claudeFlags.has(flag);
      const inCode = codeFlags.has(flag);
      const inDeploy = deployFlags.has(flag);
      rows.push({
        flag,
        inClaude,
        inCode,
        inDeploy,
        status: classify(inClaude, inCode, inDeploy),
      });
    } catch (err) {
      rows.push({ flag, inClaude: false, inCode: false, inDeploy: false, status: `ERR:${err.message}` });
    }
  }

  rows.sort((a, b) => a.flag.localeCompare(b.flag));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    claude_md: CLAUDE_MD,
    cloudbuild_yaml: CLOUDBUILD_YAML,
    backend_dir: BACKEND_DIR,
    total: rows.length,
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

module.exports = { extractFlagsFromClaude, extractFlagsFromCode, extractFlagsFromDeploy, classify };
