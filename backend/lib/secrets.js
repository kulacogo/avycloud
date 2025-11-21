const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Singleton instance
let secretsClient = null;
let cachedSecrets = null;

/**
 * Initialize the Secret Manager client (lazy initialization)
 */
function getSecretsClient() {
  if (!secretsClient) {
    secretsClient = new SecretManagerServiceClient();
  }
  return secretsClient;
}

/**
 * Fetch secrets from Google Cloud Secret Manager
 * Caches the results in memory for the lifetime of the process
 * 
 * @returns {Promise<{baseApiToken: string, baseInventoryId: string}>}
 */
async function getSecrets() {
  // Return cached secrets if available
  if (cachedSecrets) {
    return cachedSecrets;
  }

  try {
    const client = getSecretsClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
    
    // Fetch both secrets in parallel
    const [tokenResponse, inventoryResponse] = await Promise.all([
      client.accessSecretVersion({
        name: `projects/${projectId}/secrets/BASE_API_TOKEN/versions/latest`,
      }),
      client.accessSecretVersion({
        name: `projects/${projectId}/secrets/BASE_INVENTORY_ID/versions/latest`,
      }),
    ]);
    
    // Extract the payload data
    const baseApiToken = tokenResponse[0].payload.data.toString('utf8');
    const baseInventoryId = inventoryResponse[0].payload.data.toString('utf8');

    let baseOrderStatusNew = process.env.BASE_ORDER_STATUS_NEW || null;
    let baseOrderStatusPicked = process.env.BASE_ORDER_STATUS_PICKED || null;

    if (!baseOrderStatusNew) {
      try {
        const [statusNewResponse] = await client.accessSecretVersion({
          name: `projects/${projectId}/secrets/BASE_ORDER_STATUS_NEW/versions/latest`,
        });
        baseOrderStatusNew = statusNewResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_NEW not found; falling back to env variable.');
      }
    }

    if (!baseOrderStatusPicked) {
      try {
        const [statusPickedResponse] = await client.accessSecretVersion({
          name: `projects/${projectId}/secrets/BASE_ORDER_STATUS_PICKED/versions/latest`,
        });
        baseOrderStatusPicked = statusPickedResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_PICKED not found; falling back to env variable.');
      }
    }
    
    // Cache the results
    cachedSecrets = {
      baseApiToken,
      baseInventoryId,
      baseOrderStatusNew,
      baseOrderStatusPicked,
    };

    console.log('Secrets loaded successfully from Secret Manager');
    return cachedSecrets;
  } catch (error) {
    console.error('Failed to load secrets from Secret Manager:', error.message);
    throw new Error('Unable to access required secrets. Please check Secret Manager permissions.');
  }
}

module.exports = {
  getSecrets,
};