/* eslint-disable no-console */
/**
 * Scrape hood.de category list (IDs + names + hierarchy) using BrightData Web Unlocker.
 *
 * Why this exists:
 * - hood.de uses numeric category IDs internally ("Kategorienummer").
 * - Public category pages embed `categoryID` + `catID` markers in HTML.
 * - We need a complete list to map inventory categories.
 *
 * Output:
 * - backend/exports/hood/categories-hood.json
 * - backend/exports/hood/categories-hood.csv
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud BRIGHTDATA_MAX_TEXT_BYTES=600000 node backend/scripts/scrape-hood-categories.js
 *
 * Options (env or argv):
 *   --limit <n> / LIMIT=...           max unique category URLs to process (default 2000)
 *   --concurrency <n> / CONCURRENCY= max parallel fetches (default 4, max 8)
 *   --seed-only / SEED_ONLY=1         only parse sitemap-derived category URLs (no child-link expansion)
 *   --out <dir> / OUT_DIR=...         output directory (default backend/exports/hood)
 *
 * Notes:
 * - This is best-effort scraping. Some categories may not appear in sitemaps; link expansion helps.
 * - We avoid item pages (/i/...) and non-category pages (*.htm, /tip/, /shop/, /api/).
 */
const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€');
}
function normalizeSpaces(text = '') {
  return decodeHtmlEntities(safeString(text)).replace(/\s+/g, ' ').trim();
}

