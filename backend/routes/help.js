/**
 * Help Drawer routes — serves the in-repo Knowledge Base under docs/kb/
 * to authenticated UI clients. All routes are read-only.
 *
 * GET /api/help/articles          → list of all KB articles (cached, 60s TTL)
 * GET /api/help/articles/:slug(*) → single article markdown content
 * GET /api/help/index             → articles grouped by top-level section
 *
 * Path-traversal hardening:
 *  - slug must match /^[a-zA-Z0-9_\-\/]+$/
 *  - resolved real path must remain inside KB_ROOT realpath
 *  - any escape attempt → 400
 */

const { Router } = require('express');
const fs = require('fs/promises');
const path = require('path');

const router = Router();

const KB_ROOT = path.resolve(__dirname, '..', '..', 'docs', 'kb');
const EXCLUDED_TOP_DIRS = new Set(['_audit-runs', '_assets']);

// ── In-memory index cache ─────────────────────────────────────────────────
const INDEX_CACHE_TTL_MS = 60 * 1000;
let _indexCache = null; // { at: number, data: Article[] }

// ── Tiny YAML frontmatter parser ──────────────────────────────────────────
// Supports only:
//   key: value
//   key: [a, b, c]
// Strings may be optionally quoted with single or double quotes.
// Anything more exotic returns whatever subset we could parse — never throws.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
      if (!inner) {
        out[key] = [];
      } else {
        out[key] = inner.split(',').map((p) => stripQuotes(p)).filter((p) => p.length > 0);
      }
    } else if (valueRaw.length === 0) {
      out[key] = '';
    } else {
      out[key] = stripQuotes(valueRaw);
    }
  }

  return { frontmatter: out, body };
}

// ── Filesystem walk ───────────────────────────────────────────────────────
async function walkMarkdown(dir, baseDir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const rel = path.relative(baseDir, abs);
      const top = rel.split(path.sep)[0];
      if (EXCLUDED_TOP_DIRS.has(top)) continue;
      const nested = await walkMarkdown(abs, baseDir);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;

    const rel = path.relative(baseDir, abs);
    const top = rel.split(path.sep)[0];
    if (EXCLUDED_TOP_DIRS.has(top)) continue;

    files.push(abs);
  }
  return files;
}

function toSlug(absPath) {
  const rel = path.relative(KB_ROOT, absPath);
  const noExt = rel.replace(/\.md$/i, '');
  return noExt.split(path.sep).join('/');
}

function sectionForSlug(slug) {
  const idx = slug.indexOf('/');
  return idx === -1 ? '' : slug.slice(0, idx);
}

async function readArticleMeta(absPath) {
  const raw = await fs.readFile(absPath, 'utf8');
  let frontmatter = {};
  try {
    frontmatter = parseFrontmatter(raw).frontmatter || {};
  } catch (_) {
    frontmatter = {};
  }

  const slug = toSlug(absPath);
  const titleFromMeta = typeof frontmatter.title === 'string' && frontmatter.title.length
    ? frontmatter.title
    : null;
  const title = titleFromMeta || slug.split('/').pop() || slug;
  const forArr = Array.isArray(frontmatter.for) ? frontmatter.for : [];
  const lastReviewed = typeof frontmatter.lastReviewed === 'string' ? frontmatter.lastReviewed : '';

  return {
    slug,
    title,
    for: forArr,
    lastReviewed,
    section: sectionForSlug(slug),
  };
}

async function buildIndex() {
  const files = await walkMarkdown(KB_ROOT, KB_ROOT);
  const metas = [];
  for (const abs of files) {
    try {
      const meta = await readArticleMeta(abs);
      metas.push(meta);
    } catch (err) {
      // Never fail the whole index because a single article cannot be parsed.
      const slug = toSlug(abs);
      metas.push({ slug, title: slug, for: [], lastReviewed: '', section: sectionForSlug(slug) });
    }
  }
  metas.sort((a, b) => a.slug.localeCompare(b.slug));
  return metas;
}

async function getCachedIndex() {
  const now = Date.now();
  if (_indexCache && now - _indexCache.at < INDEX_CACHE_TTL_MS) {
    return _indexCache.data;
  }
  const data = await buildIndex();
  _indexCache = { at: now, data };
  return data;
}

// ── Path-traversal guard ──────────────────────────────────────────────────
const SLUG_RE = /^[a-zA-Z0-9_\-/]+$/;

async function resolveSlugToFile(slug) {
  if (typeof slug !== 'string' || !slug.length) {
    const err = new Error('Invalid slug');
    err.statusCode = 400;
    throw err;
  }
  if (!SLUG_RE.test(slug)) {
    const err = new Error('Invalid slug');
    err.statusCode = 400;
    throw err;
  }
  if (slug.includes('..') || slug.startsWith('/') || slug.endsWith('/')) {
    const err = new Error('Invalid slug');
    err.statusCode = 400;
    throw err;
  }
  const top = slug.split('/')[0];
  if (EXCLUDED_TOP_DIRS.has(top)) {
    const err = new Error('Invalid slug');
    err.statusCode = 400;
    throw err;
  }

  const candidate = path.join(KB_ROOT, `${slug}.md`);
  let rootReal;
  try {
    rootReal = await fs.realpath(KB_ROOT);
  } catch (_) {
    rootReal = KB_ROOT;
  }

  let candidateReal;
  try {
    candidateReal = await fs.realpath(candidate);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const e = new Error('Not found');
      e.statusCode = 404;
      throw e;
    }
    throw err;
  }

  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootWithSep)) {
    const err = new Error('Invalid slug');
    err.statusCode = 400;
    throw err;
  }

  return candidateReal;
}

// ── Routes ────────────────────────────────────────────────────────────────

router.get('/help/articles', async (req, res) => {
  try {
    const data = await getCachedIndex();
    res.json(data);
  } catch (err) {
    console.error('[GET /api/help/articles]', err && err.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to list articles' } });
  }
});

router.get('/help/index', async (req, res) => {
  try {
    const data = await getCachedIndex();
    const grouped = {};
    for (const article of data) {
      const section = article.section || 'root';
      if (!grouped[section]) grouped[section] = [];
      grouped[section].push(article);
    }
    res.json(grouped);
  } catch (err) {
    console.error('[GET /api/help/index]', err && err.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to build help index' } });
  }
});

router.get('/help/articles/:slug(*)', async (req, res) => {
  const slug = req.params.slug || '';
  try {
    const filePath = await resolveSlugToFile(slug);
    const raw = await fs.readFile(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const titleFromMeta = typeof frontmatter.title === 'string' && frontmatter.title.length
      ? frontmatter.title
      : null;
    const title = titleFromMeta || slug.split('/').pop() || slug;
    const forArr = Array.isArray(frontmatter.for) ? frontmatter.for : [];
    const lastReviewed = typeof frontmatter.lastReviewed === 'string' ? frontmatter.lastReviewed : '';

    res.json({
      slug,
      title,
      for: forArr,
      lastReviewed,
      content: body,
    });
  } catch (err) {
    const code = err && err.statusCode;
    if (code === 400) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_SLUG', message: 'Invalid slug' } });
    }
    if (code === 404) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Article not found' } });
    }
    console.error('[GET /api/help/articles/:slug]', err && err.message);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to read article' } });
  }
});

module.exports = router;
