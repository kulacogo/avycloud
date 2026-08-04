'use strict';

/**
 * grounding-redirect-resolve.js — löst opake Google-Grounding-Redirect-URLs
 * auf ihre echten Ziel-URLs auf.
 *
 * Muster seit Chat-Grounding-Start 2026-08-04: Die googleSearch-Quellen
 * kommen als vertexaisearch.cloud.google.com/grounding-api-redirect/…-Links.
 * Downstream können weder classifyPriceSourceUrl (Domain unbekannt) noch die
 * Beleg-Verifikation (Zielseite hinter Redirect) etwas damit anfangen — und
 * im Datenblatt stünde eine Google-URL statt der echten Quelle. Dieser Helper
 * folgt den Redirects (max 3 Hops, kurzer Timeout) und liefert die Ziel-URL.
 * Fail-open: jede Störung behält die Original-URL. Nicht-Redirect-URLs werden
 * ohne Netz-Call durchgereicht.
 */

const MAX_HOPS = 3;
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_URLS = 10;

const REDIRECT_HOST_RE = /^https:\/\/(vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/|www\.google\.[a-z.]+\/url\?)/i;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function isGroundingRedirectUrl(url) {
  return REDIRECT_HOST_RE.test(safeString(url));
}

async function _resolveOne(url, fetchImpl, timeoutMs) {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          ...(controller ? { signal: controller.signal } : {}),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return url; // fail-open: Original behalten
    }
    const status = Number(response && response.status) || 0;
    const location = response && response.headers && typeof response.headers.get === 'function'
      ? safeString(response.headers.get('location'))
      : '';
    if (status >= 300 && status < 400 && location) {
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return url;
      }
      if (!isGroundingRedirectUrl(next)) return next; // echtes Ziel erreicht
      current = next; // weitere Redirect-Stufe
      continue;
    }
    return url; // kein Redirect (2xx/4xx/5xx) → Original behalten
  }
  return url; // Hop-Limit erreicht → Original behalten
}

/**
 * @param {Array<string>} urls
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<string>>} gleiche Reihenfolge; Redirects aufgelöst,
 *   alles andere unverändert
 */
async function resolveGroundingRedirects(urls, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = (Array.isArray(urls) ? urls : []).map(safeString).filter(Boolean).slice(0, MAX_URLS);
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  return Promise.all(list.map((u) => (
    isGroundingRedirectUrl(u) ? _resolveOne(u, doFetch, timeoutMs) : Promise.resolve(u)
  )));
}

module.exports = { resolveGroundingRedirects, isGroundingRedirectUrl };
