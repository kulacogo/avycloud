'use strict';

const { firestore } = require('./firestore');

const SETTINGS_COLLECTION = 'integration_settings';

/**
 * Load stored defaults for an integration from Firestore.
 * Returns an empty object if no defaults are configured.
 *
 * @param {string} integration - e.g. 'ebay', 'kaufland'
 * @param {{ tenantId?: string }} options
 * @returns {Promise<Record<string, any>>}
 */
async function getIntegrationDefaults(integration, { tenantId = 'default' } = {}) {
  try {
    const docId = `${tenantId}__${integration}`;
    const doc = await firestore.collection(SETTINGS_COLLECTION).doc(docId).get();
    if (!doc.exists) return {};
    return doc.data()?.defaults || {};
  } catch (err) {
    console.warn(`[integration-defaults] Failed to load defaults for ${integration}: ${err.message}`);
    return {};
  }
}

/**
 * Merge overrides with stored defaults for eBay publish.
 * Priority: explicit overrides > Firestore defaults > ENV fallback (handled downstream).
 */
async function mergeEbayOverrides(overrides = {}, { tenantId = 'default' } = {}) {
  const defaults = await getIntegrationDefaults('ebay', { tenantId });
  return {
    ...overrides,
    shippingProfileId: overrides.shippingProfileId || defaults.shippingPolicyId || undefined,
    returnProfileId: overrides.returnProfileId || defaults.returnPolicyId || undefined,
    paymentProfileId: overrides.paymentProfileId || defaults.paymentPolicyId || undefined,
  };
}

/**
 * Merge overrides with stored defaults for Kaufland publish.
 */
async function mergeKauflandOverrides(overrides = {}, { tenantId = 'default' } = {}) {
  const defaults = await getIntegrationDefaults('kaufland', { tenantId });
  return {
    ...overrides,
    shippingGroupId: overrides.shippingGroupId || defaults.shippingGroupId || undefined,
    warehouseId: overrides.warehouseId || defaults.warehouseId || undefined,
  };
}

module.exports = {
  getIntegrationDefaults,
  mergeEbayOverrides,
  mergeKauflandOverrides,
};
