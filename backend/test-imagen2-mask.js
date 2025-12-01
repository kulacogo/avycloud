const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const LOCATION = 'us-central1'; // Imagen 2 is here
const MODEL = 'imagegeneration@006';

async function testImagen2WithMask() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

    // 1x1 pixel red dot (Base Image)
    // iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg== (Red pixel)
    const baseImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    // 1x1 pixel white dot (Mask - Edit Everything)
    // iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/w8AAwAB/2+XuekAAAAASUVORK5CYII= (White pixel)
    const maskImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/w8AAwAB/2+XuekAAAAASUVORK5CYII=';

    const instance = {
        prompt: 'A blue square', // Change red dot to blue square
        image: { bytesBase64Encoded: baseImage },
        mask: {
            image: { bytesBase64Encoded: maskImage } // Mask is required for editing
        }
    };

    const parameters = {
        sampleCount: 1,
        editMode: 'inpainting-v2', // Explicitly request inpainting/editing
        // editConfig: { baseSteps: 25 } // Optional
    };

    console.log(`Testing ${MODEL} in ${LOCATION} with Image + Mask (Img2Img)...`);

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
        if (data.predictions?.[0]?.bytesBase64Encoded) {
            console.log('Image generated successfully.');
        }
    }
}

testImagen2WithMask();
