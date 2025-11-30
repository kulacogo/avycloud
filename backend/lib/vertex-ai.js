const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'europe-west3'; // or us-central1, depending on availability
const API_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com`;

function extractBase64Payload(dataUrl = '') {
  if (!dataUrl) return null;
  const dataUrlMatch = dataUrl.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
  if (dataUrlMatch?.groups?.data) {
    return {
      mimeType: dataUrlMatch.groups.mime || 'image/png',
      data: dataUrlMatch.groups.data,
    };
  }
  // Assume plain base64 when string looks like it (no schema, mostly base64 chars)
  const stripped = dataUrl.trim();
  if (/^[a-z0-9+/]+=*$/i.test(stripped)) {
    return { mimeType: null, data: stripped };
  }
  return null;
}

async function generateProductImages({
  prompt,
  count = 1,
  aspectRatio = '1:1',
  referenceImageBase64 = null,
  maskImageBase64 = null,
  editMode = null,
}) {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  const url = `${API_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`;

  const instance = {
    prompt,
  };

  if (referenceImageBase64) {
    const payload = extractBase64Payload(referenceImageBase64);
    if (!payload) {
      throw new Error('Invalid reference image payload provided');
    }
    instance.image = {
      bytesBase64Encoded: payload.data,
    };
  }

  if (maskImageBase64) {
    const payload = extractBase64Payload(maskImageBase64);
    if (!payload) {
      throw new Error('Invalid mask image payload provided');
    }
    instance.mask = {
      image: {
        bytesBase64Encoded: payload.data,
      },
    };
  }

  const parameters = {
    sampleCount: count,
    aspectRatio,
    responseModalities: ['TEXT', 'IMAGE'],
  };

  if (editMode) {
    parameters.editMode = editMode;
  }

  if (referenceImageBase64 || maskImageBase64) {
    parameters.editConfig = {
      baseSteps: 25,
    };
  }

  const requestBody = {
    instances: [instance],
    parameters,
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
    console.error('Vertex AI response:', JSON.stringify(data, null, 2));
    throw new Error('No predictions returned from Vertex AI');
  }

  console.log('Vertex AI prediction sample keys:', Object.keys(data.predictions[0]));

  return data.predictions.map((prediction) => {
    const bytes =
      prediction.bytesBase64Encoded ||
      prediction.bytesBase64 ||
      prediction.imageBase64 ||
      prediction.image;
    if (!bytes) {
      console.warn('Vertex AI prediction missing base64 payload:', prediction);
    }
    return {
      base64: typeof bytes === 'string' ? bytes : null,
      mimeType: prediction.mimeType || 'image/png',
    };
  });
}

module.exports = {
  generateProductImages,
};
