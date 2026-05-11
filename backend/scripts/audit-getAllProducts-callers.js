#!/usr/bin/env node
'use strict';

/**
 * audit-getAllProducts-callers.js — Phase D.0b pre-D.0c gate
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * Scans the backend for `getAllProducts(` call-sites and categorises each by
 * directory:
 *   • production_callers — routes/, services/, lib/ (must reach 0 before D.0c
 *     can flip lib/firestore.js#getAllProducts() to throw).
 *   • script_callers — scripts/ (one-off tooling, allowed to remain on the
 *     legacy helper for now; D.0c will tackle them separately).
 *
 * Additionally tracks `getAllProductsV2(` callers in a SEPARATE bucket
 * (CC4-C-4 cross-check addition). The V2 helper is the supported successor
 * (`lib/product-store.js#getAllProductsV2`) — its callers are NOT a D.0c
 * blocker, but the audit surfaces them for visibility / future tenant-scoping
 * work.
 *
 * The self-reference inside lib/firestore.js (the function definition and the
 * JSDoc that mentions getAllProducts()) is filtered out, as is any reference
 * that appears inside a line or block comment.
 *
 * Exit status:
 *   0 — `production_callers.length === 0` (all production code migrated)
 *   1 — at least one production caller of the legacy helper remains
 *   2 — internal error (e.g. cannot read a file)
 *
 * Note: `getAllProductsV2` callers do NOT affect exit status — they are
 * informational only.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROD_DIRS = ['routes', 'services', 'lib'];
const SCRIPT_DIRS = ['scripts'];

// Self-reference: the function definition and explicit references inside its
// own JSDoc / fallback comments in lib/firestore.js do not count as callers.
const SELF_REFERENCE_FILE = path.join(REPO_ROOT, 'lib', 'firestore.js');
// V2-helper self-reference: lib/product-store.js owns getAllProductsV2.
const V2_SELF_REFERENCE_FILE = path.join(REPO_ROOT, 'lib', 'product-store.js');

function listJsFiles(dirRelative) {
  const dir = path.join(REPO_ROOT, dirRelative);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js')) continue;
      if (/\.test\.js$/i.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function stripCommentsLine(line) {
  // Drop everything from // to end-of-line. (Sufficient heuristic — we only
  // want to filter false-positives that live in trailing JSDoc / comments.)
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function isInsideBlockComment(lines, lineIndex) {
  // Cheap heuristic — see `precomputeBlockCommentMask` for the O(N) version
  // used inside per-file scans. This wrapper is retained for legacy callers
  // (and matches the original O(N²) semantics line-for-line).
  let open = 0;
  for (let i = 0; i < lineIndex; i++) {
    const raw = lines[i];
    const l = stripCommentsLine(raw);
    for (let j = 0; j < l.length - 1; j++) {
      if (l[j] === '/' && l[j + 1] === '*') open++;
      else if (l[j] === '*' && l[j + 1] === '/') open = Math.max(0, open - 1);
    }
  }
  return open > 0;
}

/**
 * O(N) helper: returns a boolean array where mask[i] === true iff line `i`
 * starts inside an unbalanced block-comment. Computed in a single forward
 * pass over the file (vs. isInsideBlockComment's quadratic re-scan).
 */
function precomputeBlockCommentMask(lines) {
  const mask = new Array(lines.length);
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    mask[i] = open > 0;
    const l = stripCommentsLine(lines[i]);
    for (let j = 0; j < l.length - 1; j++) {
      if (l[j] === '/' && l[j + 1] === '*') open++;
      else if (l[j] === '*' && l[j + 1] === '/') open = Math.max(0, open - 1);
    }
  }
  return mask;
}

