const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');
const sharp = require('sharp');

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const BUCKET_NAME = process.env.STORAGE_BUCKET || 'avycloud-product-images';
const MIN_IMAGE_LONGEST_EDGE = parseInt(process.env.MIN_IMAGE_LONGEST_EDGE || '1200', 10);
const MAX_IMAGE_LONGEST_EDGE = parseInt(process.env.MAX_IMAGE_LONGEST_EDGE || '2000', 10);
let bucket;

async function initializeBucket() {
  try {
    bucket = storage.bucket(BUCKET_NAME);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log(`Creating bucket ${BUCKET_NAME}...`);
      await storage.createBucket(BUCKET_NAME, {
        location: 'europe-west3',
        storageClass: 'STANDARD',
      });
      await bucket.makePublic();
    }
    console.log(`Using Cloud Storage bucket: ${BUCKET_NAME}`);
  } catch (error) {
    console.error('Failed to initialize bucket:', error);
    bucket = storage.bucket(BUCKET_NAME);
  }
}

async function ensureBucket() {
  if (!bucket) {
    await initializeBucket();
  }
}

initializeBucket();

async function normalizeImageBuffer(buffer, mimeType) {
  try {
    const minEdge = Number.isFinite(MIN_IMAGE_LONGEST_EDGE) ? MIN_IMAGE_LONGEST_EDGE : 1200;
    const maxEdge = Number.isFinite(MAX_IMAGE_LONGEST_EDGE) ? MAX_IMAGE_LONGEST_EDGE : 2000;
    let pipeline = sharp(buffer).rotate();
    const metadata = await pipeline.metadata();
    const { width = 0, height = 0, format } = metadata;
    const longest = Math.max(width, height);
    let resized = pipeline;

    if (longest && (longest < minEdge || longest > maxEdge)) {
      const target = longest < minEdge ? minEdge : maxEdge;
      if (width >= height) {
        resized = resized.resize({ width: target, fit: 'inside', withoutEnlargement: false });
      } else {
        resized = resized.resize({ height: target, fit: 'inside', withoutEnlargement: false });
      }
    }

    const produceResult = async (fn, targetMime) => {
      const processed = await fn;
      const meta = await sharp(processed).metadata();
      return {
        buffer: processed,
        width: meta.width || width,
        height: meta.height || height,
        mimeType: targetMime,
      };
    };

    if (format === 'png') {
      return produceResult(resized.png({ compressionLevel: 9 }).toBuffer(), 'image/png');
    }
    if (format === 'webp') {
      return produceResult(resized.webp({ quality: 92 }).toBuffer(), 'image/webp');
    }

    return produceResult(resized.jpeg({ quality: 92 }).toBuffer(), 'image/jpeg');
  } catch (error) {
    console.warn('Image normalization failed, using original buffer:', error.message);
    return { buffer, width: null, height: null, mimeType };
  }
}

async function uploadImage(imageBuffer, mimeType, productId, variant = 'main') {
  await ensureBucket();

  const normalized = await normalizeImageBuffer(imageBuffer, mimeType);
  const hash = crypto.createHash('md5').update(normalized.buffer).digest('hex');
  const extension = normalized.mimeType?.split('/')?.[1] || mimeType?.split('/')?.[1] || 'jpg';
  const filename = `products/${productId}/${variant}_${hash}.${extension}`;
  const file = bucket.file(filename);

  await file.save(normalized.buffer, {
    metadata: {
      contentType: normalized.mimeType || mimeType,
      cacheControl: 'public, max-age=31536000',
    },
    public: true,
    validation: false,
  });

  const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
  console.log(`Image uploaded: ${publicUrl}`);
  return {
    url: publicUrl,
    width: normalized.width,
    height: normalized.height,
    mimeType: normalized.mimeType || mimeType,
  };
}

async function uploadBase64Image(base64Data, productId, variant = 'main') {
  const matches = base64Data.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error('Invalid base64 image data');
  }

  const mimeType = matches[1];
  const imageBuffer = Buffer.from(matches[2], 'base64');
  return uploadImage(imageBuffer, mimeType, productId, variant);
}

async function deleteProductImages(productId) {
  try {
    await ensureBucket();
    const [files] = await bucket.getFiles({ prefix: `products/${productId}/` });
    if (files.length > 0) {
      await Promise.all(files.map((file) => file.delete()));
      console.log(`Deleted ${files.length} images for product ${productId}`);
    }
  } catch (error) {
    console.error('Failed to delete product images:', error);
  }
}

function sanitizeFilename(name = '') {
  return name.toString().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

async function uploadJobFile(buffer, mimeType, jobId, originalName = 'upload.bin') {
  await ensureBucket();

  const extensionFromMime =
    typeof mimeType === 'string' && mimeType.includes('/') ? mimeType.split('/')[1] : null;
  const extension =
    extensionFromMime ||
    (originalName && originalName.includes('.') ? originalName.split('.').pop() : 'bin');

  const filename = `jobs/${jobId}/${Date.now()}_${crypto
    .randomUUID()
    .slice(0, 8)}_${sanitizeFilename(originalName)}.${extension}`;

  const file = bucket.file(filename);
  await file.save(buffer, {
    metadata: {
      contentType: mimeType || 'application/octet-stream',
      cacheControl: 'private, max-age=0',
    },
    public: false,
    validation: false,
  });

  return {
    path: filename,
    mimeType: mimeType || 'application/octet-stream',
    originalName,
    size: buffer.length,
  };
}

async function downloadFile(filePath) {
  await ensureBucket();
  const file = bucket.file(filePath);
  const [data] = await file.download();
  const [metadata] = await file.getMetadata();

  return {
    buffer: data,
    contentType: metadata.contentType || 'application/octet-stream',
    size: data.length,
    metadata,
  };
}

module.exports = {
  uploadImage,
  uploadBase64Image,
  deleteProductImages,
  uploadJobFile,
  downloadFile,
};
