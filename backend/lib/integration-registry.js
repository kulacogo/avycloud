'use strict';

/**
 * integration-registry.js — Central provider configuration for all integrations.
 *
 * Each provider defines:
 *  - authType: 'oauth2' | 'api_key'
 *  - category: 'marketplaces' | 'shipping' | 'finance' | 'other'
 *  - fields: credential input fields (for api_key type)
 *  - oauthConfig: OAuth URLs and scopes (for oauth2 type)
 *  - testFn: async function(credentials) → { ok, message }
 *  - description, logo, helpUrl
 */

const PROVIDERS = {
  ebay: {
    id: 'ebay',
    name: 'eBay',
    description: 'Online-Marktplatz für Auktionen und Sofortkauf',
    category: 'marketplaces',
    authType: 'oauth2',
    logo: 'ebay',
    helpUrl: 'https://developer.ebay.com/my/keys',
    helpText: 'eBay verbindet sich über OAuth 2.0. Klicke auf "Verbinden" und autorisiere AvyCloud in deinem eBay-Konto.',
    features: ['Listings synchronisieren', 'Bestellungen importieren', 'Preise aktualisieren', 'Bestand synchronisieren'],
    oauthConfig: {
      // Actual URLs are built dynamically in ebay-oauth.js based on env (sandbox/production)
      startEndpoint: '/api/ebay/oauth/start',
      callbackEndpoint: '/api/ebay/oauth/callback',
    },
    secretKeys: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RU_NAME'],
  },

  kaufland: {
    id: 'kaufland',
    name: 'Kaufland',
    description: 'Deutscher Online-Marktplatz (ehem. real.de)',
    category: 'marketplaces',
    authType: 'api_key',
    logo: 'kaufland',
    helpUrl: 'https://sellerportal.kaufland.de/settings/api',
    helpText: 'Die API-Zugangsdaten findest du im Kaufland Seller Portal unter Einstellungen → API-Zugangsdaten.',
    features: ['Listings synchronisieren', 'Bestellungen importieren', 'Preise aktualisieren', 'Bestand synchronisieren'],
    fields: [
      { key: 'clientKey', label: 'Client Key', type: 'text', placeholder: '32-stelliger Client Key', required: true, minLength: 10 },
      { key: 'secretKey', label: 'Secret Key', type: 'password', placeholder: '64-stelliger Secret Key', required: true, minLength: 10 },
    ],
    secretKeys: ['KAUFLAND_CLIENT_KEY', 'KAUFLAND_SECRET_KEY'],
    credentialToSecretMap: {
      clientKey: 'KAUFLAND_CLIENT_KEY',
      secretKey: 'KAUFLAND_SECRET_KEY',
    },
  },

  baselinker: {
    id: 'baselinker',
    name: 'BaseLinker',
    description: 'Multi-Channel E-Commerce Middleware',
    category: 'other',
    authType: 'api_key',
    logo: 'baselinker',
    helpUrl: 'https://panel.baselinker.com/other_api_token.html',
    helpText: 'Den API-Token findest du im BaseLinker Panel unter Mein Konto → API.',
    features: ['Bestellungen synchronisieren', 'Lagerbestand abgleichen', 'Versandlabels erstellen'],
    fields: [
      { key: 'apiToken', label: 'API Token', type: 'password', placeholder: 'BaseLinker API Token', required: true, minLength: 10 },
    ],
    secretKeys: ['BASELINKER_TOKEN'],
    credentialToSecretMap: {
      apiToken: 'BASELINKER_TOKEN',
    },
  },

  sendcloud: {
    id: 'sendcloud',
    name: 'SendCloud',
    description: 'Multi-Carrier Versandplattform (DHL, DPD, GLS, etc.)',
    category: 'shipping',
    authType: 'api_key',
    logo: 'sendcloud',
    helpUrl: 'https://app.sendcloud.com/v2/settings/integrations/api',
    helpText: 'Die API-Keys findest du in SendCloud unter Einstellungen → Integrationen → API Keys.',
    features: ['Versandlabels erstellen', 'Tracking-Updates', 'Multi-Carrier-Auswahl', 'Versandkosten berechnen'],
    fields: [
      { key: 'publicKey', label: 'Public Key', type: 'text', placeholder: 'SendCloud Public Key', required: true, minLength: 5 },
      { key: 'secretKey', label: 'Secret Key', type: 'password', placeholder: 'SendCloud Secret Key', required: true, minLength: 5 },
    ],
    secretKeys: ['SENDCLOUD_PUBLIC_KEY', 'SENDCLOUD_SECRET_KEY'],
    credentialToSecretMap: {
      publicKey: 'SENDCLOUD_PUBLIC_KEY',
      secretKey: 'SENDCLOUD_SECRET_KEY',
    },
  },

  sevdesk: {
    id: 'sevdesk',
    name: 'SevDesk',
    description: 'Online-Buchhaltung und Rechnungen',
    category: 'finance',
    authType: 'api_key',
    logo: 'sevdesk',
    helpUrl: 'https://my.sevdesk.de/#/admin/userManagement',
    helpText: 'Den API-Token findest du in SevDesk unter Einstellungen → Benutzerverwaltung → API-Token.',
    features: ['Kontostände abrufen', 'Rechnungen erstellen', 'Versandkosten-Belege importieren'],
    fields: [
      { key: 'apiToken', label: 'API Token', type: 'password', placeholder: '32-stelliger Hex-Token', required: true, minLength: 10 },
    ],
    secretKeys: ['SEVDESK_API_TOKEN'],
    credentialToSecretMap: {
      apiToken: 'SEVDESK_API_TOKEN',
    },
  },

  dhl: {
    id: 'dhl',
    name: 'DHL',
    description: 'Pakete bis 31,5 kg, DE + International (via SendCloud)',
    category: 'shipping',
    authType: 'none',
    logo: 'dhl',
    helpText: 'DHL wird automatisch über SendCloud angebunden. Verbinde zuerst SendCloud.',
    features: ['Versandlabels erstellen', 'Tracking-Updates'],
    dependsOn: 'sendcloud',
  },
};

/**
 * Get a single provider config by ID.
 * @param {string} providerId
 * @returns {object|null}
 */
function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

/**
 * Get all provider configs.
 * @returns {object[]}
 */
function getAllProviders() {
  return Object.values(PROVIDERS);
}

/**
 * Get providers by category.
 * @param {string} category
 * @returns {object[]}
 */
function getProvidersByCategory(category) {
  return Object.values(PROVIDERS).filter((p) => p.category === category);
}

/**
 * Get providers that support self-service setup (api_key or oauth2).
 * @returns {object[]}
 */
function getConfigurableProviders() {
  return Object.values(PROVIDERS).filter((p) => p.authType === 'oauth2' || p.authType === 'api_key');
}

/**
 * Validate credential fields for an api_key provider.
 * @param {string} providerId
 * @param {object} credentials
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCredentialFields(providerId, credentials) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { valid: false, errors: [`Unknown provider: ${providerId}`] };
  if (provider.authType !== 'api_key') return { valid: false, errors: [`Provider ${providerId} does not use API keys`] };

  const errors = [];
  for (const field of provider.fields) {
    const value = credentials?.[field.key];
    if (field.required && (!value || typeof value !== 'string' || !value.trim())) {
      errors.push(`${field.label} ist erforderlich`);
    } else if (value && field.minLength && value.trim().length < field.minLength) {
      errors.push(`${field.label} muss mindestens ${field.minLength} Zeichen lang sein`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PROVIDERS,
  getProvider,
  getAllProviders,
  getProvidersByCategory,
  getConfigurableProviders,
  validateCredentialFields,
};
