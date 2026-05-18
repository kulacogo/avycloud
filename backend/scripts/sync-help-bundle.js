#!/usr/bin/env node
/**
 * sync-help-bundle.js — read-only generator that bundles the entire AvyCloud
 * Knowledge Base (docs/kb/) into a single JSON file at
 *   backend/data/help-bundle.json
 * so the Cloud Run container (whose build context is `backend/`) can serve it
 * via /api/help/* without needing docs/kb/ inside the image.
 *
 * Usage:
 *   node backend/scripts/sync-help-bundle.js          # writes bundle if changed
 *   node backend/scripts/sync-help-bundle.js --dry-run
 *
 * Exit codes:
 *   0  success (bundle written or unchanged)
 *   1  unexpected error (will NOT block npm start; called as pre-start best-effort)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KB_ROOT = path.join(REPO_ROOT, 'docs', 'kb');
const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'help-bundle.json');

const EXCLUDED_TOP_DIRS = new Set(['_audit-runs', '_assets']);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');

function stripQuotes(raw) {
  const s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(content) {
  const out = {};
  if (typeof content !== 'string' || !content.length) return { frontmatter: out, body: content || '' };
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: out, body: content };
  const block = m[1];
  const body = content.slice(m[0].length);

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      const inner = valueRaw.slice(1, -1).trim();
      out[key] = inner ? inner.split(',').map((p) => stripQuotes(p)).filter(Boolean) : [];
    } else {
      out[key] = stripQuotes(valueRaw);
    }
  }
  return { frontmatter: out, body };
}

function walkMd(dir, base) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const top = path.relative(base, abs).split(path.sep)[0];
      if (EXCLUDED_TOP_DIRS.has(top)) continue;
      out.push(...walkMd(abs, base));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const top = path.relative(base, abs).split(path.sep)[0];
      if (EXCLUDED_TOP_DIRS.has(top)) continue;
      out.push(abs);
    }
  }
  return out;
}

function toSlug(absPath) {
  const rel = path.relative(KB_ROOT, absPath);
  return rel.replace(/\.md$/i, '').split(path.sep).join('/');
}

function sectionForSlug(slug) {
  const idx = slug.indexOf('/');
  return idx === -1 ? 'root' : slug.slice(0, idx);
}

function main() {
  if (!fs.existsSync(KB_ROOT)) {
    console.warn('[sync-help-bundle] docs/kb/ not found; skipping (this is OK at container runtime)');
    process.exit(0);
  }

  const files = walkMd(KB_ROOT, KB_ROOT);
  const articles = [];
  let errors = 0;

  for (const abs of files) {
    const slug = toSlug(abs);
    let raw = '';
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      errors += 1;
      articles.push({ slug, title: slug, for: [], lastReviewed: '', section: sectionForSlug(slug), content: '' });
      continue;
    }
    let frontmatter = {};
    let body = raw;
    try {
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter || {};
      body = parsed.body || '';
    } catch (_) {
      // keep raw body, empty frontmatter
    }
    const titleFromMeta = typeof frontmatter.title === 'string' && frontmatter.title.length ? frontmatter.title : null;
    articles.push({
      slug,
      title: titleFromMeta || slug.split('/').pop() || slug,
      for: Array.isArray(frontmatter.for) ? frontmatter.for : [],
      lastReviewed: typeof frontmatter.lastReviewed === 'string' ? frontmatter.lastReviewed : '',
      section: sectionForSlug(slug),
      content: body,
    });
  }

  articles.sort((a, b) => a.slug.localeCompare(b.slug));

  const bundle = {
    version: 1,
    generatedAt: new Date().toISOString(),
    kbRoot: 'docs/kb',
    articleCount: articles.length,
    articles,
  };

  const json = JSON.stringify(bundle, null, 2) + '\n';
  if (DRY_RUN) {
    console.log(`[sync-help-bundle] dry-run: ${articles.length} articles, ${json.length} bytes`);
    return;
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let prev = '';
  if (fs.existsSync(OUT_FILE)) {
    try {
      prev = fs.readFileSync(OUT_FILE, 'utf8');
    } catch (_) {
      prev = '';
    }
  }

  // Strip generatedAt from comparison so we don't churn the file on every run.
  const stripTs = (s) => s.replace(/"generatedAt":\s*"[^"]*",?\s*\n?/g, '');
  if (stripTs(prev) === stripTs(json)) {
    console.log(`[sync-help-bundle] no changes (${articles.length} articles)`);
    return;
  }

  fs.writeFileSync(OUT_FILE, json, 'utf8');
  console.log(`[sync-help-bundle] wrote ${articles.length} articles → ${path.relative(REPO_ROOT, OUT_FILE)} (errors: ${errors})`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('[sync-help-bundle] failed:', err && err.message);
  // never block the parent process (npm start)
  process.exit(0);
}
