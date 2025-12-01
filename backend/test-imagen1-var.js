const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1';
const MODEL = 'imagegeneration@002'; // Legacy model

async function testImagen1Variation() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    // Red dot image
    const dummyRef = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const base64 = dummyRef.split(',')[1];

    const instance = {
        prompt: 'A blue square', // Try to change red dot to blue square
        image: { bytesBase64Encoded: base64 }
    };

    const parameters = {
        sampleCount: 1,
        // No editMode
    };

    console.log(`Testing ${MODEL} in ${LOCATION} with Image + No EditMode...`);

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
        console.error('❌ Failed:', text);
    } else {
        const data = await response.json();
        console.log('✅ Success! Predictions:', data.predictions?.length);
        // In a real scenario we'd check if the image looks like the reference or the prompt
    }
}

testImagen1Variation();