function isFallbackTernaryBranch(lines, lineIndex) {
  // Recognise the ternary-fallback pattern that D.0b call-sites use:
  //
  //   const x = tenantId
  //     ? await getAllProductsForTenant(tenantId)
  //     : await getAllProducts();
  //
  //   const x = tenantId ? await getAllProductsForTenant(tenantId) : await getAllProducts();
  //
  // When `getAllProducts(` lives on a line whose nearest preceding non-blank
  // line contains `getAllProductsForTenant(`, treat it as a fallback branch
  // (the call-site IS migrated; the legacy helper is just the `: branch`).
  const raw = lines[lineIndex];
  // Same-line ternary
  if (/\bgetAllProductsForTenant\s*\(/.test(raw) && /\bgetAllProducts\s*\(/.test(raw)) return true;
  // Multi-line ternary — search backwards up to 4 non-blank lines
  let seen = 0;
  for (let i = lineIndex - 1; i >= 0 && seen < 4; i--) {
    const prev = lines[i].trim();
    if (!prev) continue;
    seen += 1;
    if (/\bgetAllProductsForTenant\s*\(/.test(prev)) return true;
    // Conservative: only accept if we're still inside the same ternary block
    // (e.g. the line ends with `?` or starts with `?`).
    if (/\?\s*$/.test(prev) || /^\s*\?/.test(prev)) continue;
    // Otherwise we've crossed out of the ternary — stop scanning.
    break;
  }
  return false;
}

function findCallers(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const mask = precomputeBlockCommentMask(lines);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (mask[i]) continue;
    const code = stripCommentsLine(raw);
    // Match `getAllProducts(` but exclude both `getAllProductsForTenant(`
    // and `getAllProductsV2(` (V2 is tracked separately below).
    if (!/\bgetAllProducts\s*\(/.test(code)) continue;
    if (/\bgetAllProductsForTenant\s*\(/.test(code) && !/\bgetAllProducts\s*\(\s*\)/.test(code)) continue;
    if (/\bgetAllProductsV2\s*\(/.test(code) && !/(?<!V2)\bgetAllProducts\s*\(\s*\)/.test(code)) continue;

    // Skip self-references in lib/firestore.js: the function declaration,
    // its imports/exports, and any other mention in that file.
    if (filePath === SELF_REFERENCE_FILE) continue;

    // Skip the D.0b ternary fallback branch — the call-site IS migrated; the
    // legacy helper is only reached when tenantId is null, and D.0c will
    // remove this branch when getAllProducts() flips to throw.
    if (isFallbackTernaryBranch(lines, i)) continue;

    hits.push({ file: filePath, line: i + 1, code: raw.trim() });
  }
  return hits;
}

/**
 * Recognises the V2 ternary-fallback pattern (mirror of `isFallbackTernaryBranch`
 * but for `getAllProductsV2`). When `getAllProductsV2(` lives on a line whose
 * nearest preceding non-blank line contains `getAllProductsV2ForTenant(`, the
 * call-site is treated as MIGRATED (it's the `: fallback` branch — only reached
 * when tenantId is null, kept for backwards-compat).
 */
function isV2FallbackTernaryBranch(lines, lineIndex) {
  const raw = lines[lineIndex];
  // Same-line ternary
  if (/\bgetAllProductsV2ForTenant\s*\(/.test(raw) && /\bgetAllProductsV2\s*\(/.test(raw)) return true;
  // Multi-line ternary — search backwards up to 4 non-blank lines
  let seen = 0;
  for (let i = lineIndex - 1; i >= 0 && seen < 4; i--) {
    const prev = lines[i].trim();
    if (!prev) continue;
    seen += 1;
    if (/\bgetAllProductsV2ForTenant\s*\(/.test(prev)) return true;
    if (/\?\s*$/.test(prev) || /^\s*\?/.test(prev)) continue;
    break;
  }
  return false;
}

/**
 * Finds `getAllProductsV2(` call-sites. Skips the V2 self-reference (its own
 * declaration in lib/product-store.js) and pure import statements (lines that
 * are `const { getAllProductsV2 } = require(...)`) — only counts actual call
 * invocations (`getAllProductsV2(...)`). Mirrors the comment/ternary-skip
 * semantics of findCallers so the two outputs stay comparable.
 *
 * Categorises each hit:
 *   - migrated: lives inside a `tenantId ? getAllProductsV2ForTenant(...) : getAllProductsV2()`
 *     ternary fallback (the call-site IS plumbed for tenants).
 *   - unmigrated: bare `getAllProductsV2()` invocation without fallback ternary.
 *
 * Returns `[{ file, line, code, status: 'migrated'|'unmigrated' }]`.
 */
function findV2Callers(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const mask = precomputeBlockCommentMask(lines);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (mask[i]) continue;
    const code = stripCommentsLine(raw);
    if (!/\bgetAllProductsV2\s*\(/.test(code)) continue;
    // Lines that ONLY mention getAllProductsV2ForTenant are not V2 callers.
    if (/\bgetAllProductsV2ForTenant\s*\(/.test(code) && !/(?<!ForTenant)\bgetAllProductsV2\s*\(/.test(code)) continue;
    // Skip self-reference: the function declaration in lib/product-store.js.
    if (filePath === V2_SELF_REFERENCE_FILE) continue;
    // Skip pure destructuring imports: `const { getAllProductsV2 } = require(...)`.
    // Those don't INVOKE the function — only `getAllProductsV2(` followed by
    // anything except a destructure-close `}` counts.
    if (/\{\s*[^}]*\bgetAllProductsV2\b[^}]*\}\s*=\s*require\b/.test(code)) continue;
    const status = isV2FallbackTernaryBranch(lines, i) ? 'migrated' : 'unmigrated';
    hits.push({ file: filePath, line: i + 1, code: raw.trim(), status });
  }
  return hits;
}

function scan(dirs) {
  const files = dirs.flatMap((d) => listJsFiles(d));
  const callers = [];
  for (const f of files) {
    try {
      callers.push(...findCallers(f));
    } catch (err) {
      process.stderr.write(`audit-getAllProducts-callers: failed to read ${f}: ${err.message}\n`);
      process.exitCode = 2;
    }
  }
  return callers;
}

function scanV2(dirs) {
  const files = dirs.flatMap((d) => listJsFiles(d));
  const callers = [];
  for (const f of files) {
    try {
      callers.push(...findV2Callers(f));
    } catch (err) {
      process.stderr.write(`audit-getAllProducts-callers: failed to read ${f} (v2 scan): ${err.message}\n`);
      process.exitCode = 2;
    }
  }
  return callers;
}

// Combined single-pass scan: runs both findCallers (legacy `getAllProducts(`)
// and findV2Callers (`getAllProductsV2(`) over each file in one walk so the
// V2 audit adds essentially zero cost vs. running two passes. Returns
// `{ legacy, v2 }` arrays.
function scanBoth(dirs) {
  const files = dirs.flatMap((d) => listJsFiles(d));
  const legacy = [];
  const v2 = [];
  for (const f of files) {
    try {
      legacy.push(...findCallers(f));
    } catch (err) {
      process.stderr.write(`audit-getAllProducts-callers: failed to read ${f}: ${err.message}\n`);
      process.exitCode = 2;
    }
    try {
      v2.push(...findV2Callers(f));
    } catch (err) {
      process.stderr.write(`audit-getAllProducts-callers: failed to read ${f} (v2 scan): ${err.message}\n`);
      process.exitCode = 2;
    }
  }
  return { legacy, v2 };
}

function main() {
  try {
    // Single-pass scan over each tree to keep audit fast (~5s vs. ~10s when
    // both legacy + V2 patterns scan the file list independently).
    const prodScan = scanBoth(PROD_DIRS);
    const scriptScan = scanBoth(SCRIPT_DIRS);
    const production_callers = prodScan.legacy;
    const script_callers = scriptScan.legacy;
    // CC4-C-4: V2-helper callers (informational, NOT a D.0c blocker).
    const production_callers_v2 = prodScan.v2;
    const script_callers_v2 = scriptScan.v2;

    const uniqueFiles = new Set([
      ...production_callers.map((c) => c.file),
      ...script_callers.map((c) => c.file),
      ...production_callers_v2.map((c) => c.file),
      ...script_callers_v2.map((c) => c.file),
    ]);

    // V2-callers categorisation: 'migrated' (ternary fallback present) vs.
    // 'unmigrated' (bare call without tenant-fallback). Only `unmigrated`
    // production callers count as a FAIL — `migrated` ones are pre-D.0c
    // ready-state.
    const production_callers_v2_migrated = production_callers_v2.filter((c) => c.status === 'migrated');
    const production_callers_v2_unmigrated = production_callers_v2.filter((c) => c.status === 'unmigrated');

    const report = {
      production_callers,
      script_callers,
      production_callers_v2,
      script_callers_v2,
      total_unique_files: uniqueFiles.size,
      production_caller_count: production_callers.length,
      script_caller_count: script_callers.length,
      production_caller_count_v2: production_callers_v2.length,
      production_caller_count_v2_migrated: production_callers_v2_migrated.length,
      production_caller_count_v2_unmigrated: production_callers_v2_unmigrated.length,
      script_caller_count_v2: script_callers_v2.length,
      generated_at: new Date().toISOString(),
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    // Exit-Gate uses the legacy `getAllProducts` count AND the V2-unmigrated
    // production-caller count. V2-migrated callers (ternary fallback) are OK.
    // Script-level callers (both legacy + V2) remain informational and do NOT
    // affect the exit code — one-off tooling can stay on the global helper for
    // now.
    if (production_callers.length === 0 && production_callers_v2_unmigrated.length === 0) {
      process.exit(0);
    }
    process.exit(1);
  } catch (err) {
    process.stderr.write(`audit-getAllProducts-callers: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { listJsFiles, findCallers, findV2Callers };
