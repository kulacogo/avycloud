'use strict';

/**
 * Best-effort web fallback for GPSR manufacturer info (name, address, email, url).
 * Used after gpsr-manufacturer-registry.js returned empty.
 *
 * Strategy:
 *   1. Search "[brand] Impressum" via Brightdata
 *   2. Fetch up to 2 candidate URLs via Web Unlocker
 *   3. Parse HTML for:
 *      - Email  (/legal|privacy|impressum|info|contact@.../ preferred)
 *      - Address (German street patterns + PLZ + city)
 *      - Company name (H1, <title>, Impressum heading)
 *      - Manufacturer URL (host of the page itself)
 *   4. Confidence: 0.75 (name+address+email), 0.5 (partial), 0.3 (name only)
 */

const EMAIL_RE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const PLZ_RE = /\b(?:D[-\s]?)?(\d{5})\s+([A-Za-zÄÖÜäöüß.\- ]{2,60})/g;

// Email prefix priorities (lower index = higher preference)
const EMAIL_PREFIX_PRIORITY = [
  'legal',
  'rechtsabteilung',
  'kontakt',
  'compliance',
  'impressum',
  'info',
  'contact',
  'service',
  'support',
  'office',
  'hello',
  'mail',
];

// Prefixes that should be skipped if possible
const EMAIL_PREFIX_BLOCKLIST = ['newsletter', 'no-reply', 'noreply', 'donotreply', 'marketing', 'press', 'presse'];

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function emailPriorityScore(email) {
  const local = String(email).split('@')[0].toLowerCase();
  if (EMAIL_PREFIX_BLOCKLIST.some((p) => local === p || local.startsWith(`${p}-`) || local.startsWith(`${p}.`))) {
    return 1000; // deprioritize
  }
  for (let i = 0; i < EMAIL_PREFIX_PRIORITY.length; i += 1) {
    const prefix = EMAIL_PREFIX_PRIORITY[i];
    if (local === prefix || local.startsWith(`${prefix}@`) || local.startsWith(`${prefix}.`) || local.startsWith(`${prefix}-`)) {
      return i;
    }
  }
  return 100;
}

function extractEmail(text) {
  if (!text) return null;
  const matches = [];
  const seen = new Set();
  let m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const email = m[1].toLowerCase();
    if (seen.has(email)) continue;
    // Skip obvious false positives (images/tracker pixels)
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(email)) continue;
    if (/(example\.com|sentry|wixpress|cloudfront|googletagmanager)/i.test(email)) continue;
    seen.add(email);
    matches.push(email);
  }
  if (!matches.length) return null;
  matches.sort((a, b) => emailPriorityScore(a) - emailPriorityScore(b));
  // Reject if the winner is still blocklisted AND other options were all blocklisted -
  // still return it rather than nothing (best-effort).
  return matches[0];
}

function extractAddress(text) {
  if (!text) return null;
  // Look for "Straße|Str.|Weg|Platz|Allee|Gasse|Ring" followed by a number,
  // plus a line with 5-digit PLZ + city. We try to combine street + PLZ line.
  const streetRe = /([A-ZÄÖÜ][a-zäöüß.\- ]*?(?:stra(?:ß|ss)e|str\.|weg|platz|allee|gasse|ring|damm)\s+\d+[a-zA-Z]?)/g;
  const streets = [];
  let s;
  while ((s = streetRe.exec(text)) !== null) {
    const val = safeString(s[1]);
    if (val && !streets.includes(val)) streets.push(val);
  }

  const plzCityMatches = [];
  let p;
  PLZ_RE.lastIndex = 0;
  while ((p = PLZ_RE.exec(text)) !== null) {
    const plz = p[1];
    const city = safeString(p[2]).split(/\s{2,}/)[0].split('\n')[0].trim();
    if (plz && city && city.length >= 2 && city.length <= 60) {
      plzCityMatches.push(`${plz} ${city}`);
    }
  }

  if (streets.length && plzCityMatches.length) {
    return `${streets[0]}, D-${plzCityMatches[0]}`;
  }
  if (streets.length) return streets[0];
  if (plzCityMatches.length) return `D-${plzCityMatches[0]}`;
  return null;
}

