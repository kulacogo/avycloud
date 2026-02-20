const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1';
const MODEL = 'imagegeneration@006';

async function testImagen2WithConditioning() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    const dummyRef = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const base64 = dummyRef.split(',')[1];

    // Try using 'image' as a separate input, not inside instance? No, API spec says instance.
    // Maybe the field is different for Image Prompting?
    // Some docs say 'imageSource' or similar?
    // Actually, for Imagen 2, Image Prompting might require 'editConfig' with specific mode?
    // Or maybe we need to use 'imagegeneration@005'?

    // Let's try to simulate "Subject Control" if available?

    // Let's try sending it as a "mask" but full white? No.

    // Let's try just changing the error message interpretation.
    // "Failed to get mask image bytes" -> It thinks we are editing.
    // How do we tell it we are NOT editing, but Prompting?
    // Maybe 'editMode' should be explicitly undefined? It is.

    // Let's try adding 'mode': 'image_variation' to parameters? (Guess)

    const instance = {
        prompt: 'A red dot on a blue background',
        image: { bytesBase64Encoded: base64 }
    };

    const parameters = {
        sampleCount: 1,
        // Try explicit mode?
        // mode: 'upscale'? No.
    };

    console.log(`Testing ${MODEL} in ${LOCATION}...`);

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

testImagen2WithConditioning();