function isLikelyCategoryUrl(url) {
  const u = safeString(url);
  if (!u.startsWith('https://www.hood.de/')) return false;
  try {
    const parsed = new URL(u);
    const p = parsed.pathname || '/';
    if (!p || p === '/') return false;
    if (p.startsWith('/i/')) return false; // item
    if (p.startsWith('/shop/')) return false;
    if (p.startsWith('/tip/')) return false;
    if (p.startsWith('/tips/')) return false;
    if (p.startsWith('/api/')) return false;
    if (p.startsWith('/interface/')) return false;
    if (p.startsWith('/f/')) return false;
    if (/\.xml$/i.test(p)) return false;
    // Most category pages are "pretty" paths without extension. Exclude .htm (help/landing pages).
    if (/\.htm$/i.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

function stripQuery(url) {
  try {
    const u = new URL(String(url));
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return safeString(url);
  }
}

async function fetchText(url) {
  const res = await fetchWithUnlocker({
    url,
    timeoutMs: 45_000,
    method: 'GET',
    format: 'raw',
  });
  return {
    ok: Boolean(res?.success),
    status: res?.status || 0,
    body: String(res?.body || ''),
  };
}

async function fetchSitemapIndex() {
  const res = await fetchText('https://www.hood.de/f/siteindex.xml');
  if (!res.ok) throw new Error(`Failed to fetch siteindex.xml (status=${res.status})`);
  const locs = Array.from(res.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => safeString(m[1]));
  const sitemapUrls = locs.filter((u) => u.includes('/f/sitemaps') && u.endsWith('.xml'));
  return Array.from(new Set(sitemapUrls));
}

async function fetchSitemapUrls(sitemapUrl) {
  const res = await fetchText(sitemapUrl);
  if (!res.ok) return [];
  const locs = Array.from(res.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => safeString(m[1]));
  return locs.map(stripQuery).filter(isLikelyCategoryUrl);
}

function parseCategoryId(html) {
  const m =
    html.match(/name="categoryID"\s+value="(\d+)"/i) ||
    html.match(/name='categoryID'\s+value='(\d+)'/i) ||
    html.match(/categoryID"\s+value="(\d+)"/i);
  return m ? safeString(m[1]) : '';
}

function parseH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpaces(m[1].replace(/<[^>]+>/g, ' '));
}

function parseSubcategoryLinks(html) {
  // Extract (catID, href, name) from anchor tags. hood.de uses `catID="12345"` attributes.
  const out = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*catID="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = safeString(m[1]);
    const id = safeString(m[2]);
    const name = normalizeSpaces(String(m[3] || '').replace(/<[^>]+>/g, ' '));
    if (!id || !href) continue;
    const url = href.startsWith('http') ? href : `https://www.hood.de${href.startsWith('/') ? '' : '/'}${href}`;
    const clean = stripQuery(url);
    if (!isLikelyCategoryUrl(clean)) continue;
    if (!name) continue;
    out.push({ id, url: clean, name });
    if (out.length > 1000) break; // safety per page
  }
  return out;
}

function parentUrlFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length <= 1) return null;
    const parentPath = `/${parts.slice(0, -1).join('/')}`;
    u.pathname = parentPath;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    const needs = /[",\n\r]/.test(s);
    const inner = s.replace(/"/g, '""');
    return needs ? `"${inner}"` : inner;
  };
  const header = ['id', 'name', 'url', 'parentId', 'parentUrl', 'path'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        esc(r.id),
        esc(r.name),
        esc(r.url),
        esc(r.parentId || ''),
        esc(r.parentUrl || ''),
        esc(r.path || ''),
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function buildPathFor(id, byId) {
  const seen = new Set();
  const names = [];
  let cur = id;
  while (cur && byId[cur] && !seen.has(cur)) {
    seen.add(cur);
    names.unshift(byId[cur].name || '');
    cur = byId[cur].parentId || null;
    if (seen.size > 50) break; // safety
  }
  return names.filter(Boolean).join(' > ');
}

async function main() {
  const limit = Math.max(50, parseInt(argValue('--limit', process.env.LIMIT || '2000'), 10) || 2000);
  const concurrency = Math.max(
    1,
    Math.min(8, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '4'), 10) || 4)
  );
  const seedOnly = argFlag('--seed-only') || String(process.env.SEED_ONLY || '').trim() === '1';
  const outDir = path.resolve(String(argValue('--out', process.env.OUT_DIR || 'backend/exports/hood')));
  ensureDir(outDir);

  console.log(JSON.stringify({ action: 'scrape-hood-categories', limit, concurrency, seedOnly, outDir }, null, 2));

  const sitemapUrls = await fetchSitemapIndex();
  console.log(JSON.stringify({ sitemapIndexCount: sitemapUrls.length, sitemapUrls }, null, 2));

  const seedSet = new Set();
  for (const sm of sitemapUrls) {
    const urls = await fetchSitemapUrls(sm);
    urls.forEach((u) => seedSet.add(u));
  }
  const seedUrls = Array.from(seedSet);
  console.log(JSON.stringify({ seedUrls: seedUrls.length }, null, 2));

  // Crawl queue
  const queue = new PQueue({ concurrency });
  const seenUrl = new Set();
  const byId = {}; // id -> record
  const byUrl = {}; // url -> id

  const pending = [];
  const pushUrl = (u) => {
    const url = stripQuery(u);
    if (!isLikelyCategoryUrl(url)) return;
    if (seenUrl.has(url)) return;
    seenUrl.add(url);
    pending.push(url);
  };

  seedUrls.slice(0, limit).forEach(pushUrl);

  let processed = 0;
  let ok = 0;
  let failed = 0;
  let discovered = seenUrl.size;

  const processOne = async (url) => {
    const res = await fetchText(url);
    if (!res.ok || !res.body) return { ok: false, url, status: res.status };
    const html = res.body;
    const id = parseCategoryId(html);
    const name = parseH1(html) || normalizeSpaces(new URL(url).pathname.split('/').pop() || '');
    if (!id) {
      return { ok: false, url, status: res.status, reason: 'missing_categoryID' };
    }

    const parentUrl = parentUrlFromUrl(url);
    const record = byId[id] || {
      id,
      name,
      url,
      parentId: null,
      parentUrl: parentUrl || null,
      sources: [],
    };

    // Prefer human title/name if we newly found it.
    if (!record.name && name) record.name = name;
    // Prefer shortest URL as canonical.
    if (!record.url || String(url).length < String(record.url).length) record.url = url;
    record.parentUrl = record.parentUrl || parentUrl || null;
    record.sources = Array.from(new Set([...(record.sources || []), url])).slice(0, 5);
    byId[id] = record;
    byUrl[url] = id;

    // Discover subcategory links on this page.
    if (!seedOnly) {
      const subs = parseSubcategoryLinks(html);
      for (const s of subs) {
        // Link child record early (parentUrl is this url)
        if (!byId[s.id]) {
          byId[s.id] = {
            id: s.id,
            name: s.name,
            url: s.url,
            parentId: null,
            parentUrl: url,
            sources: [s.url],
          };
        } else {
          if (!byId[s.id].name && s.name) byId[s.id].name = s.name;
          if (!byId[s.id].parentUrl) byId[s.id].parentUrl = url;
          if (!byId[s.id].url || s.url.length < byId[s.id].url.length) byId[s.id].url = s.url;
        }
        pushUrl(s.url);
      }
    }

    return { ok: true, url, id };
  };

  while (pending.length && processed < limit) {
    const batch = pending.splice(0, Math.min(200, limit - processed));
    await Promise.all(
      batch.map((url) =>
        queue.add(async () => {
          processed += 1;
          const r = await processOne(url).catch((e) => ({ ok: false, url, reason: e?.message || 'exception' }));
          if (r.ok) ok += 1;
          else failed += 1;
          discovered = seenUrl.size;
          if (processed % 50 === 0 || processed === 1) {
            console.log(JSON.stringify({ progress: processed, ok, failed, discovered, uniqueIds: Object.keys(byId).length }, null, 2));
          }
        })
      )
    );
  }

  // Resolve parentId by matching parentUrl -> id
  for (const id of Object.keys(byId)) {
    const rec = byId[id];
    if (rec.parentId) continue;
    const pUrl = rec.parentUrl ? stripQuery(rec.parentUrl) : null;
    if (pUrl && byUrl[pUrl]) {
      rec.parentId = byUrl[pUrl];
    }
  }

  // Compute path strings
  const rows = Object.keys(byId)
    .map((id) => {
      const rec = byId[id];
      return {
        id: rec.id,
        name: rec.name || '',
        url: rec.url || '',
        parentId: rec.parentId || null,
        parentUrl: rec.parentUrl || null,
        path: '',
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));

  const byIdForPath = {};
  rows.forEach((r) => (byIdForPath[r.id] = r));
  rows.forEach((r) => {
    r.path = buildPathFor(r.id, byIdForPath);
  });

  const outJson = path.join(outDir, 'categories-hood.json');
  const outCsv = path.join(outDir, 'categories-hood.csv');
  fs.writeFileSync(outJson, JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, rows }, null, 2), 'utf8');
  fs.writeFileSync(outCsv, toCsv(rows), 'utf8');

  console.log(JSON.stringify({ done: true, processed, ok, failed, discoveredUrls: discovered, uniqueCategoryIds: rows.length, outJson, outCsv }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

