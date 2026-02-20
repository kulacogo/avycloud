const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });

async function purgeJobs() {
    console.log('Purging pending/processing jobs...');
    const jobsRef = firestore.collection('jobs');
    const snapshot = await jobsRef.where('status', 'in', ['pending', 'processing']).get();

    if (snapshot.empty) {
        console.log('No pending jobs found.');
        return;
    }

    console.log(`Found ${snapshot.size} jobs to purge.`);
    const batch = firestore.batch();
    let count = 0;
    snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        count++;
    });

    await batch.commit();
    console.log(`Successfully purged ${count} jobs.`);
}

purgeJobs().catch(console.error);
