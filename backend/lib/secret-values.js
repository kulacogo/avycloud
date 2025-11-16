const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const cache = new Map();
let client;

function getClient() {
  if (!client) {
    client = new SecretManagerServiceClient();
  }
  return client;
}

async function getSecretValue(secretName) {
  if (!secretName) {
    throw new Error('Secret name is required');
  }

  if (process.env[secretName]) {
    return process.env[secretName];
  }

  if (cache.has(secretName)) {
    return cache.get(secretName);
  }

  try {
    const [version] = await getClient().accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    const value = version.payload.data.toString('utf8').trim();
    cache.set(secretName, value);
    return value;
  } catch (error) {
    console.error(`Failed to load secret ${secretName}:`, error.message);
    return null;
  }
}

module.exports = {
  getSecretValue,
};

