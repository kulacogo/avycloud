const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1'; // Try us-central1 for Imagen 2
const MODEL = 'imagegeneration@006';

async function testImagen2WithRef() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    // 1x1 pixel red dot
    const dummyRef = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const base64 = dummyRef.split(',')[1];

    const instance = {
        prompt: 'A red dot on a blue background',
        image: { bytesBase64Encoded: base64 }
    };

    const parameters = {
        sampleCount: 1,
        // No editMode, no editConfig -> Should be Image Prompting (Variation)
    };

    console.log(`Testing ${MODEL} in ${LOCATION} with reference image...`);

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
    }
}

testImagen2WithRef();
