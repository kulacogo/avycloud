/**
 * Best-effort HTML web search + page fetch utilities.
 *
 * Notes:
 * - DuckDuckGo HTML endpoint is not an official API; markup may change.
 * - Google HTML SERP is often blocked; we only attempt when unlocker is enabled.
 */

const { fetchWithUnlocker } = require('./web-unlocker');
const { callSerpApi } = require('./serpapi');

const BRIGHTDATA_ONLY =
  (process.env.WEB_BRIGHTDATA_ONLY || 'true').toString().trim().toLowerCase() !== 'false';

// In BrightData-only mode we must be able to fetch pages; default to enabled unless explicitly disabled.
const USE_UNLOCKER = (() => {
  const raw = (process.env.WEB_USE_UNLOCKER || process.env.BARCODE_WEB_USE_UNLOCKER || '').toString().trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  return BRIGHTDATA_ONLY ? true : false;
})();

// Some "EAN search" sites list unrelated codes; block them for safety.
const DOMAIN_BLOCKLIST = new Set([
  'www.ean1.de',
  'ean1.de',
  'www.ean-suche.de',
  'ean-suche.de',
  'www.ean-suche.com',
  'ean-suche.com',
]);

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function htmlToText(html = '') {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:div|p|br|li|ul|ol|h\d|tr|td|th|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeSpaces(decodeHtmlEntities(cleaned)).slice(0, 250_000);
}

async function fetchTextDirect(url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    const ok = res.ok && res.status !== 202;
    return { ok, status: res.status, body: text, via: 'direct' };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message, via: 'direct' };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, { timeoutMs = 20_000 } = {}) {
  if (!BRIGHTDATA_ONLY) {
    const direct = await fetchTextDirect(url, { timeoutMs });
    if (direct.ok && direct.body) return direct;
    if (!USE_UNLOCKER) return direct;
    try {
      const unlocked = await fetchWithUnlocker({ url, timeoutMs: Math.max(30_000, timeoutMs) });
      if (unlocked?.success && unlocked?.body) {
        return { ok: true, status: unlocked.status, body: unlocked.body, via: 'unlocker' };
      }
      return {
        ok: false,
        status: unlocked?.status || 0,
        body: unlocked?.body || '',
        error: unlocked?.statusText || unlocked?.error || null,
        via: 'unlocker',
      };
    } catch (e) {
      return { ...direct, via: 'direct+unlocker_failed', unlockerError: e.message };
    }
  }

  // BrightData-only mode: do NOT attempt direct fetches.
  if (!USE_UNLOCKER) {
    return { ok: false, status: 0, body: '', error: 'unlocker_disabled', via: 'unlocker_disabled' };
  }
  try {
    const unlocked = await fetchWithUnlocker({ url, timeoutMs: Math.max(30_000, timeoutMs) });
    if (unlocked?.success && unlocked?.body) {
      return { ok: true, status: unlocked.status, body: unlocked.body, via: 'unlocker' };
    }
    return {
      ok: false,
      status: unlocked?.status || 0,
      body: unlocked?.body || '',
      error: unlocked?.statusText || unlocked?.error || null,
      via: 'unlocker',
    };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message, via: 'unlocker_failed' };
  }
}

async function fetchPageText(url, { timeoutMs = 20_000 } = {}) {
  const res = await fetchText(url, { timeoutMs });
  if (!res.ok || !res.body) return { ok: false, status: res.status, text: '', via: res.via, url };
  return { ok: true, status: res.status, text: htmlToText(res.body), via: res.via, url };
}

async function searchDuckDuckGo(query, { limit = 6 } = {}) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchText(url, { timeoutMs: 25_000 });
  if (!res.ok || !res.body) {
    return { query, ok: false, url, via: res.via, status: res.status, results: [] };
  }

  const html = res.body;
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const title = normalizeSpaces(decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ')));
    let outUrl = href;
    const uddg = href.match(/[?&]uddg=([^&]+)/i);
    if (uddg && uddg[1]) {
      try {
        outUrl = decodeURIComponent(uddg[1]);
      } catch {
        outUrl = href;
      }
    }
    if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
    if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
    try {
      const host = new URL(outUrl).host.toLowerCase();
      if (DOMAIN_BLOCKLIST.has(host)) continue;
      if (host.endsWith('duckduckgo.com')) continue;
      if (host === 'bing.com' || host === 'www.bing.com') continue;
      if (/\/aclick/i.test(outUrl)) continue;
    } catch {
      // ignore parse errors
    }
    results.push({ title, url: outUrl });
    if (results.length >= limit) break;
  }
  return { query, ok: true, url, via: res.via, status: res.status, results };
}

