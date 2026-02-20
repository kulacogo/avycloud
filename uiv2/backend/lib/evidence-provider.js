/**
 * Unified web evidence provider for AvyCloud.
 *
 * Goals:
 * - One interface for "search" + "fetch page text"
 * - Prefer BrightData SERP + Web Unlocker when configured (handled inside web-search-html.js)
 * - Avoid SerpAPI dependency in core enrichment paths where possible
 */

const { searchWeb, fetchPageText } = require('./web-search-html');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

async function search(query, { limit = 6, locale = 'de-DE' } = {}) {
  const q = safeString(query);
  if (!q) return { ok: false, engine: null, query: '', results: [], error: 'query_empty' };
  const res = await searchWeb(q, { limit, locale });
  return {
    ok: Boolean(res?.ok),
    engine: res?.engine || res?.via || null,
    query: q,
    results: Array.isArray(res?.results) ? res.results.slice(0, limit) : [],
    error: res?.error || null,
  };
}

async function fetchText(url, { timeoutMs = 20_000 } = {}) {
  const u = safeString(url);
  if (!u) return { ok: false, url: '', status: 0, via: null, text: '', error: 'url_empty' };
  const res = await fetchPageText(u, { timeoutMs });
  return {
    ok: Boolean(res?.ok),
    url: u,
    status: res?.status || 0,
    via: res?.via || null,
    text: res?.text || '',
    error: res?.error || null,
  };
}

async function searchSite(query, site, opts = {}) {
  const q = safeString(query);
  const s = safeString(site);
  if (!q || !s) return { ok: false, engine: null, query: '', results: [], error: 'query_or_site_empty' };
  return await search(`${q} site:${s}`, opts);
}

module.exports = {
  search,
  searchSite,
  fetchText,
};

