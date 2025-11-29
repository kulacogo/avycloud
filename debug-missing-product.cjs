const admin = require('firebase-admin');
const { Firestore } = require('@google-cloud/firestore');

// Initialize without credentials if using ADC, or set GOOGLE_APPLICATION_CREDENTIALS
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

async function checkMissingProduct() {
  const barcode = '4002541666529';
  console.log(`Searching for job with barcode: ${barcode}`);

  // Query identification-jobs
  const jobsRef = firestore.collection('identification-jobs');
  // We can't easily query deep inside the result object without a composite index or knowing the exact path,
  // but we can check the last few jobs or query by status 'done'.
  // Let's just grab the last 20 done jobs and filter in memory.
  const snapshot = await jobsRef
    .where('status', '==', 'done')
    .orderBy('finishedAt', 'desc')
    .limit(50)
    .get();

  if (snapshot.empty) {
    console.log('No recent done jobs found.');
    return;
  }

  let foundJob = null;
  let foundProductInJob = null;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const products = data.result?.products || [];
    
    // Check input barcodes
    if (data.payload?.barcodes && data.payload.barcodes.includes(barcode)) {
       foundJob = doc;
    }

    // Check result products
    const match = products.find(p => {
        const barcodes = p.identification?.barcodes || [];
        const ean = p.details?.identifiers?.ean;
        return barcodes.includes(barcode) || ean === barcode;
    });

    if (match) {
      foundJob = doc;
      foundProductInJob = match;
      break;
    }
  }

  if (!foundJob) {
    console.log('Job not found in the last 50 entries.');
    return;
  }

  console.log(`Found Job ID: ${foundJob.id}`);
  console.log('Product data from job result:', JSON.stringify(foundProductInJob, null, 2));

  if (!foundProductInJob) {
    console.log('Job found but no matching product in result??');
    return;
  }

  const productId = foundProductInJob.id;
  console.log(`Checking if product exists in 'products' collection with ID: ${productId}`);

  const productRef = firestore.collection('products').doc(productId);
  const productSnap = await productRef.get();

  if (productSnap.exists) {
    console.log('Product EXISTS in Firestore.');
  } else {
    console.log('Product DOES NOT EXIST in Firestore.');
    
    // Try to save it manually to see if it errors
    console.log('Attempting to save product manually...');
    try {
        // We need to import saveProduct logic or just use raw firestore
        // Let's use raw firestore to mimic saveProduct roughly or just see if there is a write error
        await productRef.set(foundProductInJob);
        console.log('Manual save SUCCESS.');
    } catch (err) {
        console.error('Manual save FAILED:', err);
    }
  }
}

checkMissingProduct().catch(console.error);

