const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');

// Initialize Cloud Storage
const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'
});

// Bucket name
const BUCKET_NAME = process.env.STORAGE_BUCKET || 'avycloud-product-images';

// Get or create bucket
let bucket;

async function initializeBucket() {
  try {
    bucket = storage.bucket(BUCKET_NAME);
    const [exists] = await bucket.exists();
    
    if (!exists) {
      console.log(`Creating bucket ${BUCKET_NAME}...`);
      await storage.createBucket(BUCKET_NAME, {
        location: 'europe-west3', // Lowercase region ID
        storageClass: 'STANDARD'
      });
      
      // Make bucket publicly readable
      await bucket.makePublic();
    }
    
    console.log(`Using Cloud Storage bucket: ${BUCKET_NAME}`);
  } catch (error) {
    console.error('Failed to initialize bucket:', error);
    bucket = storage.bucket(BUCKET_NAME); // Use bucket anyway
  }
}

// Initialize on module load
initializeBucket();

/**
 * Upload an image to Cloud Storage
 */
async function uploadImage(imageBuffer, mimeType, productId, variant = 'main') {
  try {
    if (!bucket) {
      await initializeBucket();
    }
    
    // Generate unique filename
    const hash = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const extension = mimeType.split('/')[1] || 'jpg';
    const filename = `products/${productId}/${variant}_${hash}.${extension}`;
    
    const file = bucket.file(filename);
    
    // Upload the image
    await file.save(imageBuffer, {
      metadata: {
        contentType: mimeType,
        cacheControl: 'public, max-age=31536000', // 1 year cache
      },
      public: true,
      validation: false
    });
    
    // Get public URL
    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    
    console.log(`Image uploaded: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error('Failed to upload image:', error);
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

/**
 * Upload base64 image to Cloud Storage
 */
async function uploadBase64Image(base64Data, productId, variant = 'main') {
  try {
    // Extract MIME type and data
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid base64 image data');
    }
    
    const mimeType = matches[1];
    const imageData = matches[2];
    const imageBuffer = Buffer.from(imageData, 'base64');
    
    return await uploadImage(imageBuffer, mimeType, productId, variant);
  } catch (error) {
    console.error('Failed to upload base64 image:', error);
    throw new Error(`Failed to upload base64 image: ${error.message}`);
  }
}

/**
 * Delete all images for a product
 */
async function deleteProductImages(productId) {
  try {
    if (!bucket) {
      await initializeBucket();
    }
    
    const [files] = await bucket.getFiles({
      prefix: `products/${productId}/`
    });
    
    if (files.length > 0) {
      await Promise.all(files.map(file => file.delete()));
      console.log(`Deleted ${files.length} images for product ${productId}`);
    }
  } catch (error) {
    console.error('Failed to delete product images:', error);
    // Don't throw - this is not critical
  }
}

module.exports = {
  uploadImage,
  uploadBase64Image,
  deleteProductImages
};
