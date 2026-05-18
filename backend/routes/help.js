/**
 * Help Drawer routes — serves the in-repo Knowledge Base (docs/kb/) to
 * authenticated UI clients. All routes are read-only.
 *
 * Strategy:
 *   1) PRIMARY: load pre-bundled `backend/data/help-bundle.json` (created by
 *      `node backend/scripts/sync-help-bundle.js`). This is the only source
 *      that exists inside the Cloud Run container (build context = backend/).
 *   2) FALLBACK (local dev only): walk docs/kb/ if the bundle is missing.
 *
 * GET /api/help/articles          → flat list of all articles (index only)
 * GET /api/help/articles/:slug(*) → single article (markdown content)
 * GET /api/help/index             → articles grouped by top-level section
 *
 * Path-traversal hardening:
 *  - slug must match /^[a-zA-Z0-9_\-\/]+$/
 *  - excluded folders (_audit-runs, _assets) refused
 *  - bundle lookup is by exact-slug key, so no filesystem path is constructed
 *    from user input on the primary path.
 */

const { Router } = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const router = Router();

const REPO_ROOT_KB = path.resolve(__dirname, '..', '..', 'docs', 'kb');
const BUNDLE_PATH = path.resolve(__dirname, '..', 'data', 'help-bundle.json');
const EXCLUDED_TOP_DIRS = new Set(['_audit-runs', '_assets']);

const INDEX_CACHE_TTL_MS = 60 * 1000;
const BUNDLE_CACHE_TTL_MS = 5 * 60 * 1000; // bundle is mostly static
let _indexCache = null; // { at, data }
let _bundleCache = null; // { at, articlesBySlug, listMeta }

// ── Frontmatter parser (only used by the filesystem fallback) ──────────────
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
      out[key] = inner ? inner.split(',').map((p) => stripQuotes(p)).filter(Boolean) : [];
    } else {
      out[key] = stripQuotes(valueRaw);
    }
  }
  return { frontmatter: out, body };
}

// ── Bundle loader (primary) ─────────────────────────────────────────────────
function loadBundleSync() {
  const now = Date.now();
  if (_bundleCache && now - _bundleCache.at < BUNDLE_CACHE_TTL_MS) {
    return _bundleCache;
  }
  if (!fsSync.existsSync(BUNDLE_PATH)) {
    _bundleCache = { at: now, articlesBySlug: null, listMeta: null, source: 'missing' };
    return _bundleCache;
  }
  try {
    const raw = fsSync.readFileSync(BUNDLE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.articles)) {
      _bundleCache = { at: now, articlesBySlug: null, listMeta: null, source: 'corrupt' };
      return _bundleCache;
    }
    const articlesBySlug = new Map();
    const listMeta = [];
    for (const a of parsed.articles) {
      if (!a || typeof a.slug !== 'string') continue;
      articlesBySlug.set(a.slug, a);
      listMeta.push({
        slug: a.slug,
        title: a.title || a.slug,
        for: Array.isArray(a.for) ? a.for : [],
        lastReviewed: typeof a.lastReviewed === 'string' ? a.lastReviewed : '',
        section: typeof a.section === 'string' ? a.section : (a.slug.includes('/') ? a.slug.split('/')[0] : 'root'),
      });
    }
    listMeta.sort((x, y) => x.slug.localeCompare(y.slug));
    _bundleCache = { at: now, articlesBySlug, listMeta, source: 'bundle' };
    return _bundleCache;
  } catch (err) {
    console.error('[help] bundle load failed:', err && err.message);
    _bundleCache = { at: now, articlesBySlug: null, listMeta: null, source: 'error' };
    return _bundleCache;
  }
}

// ── Filesystem fallback (local dev only) ────────────────────────────────────
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
      const rel = path.relative(baseDir, abs).split(path.sep)[0];
      if (EXCLUDED_TOP_DIRS.has(rel)) continue;
      files.push(...(await walkMarkdown(abs, baseDir)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const rel = path.relative(baseDir, abs).split(path.sep)[0];
    if (EXCLUDED_TOP_DIRS.has(rel)) continue;
    files.push(abs);
  }
  return files;
}

function toSlug(absPath) {
  const rel = path.relative(REPO_ROOT_KB, absPath);
  return rel.replace(/\.md$/i, '').split(path.sep).join('/');
}

function sectionForSlug(slug) {
  const idx = slug.indexOf('/');
  return idx === -1 ? 'root' : slug.slice(0, idx);
}

async function buildFsIndex() {
  const files = await walkMarkdown(REPO_ROOT_KB, REPO_ROOT_KB);
  const metas = [];
  for (const abs of files) {
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const slug = toSlug(abs);
      const title = (typeof frontmatter.title === 'string' && frontmatter.title) || slug.split('/').pop() || slug;
      metas.push({
        slug,
        title,
        for: Array.isArray(frontmatter.for) ? frontmatter.for : [],
        lastReviewed: typeof frontmatter.lastReviewed === 'string' ? frontmatter.lastReviewed : '',
        section: sectionForSlug(slug),
      });
    } catch (_) {
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

  // Primary: bundle
  const bundle = loadBundleSync();
  if (bundle.listMeta) {
    _indexCache = { at: now, data: bundle.listMeta };
    return bundle.listMeta;
  }

  // Fallback: filesystem (local dev)
  if (fsSync.existsSync(REPO_ROOT_KB)) {
    const data = await buildFsIndex();
    _indexCache = { at: now, data };
    return data;
  }

  _indexCache = { at: now, data: [] };
  return [];
}

// ── Path-traversal guard for filesystem fallback ────────────────────────────
const SLUG_RE = /^[a-zA-Z0-9_\-/]+$/;

function validateSlug(slug) {
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
}

async function resolveSlugFromFs(slug) {
  const candidate = path.join(REPO_ROOT_KB, `${slug}.md`);
  let rootReal = REPO_ROOT_KB;
  try {
    rootReal = await fs.realpath(REPO_ROOT_KB);
  } catch (_) {}
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
    validateSlug(slug);

    // Primary: bundle
    const bundle = loadBundleSync();
    if (bundle.articlesBySlug && bundle.articlesBySlug.has(slug)) {
      const a = bundle.articlesBySlug.get(slug);
      return res.json({
        slug: a.slug,
        title: a.title,
        for: Array.isArray(a.for) ? a.for : [],
        lastReviewed: a.lastReviewed || '',
        content: a.content || '',
      });
    }

    // Fallback: filesystem
    if (fsSync.existsSync(REPO_ROOT_KB)) {
      const filePath = await resolveSlugFromFs(slug);
      const raw = await fs.readFile(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const titleFromMeta = typeof frontmatter.title === 'string' && frontmatter.title.length ? frontmatter.title : null;
      const title = titleFromMeta || slug.split('/').pop() || slug;
      return res.json({
        slug,
        title,
        for: Array.isArray(frontmatter.for) ? frontmatter.for : [],
        lastReviewed: typeof frontmatter.lastReviewed === 'string' ? frontmatter.lastReviewed : '',
        content: body,
      });
    }

    // Neither source available
    const e = new Error('Not found');
    e.statusCode = 404;
    throw e;
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
