const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1';
const MODEL = 'imagegeneration@006';

async function testConfig(name, instanceData, paramsData) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    console.log(`\n--- Testing ${name} ---`);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ instances: [instanceData], parameters: paramsData }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.log(`❌ Failed: ${text.substring(0, 200)}...`); // Truncate
        } else {
            const data = await response.json();
            console.log(`✅ Success! Predictions: ${data.predictions?.length}`);
        }
    } catch (e) {
        console.log(`❌ Error: ${e.message}`);
    }
}

async function runTests() {
    const baseImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; // Red dot

    // Test 1: editMode: 'product-image' (No mask)
    await testConfig('Product Image Mode (No Mask)',
        { prompt: 'blue square', image: { bytesBase64Encoded: baseImage } },
        { sampleCount: 1, editMode: 'product-image' }
    );

    // Test 2: editMode: 'background-swap' (No mask)
    await testConfig('Background Swap Mode (No Mask)',
        { prompt: 'blue square', image: { bytesBase64Encoded: baseImage } },
        { sampleCount: 1, editMode: 'background-swap' }
    );

    // Test 3: Subject Reference (Guessing syntax)
    await testConfig('Subject Reference (Instance Field)',
        { prompt: 'blue square', subject: { image: { bytesBase64Encoded: baseImage } } },
        { sampleCount: 1 }
    );
}

runTests();
