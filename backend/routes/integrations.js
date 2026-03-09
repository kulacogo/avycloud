const express = require('express');
const router = express.Router();
const { getSecretValue } = require('../lib/secret-values');
const { getEbayIntegration, publicStatus } = require('../lib/ebay-oauth');
const { requirePermission } = require('../lib/rbac');
const {
  getProvider,
  getAllProviders,
  validateCredentialFields,
} = require('../lib/integration-registry');
const integrationStore = require('../services/integration-store');

/**
 * GET /api/integrations/status
 * Returns real connection status for all active integrations.
 * Checks: Firestore self-service → eBay OAuth → Secret Manager fallback.
 */
router.get('/integrations/status', async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const results = [];

    // Load self-service integrations from Firestore
    const storedIntegrations = await integrationStore.listIntegrations({ tenantId }).catch(() => []);
    const storedMap = new Map(storedIntegrations.map((i) => [i.type, i]));

    // eBay — check OAuth integration doc in Firestore
    const ebayDoc = await getEbayIntegration().catch((err) => {
      console.warn(`[integrations/status] eBay check failed: ${err.message}`);
      return null;
    });
    const ebayStatus = publicStatus(ebayDoc);
    let ebayConnected = ebayStatus.connected;
    if (!ebayConnected) {
      const ebaySecret = await getSecretValue('EBAY_CLIENT_SECRET').catch(() => null);
      if (ebaySecret) ebayConnected = true;
    }
    if (!ebayConnected && storedMap.has('ebay')) {
      ebayConnected = storedMap.get('ebay').status === 'active';
    }
    results.push({
      id: 'ebay',
      name: 'eBay',
      description: 'Online-Marktplatz für Auktionen und Sofortkauf',
      category: 'marketplaces',
      authType: 'oauth2',
      status: ebayConnected ? 'connected' : 'not_connected',
      connectedAt: ebayStatus.connectedAt || storedMap.get('ebay')?.connectedAt || null,
      updatedAt: ebayStatus.updatedAt || storedMap.get('ebay')?.updatedAt || null,
      lastRefreshedAt: ebayStatus.lastRefreshedAt || null,
      details: {
        env: ebayStatus.env,
        scopes: ebayStatus.scopes,
        tokenType: ebayStatus.tokenType,
        accessTokenExpiresAt: ebayStatus.accessTokenExpiresAt,
      },
    });

    // API-Key integrations: check Firestore self-service → Secret Manager fallback
    const apiKeyProviders = [
      { id: 'kaufland', secretKey: 'KAUFLAND_CLIENT_KEY' },
      { id: 'baselinker', secretKey: 'BASELINKER_TOKEN' },
      { id: 'sendcloud', secretKey: 'SENDCLOUD_PUBLIC_KEY' },
      { id: 'sevdesk', secretKey: 'SEVDESK_API_TOKEN' },
    ];

    for (const { id, secretKey } of apiKeyProviders) {
      const provider = getProvider(id);
      const stored = storedMap.get(id);
      let connected = stored?.status === 'active';

      if (!connected) {
        const secret = await getSecretValue(secretKey).catch(() => null);
        connected = !!secret;
      }

      results.push({
        id,
        name: provider?.name || id,
        description: provider?.description || '',
        category: provider?.category || 'other',
        authType: provider?.authType || 'api_key',
        status: connected ? 'connected' : 'not_connected',
        connectedAt: stored?.connectedAt || null,
        updatedAt: stored?.updatedAt || null,
        settings: stored?.settings || null,
        connectedBy: stored?.connectedBy || null,
      });
    }

    // DHL — via SendCloud dependency
    const sendcloudConnected = results.find((r) => r.id === 'sendcloud')?.status === 'connected';
    const dhlProvider = getProvider('dhl');
    results.push({
      id: 'dhl',
      name: dhlProvider?.name || 'DHL',
      description: dhlProvider?.description || 'Pakete bis 31,5 kg (via SendCloud)',
      category: 'shipping',
      authType: 'none',
      status: sendcloudConnected ? 'connected' : 'not_connected',
      dependsOn: 'sendcloud',
    });

    res.json({ ok: true, data: results });
  } catch (err) {
    console.error(`[GET /api/integrations/status] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/integrations/providers
 * Returns available provider configurations (for the wizard UI).
 */
router.get('/integrations/providers', async (req, res) => {
  try {
    const providers = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      authType: p.authType,
      logo: p.logo,
      helpUrl: p.helpUrl,
      helpText: p.helpText,
      features: p.features,
      fields: p.fields || [],
      dependsOn: p.dependsOn || null,
    }));
    res.json({ ok: true, data: providers });
  } catch (err) {
    console.error(`[GET /api/integrations/providers] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/integrations/:type/connect
 * Connect an API-key-based integration by saving credentials.
 * For OAuth integrations, use the existing OAuth flow (e.g. /api/ebay/oauth/start).
 */
router.post('/integrations/:type/connect', requirePermission('integrations', 'write'), async (req, res) => {
  try {
    const { type } = req.params;
    const { credentials } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    const provider = getProvider(type);
    if (!provider) {
      return res.status(400).json({ ok: false, error: { code: 'UNKNOWN_PROVIDER', message: `Unbekannter Anbieter: ${type}` } });
    }

    if (provider.authType === 'oauth2') {
      return res.status(400).json({
        ok: false,
        error: { code: 'USE_OAUTH', message: 'Dieser Anbieter nutzt OAuth. Bitte den OAuth-Flow starten.' },
      });
    }

    if (provider.authType === 'none') {
      return res.status(400).json({
        ok: false,
        error: { code: 'NOT_CONFIGURABLE', message: `${provider.name} wird automatisch über ${provider.dependsOn} verbunden.` },
      });
    }

    // Validate credential fields
    const validation = validateCredentialFields(type, credentials);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION', message: validation.errors.join(', ') },
      });
    }

    // Test connection before saving
    const testResult = await integrationStore.testConnection({ type, credentials });
    if (!testResult.ok) {
      return res.status(400).json({
        ok: false,
        error: { code: 'CONNECTION_FAILED', message: testResult.message },
      });
    }

    // Save credentials
    const result = await integrationStore.saveIntegration({
      tenantId,
      type,
      authType: provider.authType,
      credentials,
      actor: req.user ? { uid: req.user.uid, email: req.user.email } : null,
    });

    res.json({ ok: true, data: { ...result, testMessage: testResult.message } });
  } catch (err) {
    console.error(`[POST /api/integrations/${req.params.type}/connect] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/integrations/:type/test
 * Test connection with provided or stored credentials.
 */
router.post('/integrations/:type/test', requirePermission('integrations', 'read'), async (req, res) => {
  try {
    const { type } = req.params;
    const { credentials } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    const provider = getProvider(type);
    if (!provider) {
      return res.status(400).json({ ok: false, error: { code: 'UNKNOWN_PROVIDER', message: `Unbekannter Anbieter: ${type}` } });
    }

    // Use provided credentials or resolve from store
    let creds = credentials;
    if (!creds) {
      creds = await integrationStore.resolveCredentials({ tenantId, type });
      if (!creds) {
        return res.status(400).json({
          ok: false,
          error: { code: 'NO_CREDENTIALS', message: 'Keine Zugangsdaten gefunden. Bitte zuerst verbinden.' },
        });
      }
    }

    const result = await integrationStore.testConnection({ type, credentials: creds });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/integrations/${req.params.type}/test] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * PUT /api/integrations/:type/settings
 * Update sync settings for a connected integration.
 */
router.put('/integrations/:type/settings', requirePermission('integrations', 'write'), async (req, res) => {
  try {
    const { type } = req.params;
    const { settings } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'settings Objekt ist erforderlich' } });
    }

    const result = await integrationStore.updateSettings({ tenantId, type, settings });
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: result.error } });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[PUT /api/integrations/${req.params.type}/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * DELETE /api/integrations/:type
 * Disconnect an integration and remove stored credentials.
 */
router.delete('/integrations/:type', requirePermission('integrations', 'write'), async (req, res) => {
  try {
    const { type } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    const provider = getProvider(type);
    if (!provider) {
      return res.status(400).json({ ok: false, error: { code: 'UNKNOWN_PROVIDER', message: `Unbekannter Anbieter: ${type}` } });
    }

    const result = await integrationStore.deleteIntegration({ tenantId, type });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[DELETE /api/integrations/${req.params.type}] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/integrations/:type
 * Get details for a single integration (without decrypted credentials).
 */
router.get('/integrations/:type', requirePermission('integrations', 'read'), async (req, res) => {
  try {
    const { type } = req.params;
    const tenantId = req.user?.tenantId || 'default';

    const provider = getProvider(type);
    if (!provider) {
      return res.status(400).json({ ok: false, error: { code: 'UNKNOWN_PROVIDER', message: `Unbekannter Anbieter: ${type}` } });
    }

    const stored = await integrationStore.getIntegration({ tenantId, type });

    // Build response with provider info + stored data
    const data = {
      id: type,
      name: provider.name,
      description: provider.description,
      category: provider.category,
      authType: provider.authType,
      features: provider.features,
      helpUrl: provider.helpUrl,
      helpText: provider.helpText,
      fields: provider.fields || [],
      status: stored?.status || 'not_connected',
      settings: stored?.settings || null,
      connectedAt: stored?.connectedAt || null,
      updatedAt: stored?.updatedAt || null,
      lastSync: stored?.lastSync || null,
      lastError: stored?.lastError || null,
      connectedBy: stored?.connectedBy || null,
    };

    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[GET /api/integrations/${req.params.type}] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
