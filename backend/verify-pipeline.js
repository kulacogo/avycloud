const { generateVisualDescriptions } = require('./services/prompt-engine');
const { generateImagesForProduct } = require('./services/image-generation');

async function verifyPipeline() {
    console.log('--- Verifying Prompt Engine ---');
    const mockProduct = {
        id: 'test-product-123',
        identification: {
            brand: 'Lululemon',
            name: 'The (Big) Mat 5mm',
            category: 'Yoga Mat',
        },
        details: {
            attributes: {
                Color: 'Purple/Blue Swirl',
                Material: 'Natural Rubber',
            },
            key_features: ['Extra large', 'Non-slip', 'Cushioned'],
        },
    };

    try {
        const prompts = await generateVisualDescriptions(mockProduct);
        console.log('✅ Prompts generated:');
        console.log('Studio:', prompts.studio);
        console.log('Lifestyle:', prompts.lifestyle);
        console.log('Detail:', prompts.detail);

        if (!prompts.studio.includes('Lululemon')) {
            console.warn('⚠️ Warning: Brand name missing from studio prompt');
        }
    } catch (error) {
        console.error('❌ Prompt Engine Failed:', error);
    }

    console.log('\n--- Verifying Image Generation Logic (Dry Run) ---');
    // We can't easily dry-run the actual API call without mocking, 
    // but we can check if the function throws validation errors.

    try {
        // This will fail because we don't have a real reference image URL that fetchImageAsDataUrl can download
        // But we want to see if it gets to that point.
        await generateImagesForProduct(mockProduct, {
            referenceImage: { url_or_base64: 'invalid-url' },
            mode: 'studio'
        });
    } catch (error) {
        if (error.message.includes('Invalid URL') || error.message.includes('fetch')) {
            console.log('✅ Image Generation Logic reached fetch stage (expected failure for invalid URL)');
        } else {
            console.log('ℹ️ Image Generation Error:', error.message);
        }
    }
}

verifyPipeline();
