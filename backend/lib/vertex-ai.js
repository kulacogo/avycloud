const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'europe-west3'; // or us-central1, depending on availability
const API_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com`;

async function generateProductImages({ prompt, count = 1, aspectRatio = '1:1' }) {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  const url = `${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`;

  const requestBody = {
    instances: [
      {
        prompt: prompt,
      },
    ],
    parameters: {
      sampleCount: count,
      aspectRatio: aspectRatio,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI API failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  // Response structure for Imagen 2/3 usually contains predictions array with bytesBase64
  if (!data.predictions || !data.predictions.length) {
    throw new Error('No predictions returned from Vertex AI');
  }

  return data.predictions.map(pred => pred.bytesBase64);
}

module.exports = {
  generateProductImages,
};
