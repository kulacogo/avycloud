'use strict';

/**
 * Einziger SendCloud-Auth-Builder im Backend (Review 2026-07-05: vorher
 * zwei identische Kopien in lib/sendcloud.js und services/shipping-engine.js).
 * Zugangsdaten via integration-store: Self-Service-Store gewinnt, ENV/Secret
 * Manager bleibt Fallback, 60s-TTL — siehe resolveProviderCredentials.
 */
async function getSendCloudAuthHeader() {
  const { resolveProviderCredentials } = require('../services/integration-store');
  const creds = await resolveProviderCredentials('sendcloud');
  const pub = creds?.publicKey;
  const sec = creds?.secretKey;
  if (!pub || !sec) throw new Error('SENDCLOUD credentials not configured');
  return 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
}

module.exports = { getSendCloudAuthHeader };
