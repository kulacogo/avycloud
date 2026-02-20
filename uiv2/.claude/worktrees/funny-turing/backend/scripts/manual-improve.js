
const { improveExistingProduct } = require('../services/improve');
const { Firestore } = require('@google-cloud/firestore');

// Minimal context setup
process.env.GOOGLE_CLOUD_PROJECT = 'avycloud';

async function run() {
    const args = process.argv.slice(2);
    const productId = args[0];

    if (!productId) {
        console.error('Please provide a product ID argument.');
        process.exit(1);
    }

    console.log(`Starting manual improve for ${productId}...`);
    try {
        const result = await improveExistingProduct(productId, (stage) => {
            console.log(`[PROGRESS] ${stage}`);
        });
        console.log('Improve completed successfully!');
        console.log('Result Name:', result.identification?.name);
        console.log('Result Brand:', result.identification?.brand);
    } catch (err) {
        console.error('Improve failed:', err);
        process.exit(1);
    }
}

run();