function extractCompanyName(html, plainText) {
  if (!html && !plainText) return null;
  // <title>
  const titleMatch = typeof html === 'string' ? html.match(/<title[^>]*>([^<]{2,200})<\/title>/i) : null;
  const rawTitle = titleMatch ? safeString(titleMatch[1]) : '';

  // H1
  const h1Match = typeof html === 'string' ? html.match(/<h1[^>]*>([^<]{2,120})<\/h1>/i) : null;
  const rawH1 = h1Match ? safeString(h1Match[1]) : '';

  // Prefer H1 when it contains a legal form suffix
  const candidates = [rawH1, rawTitle].filter(Boolean);
  for (const c of candidates) {
    if (/\b(GmbH|AG|SE|KG|Ltd\.?|Inc\.?|LLC|B\.V\.|S\.A\.?)\b/i.test(c)) {
      // Clean trailing " - Impressum" etc.
      return c.replace(/\s*[–\-|]\s*(Impressum|Legal Notice|Kontakt|Home).*$/i, '').trim();
    }
  }
  if (rawH1) return rawH1;
  if (rawTitle) return rawTitle.replace(/\s*[–\-|]\s*(Impressum|Legal Notice|Kontakt|Home).*$/i, '').trim();
  // Fallback: first line of plainText that contains a legal suffix
  const lines = String(plainText || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  const legalLine = lines.find((l) => /\b(GmbH|AG|SE|KG|Ltd\.?|Inc\.?|LLC|B\.V\.)\b/.test(l));
  return legalLine || null;
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
}

function computeConfidence({ name, address, email }) {
  const hasName = Boolean(safeString(name));
  const hasAddr = Boolean(safeString(address));
  const hasEmail = Boolean(safeString(email));
  if (hasName && hasAddr && hasEmail) return 0.75;
  if ((hasAddr && hasEmail) || (hasName && hasAddr) || (hasName && hasEmail)) return 0.5;
  if (hasName) return 0.3;
  return 0;
}

async function fetchHtmlBestEffort(url, timeoutMs) {
  const { executeWebFetchToolCall } = require('../services/toolkit.js');
  const toolCall = {
    arguments: JSON.stringify({ url, method: 'GET', data_format: 'raw', timeout_ms: timeoutMs }),
  };
  const resp = await executeWebFetchToolCall(toolCall);
  if (!resp || resp.success === false) return null;
  // Different toolkit implementations may return { body, content, html }
  return resp.body || resp.content || resp.html || resp.markdown || '';
}

async function lookupGpsrFromWeb(brand, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 10000;
  const empty = {
    manufacturer_name: null,
    manufacturer_address: null,
    manufacturer_email: null,
    manufacturer_url: null,
    confidence: 0,
    sources: [],
  };
  const brandStr = safeString(brand);
  if (!brandStr) return empty;

  const { executeBrightdataSearchToolCall } = require('../services/toolkit.js');
  const query = `"${brandStr}" Impressum GmbH OR AG OR Ltd`;
  let searchRes;
  try {
    searchRes = await Promise.race([
      executeBrightdataSearchToolCall({ arguments: JSON.stringify({ query, limit: 5 }) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gpsr search timeout')), timeout)),
    ]);
  } catch (err) {
    console.warn('[gpsr-web-fallback] search failed:', err?.message || err);
    return empty;
  }

  const candidates = Array.isArray(searchRes?.results) ? searchRes.results.slice(0, 2) : [];
  if (!candidates.length) return empty;

  let best = null;
  const sourceUrls = [];

  for (const entry of candidates) {
    const url = safeString(entry?.url);
    if (!url) continue;
    sourceUrls.push(url);
    let html;
    try {
      html = await Promise.race([
        fetchHtmlBestEffort(url, timeout),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gpsr fetch timeout')), timeout)),
      ]);
    } catch (err) {
      console.warn('[gpsr-web-fallback] fetch failed:', err?.message || err);
      continue;
    }
    if (!html) continue;
    const plain = stripTags(html);
    const email = extractEmail(plain);
    const address = extractAddress(plain);
    const name = extractCompanyName(html, plain);
    const manufacturerUrl = hostFromUrl(url);

    const candidate = {
      manufacturer_name: name,
      manufacturer_address: address,
      manufacturer_email: email,
      manufacturer_url: manufacturerUrl,
    };
    const conf = computeConfidence({ name, address, email });
    if (!best || conf > best.confidence) {
      best = { ...candidate, confidence: conf };
      if (conf >= 0.75) break; // good enough, stop early
    }
  }

  if (!best) return { ...empty, sources: sourceUrls };
  return {
    manufacturer_name: best.manufacturer_name || null,
    manufacturer_address: best.manufacturer_address || null,
    manufacturer_email: best.manufacturer_email || null,
    manufacturer_url: best.manufacturer_url || null,
    confidence: best.confidence,
    sources: sourceUrls.slice(0, 5),
  };
}

module.exports = {
  lookupGpsrFromWeb,
  // exported for unit tests
  stripTags,
  extractEmail,
  extractAddress,
  extractCompanyName,
  computeConfidence,
  emailPriorityScore,
};
