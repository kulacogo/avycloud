const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1';
const MODEL = 'imagegeneration@006';

async function testReferenceImages() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    const baseImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; // Red dot

    // Structure based on search results
    const instance = {
        prompt: 'A blue square next to [1]',
        referenceImages: [
            {
                referenceId: 1, // Integer or string? Search said "1"
                image: { bytesBase64Encoded: baseImage }
            }
        ]
    };

    const parameters = { sampleCount: 1 };

    console.log(`Testing ${MODEL} with referenceImages...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ instances: [instance], parameters }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.log(`❌ Failed: ${text}`);
        } else {
            const data = await response.json();
            console.log(`✅ Success! Predictions: ${data.predictions?.length}`);
        }
    } catch (e) {
        console.log(`❌ Error: ${e.message}`);
    }
}

testReferenceImages();
