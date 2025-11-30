const { generateProductImages } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');

async function generateImagesForProduct(product) {
    if (!product || !product.id) {
        throw new Error('Product ID is required');
    }

    const brand = product.identification?.brand || '';
    const name = product.identification?.name || 'Product';
    const category = product.identification?.category || '';
    const description = product.details?.short_description || '';

    const keyFeatures = (product.details?.key_features || []).join(', ');
    const attributes = Object.entries(product.details?.attributes || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');

    // Construct a rich prompt based on product details
    let basePrompt = `Professional product photography of ${brand} ${name}. `;
    if (category) basePrompt += `Category: ${category}. `;
    if (keyFeatures) basePrompt += `Features: ${keyFeatures}. `;
    if (attributes) basePrompt += `Specs: ${attributes}. `;
    if (description) basePrompt += `Description: ${description.slice(0, 300)}. `;

    basePrompt += `High resolution, photorealistic, 8k, highly detailed, sharp focus.`;

    const studioPrompt = `${basePrompt} Studio lighting, pure white background, centered, clean composition, commercial product shot, no text, no watermarks.`;
    const lifestylePrompt = `${basePrompt} In-use industrial setting, warehouse ceiling, realistic environment, cinematic lighting, showing the product installed and working.`;

    const results = [];

    try {
        // Generate 3 Studio Images
        console.log(`Generating studio images for ${product.id}...`);
        const studioImages = await generateProductImages({
            prompt: studioPrompt,
            count: 3,
            aspectRatio: '1:1',
        });

        for (const [index, base64] of studioImages.entries()) {
            const upload = await uploadBase64Image(
                `data:image/png;base64,${base64}`,
                product.id,
                `gen_studio_${Date.now()}_${index}`
            );
            results.push({
                url_or_base64: upload.url,
                source: 'ai-generated',
                variant: 'studio',
                notes: 'AI generated studio shot',
            });
        }

        // Generate 3 Lifestyle Images
        console.log(`Generating lifestyle images for ${product.id}...`);
        const lifestyleImages = await generateProductImages({
            prompt: lifestylePrompt,
            count: 3,
            aspectRatio: '1:1',
        });

        for (const [index, base64] of lifestyleImages.entries()) {
            const upload = await uploadBase64Image(
                `data:image/png;base64,${base64}`,
                product.id,
                `gen_lifestyle_${Date.now()}_${index}`
            );
            results.push({
                url_or_base64: upload.url,
                source: 'ai-generated',
                variant: 'lifestyle',
                notes: 'AI generated lifestyle shot',
            });
        }

    } catch (error) {
        console.error('Error generating images:', error);
        throw error;
    }

    return results;
}

module.exports = {
    generateImagesForProduct,
};
