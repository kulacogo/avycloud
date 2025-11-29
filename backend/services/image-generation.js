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

    // Construct a rich prompt based on product details
    const basePrompt = `Professional product photography of ${brand} ${name} (${category}). ${description.slice(0, 200)}. High resolution, photorealistic, 4k.`;

    const studioPrompt = `${basePrompt} Studio lighting, white background, clean composition, commercial product shot.`;
    const lifestylePrompt = `${basePrompt} In-use lifestyle setting, realistic environment, natural lighting, showing the product in context.`;

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
