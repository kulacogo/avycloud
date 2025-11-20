const { Firestore } = require('@google-cloud/firestore');
const { firestore } = require('./firestore');

const FieldValue = Firestore.FieldValue;
const PRODUCT_IMAGES_DOC = firestore.collection('trendocean').doc('product_images');
const PRODUCT_IMAGES_COLLECTION = PRODUCT_IMAGES_DOC.collection('images');

async function recordManualProductImage({
  productId,
  publicUrl,
  source = 'upload',
  variant = null,
  notes = null,
}) {
  if (!productId || !publicUrl) {
    console.warn('recordManualProductImage called without productId/publicUrl');
    return;
  }

  try {
    await PRODUCT_IMAGES_DOC.set(
      {
        last_activity: FieldValue.serverTimestamp(),
        last_product_id: productId,
      },
      { merge: true }
    );

    await PRODUCT_IMAGES_COLLECTION.add({
      product_id: productId,
      public_url: publicUrl,
      source,
      variant,
      notes,
      created_at: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Failed to record product image metadata:', error);
  }
}

module.exports = {
  recordManualProductImage,
};

