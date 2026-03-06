const express = require('express');
const router = express.Router();
const { getSecretValue } = require('../lib/secret-values');
const { getEbayIntegration, publicStatus } = require('../lib/ebay-oauth');

/**
 * GET /api/integrations/status
 * Returns real connection status for all active integrations.
 * Checks: eBay OAuth token, Kaufland/BaseLinker/SendCloud/SevDesk secrets.
 */
router.get('/integrations/status', async (req, res) => {
  try {
    const results = [];

    // eBay — check OAuth integration doc in Firestore
    const ebayDoc = await getEbayIntegration().catch(() => null);
    const ebayStatus = publicStatus(ebayDoc);
    results.push({
      id: 'ebay',
      name: 'eBay',
      description: 'Online-Marktplatz für Auktionen und Sofortkauf',
      category: 'marketplaces',
      status: ebayStatus.connected ? 'connected' : 'not_connected',
      connectedAt: ebayStatus.connectedAt || null,
      updatedAt: ebayStatus.updatedAt || null,
      lastRefreshedAt: ebayStatus.lastRefreshedAt || null,
      details: {
        env: ebayStatus.env,
        scopes: ebayStatus.scopes,
        tokenType: ebayStatus.tokenType,
        accessTokenExpiresAt: ebayStatus.accessTokenExpiresAt,
      },
    });

    // Kaufland — check secret exists
    const kauflandKey = await getSecretValue('KAUFLAND_CLIENT_KEY').catch(() => null);
    results.push({
      id: 'kaufland',
      name: 'Kaufland',
      description: 'Deutscher Online-Marktplatz',
      category: 'marketplaces',
      status: kauflandKey ? 'connected' : 'not_connected',
    });

    // BaseLinker — check token
    const blToken = await getSecretValue('BASELINKER_TOKEN').catch(() => null);
    results.push({
      id: 'baselinker',
      name: 'BaseLinker',
      description: 'Multi-Channel E-Commerce Middleware',
      category: 'other',
      status: blToken ? 'connected' : 'not_connected',
    });

    // SendCloud — check keys
    const scPublic = await getSecretValue('SENDCLOUD_PUBLIC_KEY').catch(() => null);
    results.push({
      id: 'sendcloud',
      name: 'SendCloud',
      description: 'Multi-Carrier Versandplattform (DHL, DPD, etc.)',
      category: 'shipping',
      status: scPublic ? 'connected' : 'not_connected',
    });

    // SevDesk — check token
    const sevToken = await getSecretValue('SEVDESK_API_TOKEN').catch(() => null);
    results.push({
      id: 'sevdesk',
      name: 'SevDesk',
      description: 'Online-Buchhaltung und Rechnungen',
      category: 'finance',
      status: sevToken ? 'connected' : 'not_connected',
    });

    // DHL — via SendCloud (if SendCloud connected, DHL is available)
    results.push({
      id: 'dhl',
      name: 'DHL',
      description: 'Pakete bis 31,5 kg, DE + International (via SendCloud)',
      category: 'shipping',
      status: scPublic ? 'connected' : 'not_connected',
    });

    res.json({ ok: true, data: results });
  } catch (err) {
    console.error(`[GET /api/integrations/status] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
