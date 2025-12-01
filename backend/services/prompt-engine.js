const { generateText } = require('../lib/gemini');

/**
 * Generates detailed visual descriptions for product photography using Gemini.
 * @param {Object} product - The product object
 * @returns {Promise<{studio: string, lifestyle: string, detail: string}>}
 */
async function generateVisualDescriptions(product) {
    const identity = [
        product.identification?.brand,
        product.identification?.name,
        product.identification?.category,
    ].filter(Boolean).join(' ');

    const attributes = product.details?.attributes || {};
    const features = product.details?.key_features || [];

    const context = `
    Product: ${identity}
    Attributes: ${JSON.stringify(attributes)}
    Key Features: ${features.join(', ')}
    Color: ${attributes.Color || attributes.Farbe || 'standard'}
    Material: ${attributes.Material || 'standard'}
  `;

    const prompt = `
    You are a professional product photographer and art director.
    Your task is to write 3 distinct, high-end image generation prompts for the following product:
    
    ${context}

    First, identify the **Core Object Type** (e.g., "Yoga Mat", "Serving Cart", "Bathtub Mat", "Frying Pan").
    
    Write the prompts in English. They should be descriptive, focusing on lighting, texture, composition, and mood.
    **CRITICAL: Every prompt MUST start with "A photo of [Core Object Type]..." to ensure the AI draws the correct object.**
    
    1. **Studio Variation**: A clean, high-end e-commerce shot of the [Core Object Type]. Neutral background (gray/white gradient). Soft studio lighting. Focus on showing the product clearly from a flattering angle (3/4 view). High resolution, 8k, sharp focus.
    2. **Lifestyle Scene**: The [Core Object Type] being ACTIVELY USED in its natural environment. Photorealistic, candid style. The [Core Object Type] must be the CLEAR MAIN SUBJECT in the center. (e.g., if it's a bath mat, show it INSIDE the bathtub or on the floor; if it's a cart, show it holding items). Do NOT just show the room.
    3. **Detail Macro**: An extreme close-up shot of the [Core Object Type] highlighting the material texture, quality, or a specific feature. Macro lens, f/2.8, detailed texture.

    Return ONLY a JSON object with keys: "studio", "lifestyle", "detail". Do not include markdown formatting.
  `;

    try {
        const responseText = await generateText(prompt, { temperature: 0.7 });

        // Clean up potential markdown code blocks
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const prompts = JSON.parse(cleanJson);

        return {
            studio: prompts.studio || `Studio shot of ${identity}, neutral background, soft lighting`,
            lifestyle: prompts.lifestyle || `Lifestyle shot of ${identity} in natural context`,
            detail: prompts.detail || `Close up detail shot of ${identity}`,
        };
    } catch (error) {
        console.error('Prompt generation failed:', error);
        // Fallback to Premium Templates if AI fails
        // These are the same high-quality templates we designed in the planning phase
        return {
            studio: `High-end close-up 3/4 product photo of ${identity}. Studio lighting with softbox overhead and gentle rim light. Matte finish, ultra-sharp edges, extreme high resolution. Elegant minimalist tone: no props, no text, clean negative space, neutral gray gradient background.`,
            lifestyle: `Photorealistic lifestyle product shot of ${identity} being actively used in a natural environment. Balanced composition, shallow depth of field with soft bokeh. Natural daytime lighting, soft directional sunlight. Scene conveys quality, comfort, and everyday utility.`,
            detail: `Extreme macro close-up detail shot of ${identity}. Focus on material texture and quality. Soft lighting to highlight surface details.`,
        };
    }
}

module.exports = {
    generateVisualDescriptions,
};
