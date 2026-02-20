/**
 * Bright Data SERP (Direct API) helper.
 *
 * Docs (Bright Data):
 * - Endpoint: https://api.brightdata.com/request
 * - Auth: Authorization: Bearer <API key>
 * - Payload: { zone: <SERP zone>, url: <full SERP URL>, format: "raw" }
 *
 * We reuse our generic `fetchWithUnlocker()` implementation, but point it at the SERP zone.
 */

const { fetchWithUnlocker } = require('./web-unlocker');

const DEFAULT_SERP_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_avy';

async function fetchSerpHtml({
  url,
  zone = DEFAULT_SERP_ZONE,
  timeoutMs = undefined,
  country = undefined,
} = {}) {
  if (!url) throw new Error('url is required');
  if (!zone) throw new Error('BRIGHTDATA_SERP_ZONE is not configured');

  // BrightData SERP API expects the SERP target URL (including query params) in payload.url.
  const res = await fetchWithUnlocker({
    url,
    zone,
    format: 'raw',
    method: 'GET',
    timeoutMs,
    country,
  });

  return {
    ok: Boolean(res?.success),
    status: res?.status || 0,
    body: res?.body || '',
    via: 'brightdata_serp',
    zone: res?.zone || zone,
  };
}

module.exports = {
  fetchSerpHtml,
};

