const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Singleton instance
let secretsClient = null;
let cachedSecrets = null;
let inFlightSecretsPromise = null;

const SECRET_MANAGER_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.SECRET_MANAGER_TIMEOUT_MS || '8000', 10)
);

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timeout = null;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const msg = label ? `Secret Manager timeout (${label})` : 'Secret Manager timeout';
      reject(new Error(msg));
    }, timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

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

  if (inFlightSecretsPromise) {
    return await inFlightSecretsPromise;
  }

  // Allow local/dev overrides without Secret Manager (useful when ADC is not available).
  const envToken = (process.env.BASE_API_TOKEN || '').trim();
  const envInventory = (process.env.BASE_INVENTORY_ID || '').trim();
  if (envToken && envInventory) {
    cachedSecrets = {
      baseApiToken: envToken,
      baseInventoryId: envInventory,
      baseOrderStatusNew: process.env.BASE_ORDER_STATUS_NEW || null,
      baseOrderStatusPicked: process.env.BASE_ORDER_STATUS_PICKED || null,
      baseOrderStatusPacked: process.env.BASE_ORDER_STATUS_PACKED || null,
      baseOrderStatusShipped: process.env.BASE_ORDER_STATUS_SHIPPED || null,
    };
    console.log('Secrets loaded from environment variables (BASE_API_TOKEN / BASE_INVENTORY_ID).');
    return cachedSecrets;
  }

  inFlightSecretsPromise = (async () => {
  try {
    const client = getSecretsClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
    
    // Fetch both secrets in parallel
    const access = (name) =>
      withTimeout(
        client.accessSecretVersion({ name }),
        SECRET_MANAGER_TIMEOUT_MS,
        name
      );
    const [tokenResponse, inventoryResponse] = await Promise.all([
      access(`projects/${projectId}/secrets/BASE_API_TOKEN/versions/latest`),
      access(`projects/${projectId}/secrets/BASE_INVENTORY_ID/versions/latest`),
    ]);
    
    // Extract the payload data
    const baseApiToken = tokenResponse[0].payload.data.toString('utf8');
    const baseInventoryId = inventoryResponse[0].payload.data.toString('utf8');

    let baseOrderStatusNew = process.env.BASE_ORDER_STATUS_NEW || null;
    let baseOrderStatusPicked = process.env.BASE_ORDER_STATUS_PICKED || null;
    let baseOrderStatusPacked = process.env.BASE_ORDER_STATUS_PACKED || null;
    let baseOrderStatusShipped = process.env.BASE_ORDER_STATUS_SHIPPED || null;

    if (!baseOrderStatusNew) {
      try {
        const [statusNewResponse] = await access(
          `projects/${projectId}/secrets/BASE_ORDER_STATUS_NEW/versions/latest`
        );
        baseOrderStatusNew = statusNewResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_NEW not found; falling back to env variable.');
      }
    }

    if (!baseOrderStatusPicked) {
      try {
        const [statusPickedResponse] = await access(
          `projects/${projectId}/secrets/BASE_ORDER_STATUS_PICKED/versions/latest`
        );
        baseOrderStatusPicked = statusPickedResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_PICKED not found; falling back to env variable.');
      }
    }

    if (!baseOrderStatusPacked) {
      try {
        const [statusPackedResponse] = await access(
          `projects/${projectId}/secrets/BASE_ORDER_STATUS_PACKED/versions/latest`
        );
        baseOrderStatusPacked = statusPackedResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_PACKED not found; falling back to env variable.');
      }
    }

    if (!baseOrderStatusShipped) {
      try {
        const [statusShippedResponse] = await access(
          `projects/${projectId}/secrets/BASE_ORDER_STATUS_SHIPPED/versions/latest`
        );
        baseOrderStatusShipped = statusShippedResponse.payload.data.toString('utf8').trim();
      } catch (error) {
        console.warn('Optional secret BASE_ORDER_STATUS_SHIPPED not found; falling back to env variable.');
      }
    }
    
    // Cache the results
    cachedSecrets = {
      baseApiToken,
      baseInventoryId,
      baseOrderStatusNew,
      baseOrderStatusPicked,
      baseOrderStatusPacked,
      baseOrderStatusShipped,
    };

    console.log('Secrets loaded successfully from Secret Manager');
    return cachedSecrets;
  } catch (error) {
    console.error('Failed to load secrets from Secret Manager:', error.message);
    throw new Error('Unable to access required secrets. Please check Secret Manager permissions.');
  } finally {
    inFlightSecretsPromise = null;
  }
  })();

  return await inFlightSecretsPromise;
}

module.exports = {
  getSecrets,
};