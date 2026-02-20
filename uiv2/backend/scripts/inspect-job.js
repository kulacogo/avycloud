
const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });

async function checkJob(jobId) {
    console.log(`Checking job ${jobId}...`);
    const doc = await firestore.collection('improveJobs').doc(jobId).get();
    if (!doc.exists) {
        console.log('Job not found');
        return;
    }
    const data = doc.data();
    console.log('Status:', data.status);
    console.log('Stage:', data.stage);
    console.log('Error:', data.error);
    console.log('Result keys:', data.result ? Object.keys(data.result) : 'null');
    if (data.result && data.result.product) {
        console.log('Product Name:', data.result.product.identification?.name);
    }
}

const jobId = process.argv[2];
if (jobId) {
    checkJob(jobId).catch(console.error);
} else {
    console.log('Provide job ID');
}