async function searchGoogle(query, { limit = 6, locale = 'de-DE' } = {}) {
  if (!USE_UNLOCKER) {
    return { query, ok: false, url: '', via: 'disabled', status: 0, results: [] };
  }
  const trimmedQuery = safeString(query).slice(0, 140);
  const hl = locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const url = `https://www.google.com/search?q=${encodeURIComponent(trimmedQuery)}&hl=${hl}&gl=de`;
  try {
    const fetched = await fetchWithUnlocker({ url, timeoutMs: 45_000 });
    const html = String(fetched?.body || '');
    const ok = Boolean(fetched?.success);
    const status = fetched?.status || 0;
    if (!ok || !html) {
      return { query: trimmedQuery, ok: false, url, via: 'unlocker', status, results: [], error: fetched?.error || null };
    }
    const results = [];
    const seen = new Set();
    const re = /href="(https?:\/\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(html))) {
      const outUrl = decodeHtmlEntities(m[1] || '').replace(/&amp;/g, '&');
      if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
      if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
      if (seen.has(outUrl)) continue;
      try {
        const parsed = new URL(outUrl);
        const host = parsed.host.toLowerCase();
        if (DOMAIN_BLOCKLIST.has(host)) continue;
        if (
          host.endsWith('google.com') ||
          host.endsWith('google.de') ||
          host.endsWith('gstatic.com') ||
          host.endsWith('googleusercontent.com') ||
          host.endsWith('accounts.google.com') ||
          host.endsWith('support.google.com') ||
          host.endsWith('translate.google.com')
        ) {
          continue;
        }
        if (
          /\/(search|webhp|preferences|policies|advanced_search|setprefs)/i.test(parsed.pathname) ||
          /accounts\.google\.com/i.test(outUrl)
        ) {
          continue;
        }
      } catch {
        // ignore
      }
      seen.add(outUrl);
      results.push({ title: '', url: outUrl });
      if (results.length >= limit) break;
    }
    return { query: trimmedQuery, ok: true, url, via: 'unlocker', status, results };
  } catch (e) {
    return { query: trimmedQuery, ok: false, url, via: 'unlocker', status: 0, results: [], error: e.message };
  }
}

async function searchGoogleViaSerpApi(query, { limit = 6, locale = 'de-DE' } = {}) {
  const trimmedQuery = safeString(query).slice(0, 140);
  if (!trimmedQuery) {
    return { query: '', ok: false, url: '', via: 'serpapi', status: 0, results: [] };
  }
  const hl = locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  try {
    const data = await callSerpApi('google', {
      q: trimmedQuery,
      gl: 'de',
      hl,
      google_domain: 'google.de',
      num: Math.min(limit + 4, 20),
    });
    const entries = (data?.organic_results || []).slice(0, limit);
    const results = [];
    for (const entry of entries) {
      const outUrl = entry?.link || entry?.url;
      if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
      if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
      try {
        const host = new URL(outUrl).host.toLowerCase();
        if (DOMAIN_BLOCKLIST.has(host)) continue;
      } catch {
        continue;
      }
      results.push({
        title: entry.title || '',
        url: outUrl,
        snippet: entry.snippet || '',
      });
    }
    return { query: trimmedQuery, ok: results.length > 0, url: '', via: 'serpapi', status: 200, results };
  } catch (e) {
    return { query: trimmedQuery, ok: false, url: '', via: 'serpapi', status: 0, results: [], error: e.message };
  }
}

async function searchWeb(query, { limit = 6, locale = 'de-DE' } = {}) {
  // Prefer Google via SerpAPI (structured JSON, most reliable),
  // then Google via BrightData web unlocker, then DuckDuckGo as last resort.
  const serp = await searchGoogleViaSerpApi(query, { limit, locale });
  if (serp.ok && Array.isArray(serp.results) && serp.results.length) {
    return { engine: 'google', ...serp };
  }
  const google = await searchGoogle(query, { limit, locale });
  if (google.ok && Array.isArray(google.results) && google.results.length) {
    return { engine: 'google', ...google };
  }
  if (BRIGHTDATA_ONLY) {
    return { engine: 'google', query, ok: false, url: '', via: 'brightdata_only_no_results', status: 0, results: [] };
  }
  const ddg = await searchDuckDuckGo(query, { limit });
  return { engine: 'duckduckgo', ...ddg };
}

module.exports = {
  searchWeb,
  fetchPageText,
  htmlToText,
  decodeHtmlEntities,
  normalizeSpaces,
  safeString,
  DOMAIN_BLOCKLIST,
};

