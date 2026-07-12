const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');
const sharp = require('sharp');

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const PREFERRED_BUCKET = 'prodsandjobs';
const normalizeBucketName = (raw) => {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return '';
  return s.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
};

const BUCKET_NAME = normalizeBucketName(process.env.STORAGE_BUCKET) || PREFERRED_BUCKET;
const MIN_IMAGE_LONGEST_EDGE = parseInt(process.env.MIN_IMAGE_LONGEST_EDGE || '1200', 10);
const MAX_IMAGE_LONGEST_EDGE = parseInt(process.env.MAX_IMAGE_LONGEST_EDGE || '2000', 10);
let bucket;
let initPromise = null;

async function ensurePublicBucketReadAccess(b) {
  // We *try* to ensure public read access because the app returns public GCS URLs.
  // This is best-effort: org policies like "Public access prevention" can block it.
  try {
    await b.makePublic();
    console.log(`Bucket ${BUCKET_NAME} is now public (makePublic).`);
    return { ok: true, method: 'makePublic' };
  } catch (aclError) {
    // Uniform bucket-level access disables ACLs and can make makePublic fail with 400.
    console.warn(
      `Warning: Could not make bucket ${BUCKET_NAME} public via ACL (might be enforced by IAM/uniform access):`,
      aclError?.message || aclError
    );
  }

  // Fallback: Use IAM policy binding (docs recommend adding allUsers -> roles/storage.objectViewer).
  // IMPORTANT: Always read the current policy first to avoid overwriting existing bindings.
  try {
    const [policy] = await b.iam.getPolicy({ requestedPolicyVersion: 3 });
    const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
    const roleName = 'roles/storage.objectViewer';
    const member = 'allUsers';

    let binding = bindings.find((x) => x && x.role === roleName && !x.condition);
    if (!binding) {
      binding = { role: roleName, members: [member] };
      bindings.push(binding);
    } else {
      binding.members = Array.isArray(binding.members) ? binding.members : [];
      if (!binding.members.includes(member)) {
        binding.members.push(member);
      }
    }

    policy.bindings = bindings;
    await b.iam.setPolicy(policy);
    console.log(`Bucket ${BUCKET_NAME} is now public (IAM roles/storage.objectViewer -> allUsers).`);
    return { ok: true, method: 'iamPolicy' };
  } catch (iamError) {
    console.warn(`Warning: Could not set IAM public read policy for ${BUCKET_NAME}:`, iamError?.message || iamError);
    return { ok: false, method: 'iamPolicy', error: iamError?.message || String(iamError) };
  }
}

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
    }

    // Best-effort: ensure objects are reachable via public URL.
    await ensurePublicBucketReadAccess(bucket);

    console.log(`Using Cloud Storage bucket: ${BUCKET_NAME}`);
  } catch (error) {
    console.error('Failed to initialize bucket:', error);
    // Keep a bucket reference so callers can still attempt operations; failures will surface at call sites.
    bucket = storage.bucket(BUCKET_NAME);
  }
}

async function ensureBucket() {
  if (initPromise) {
    await initPromise;
    return;
  }
  if (bucket) return;
  initPromise = initializeBucket().finally(() => {
    initPromise = null;
  });
  await initPromise;
}

// Fire-and-forget init to surface misconfig early; calls are still guarded by ensureBucket().
ensureBucket().catch(() => {});

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

async function saveBufferToBucket(imageBuffer, mimeType, targetPath) {
  await ensureBucket();
  const normalized = await normalizeImageBuffer(imageBuffer, mimeType);
  const hash = crypto.createHash('md5').update(normalized.buffer).digest('hex');
  const extension = normalized.mimeType?.split('/')?.[1] || mimeType?.split('/')?.[1] || 'jpg';
  const filename = `${targetPath}_${hash}.${extension}`;
  const file = bucket.file(filename);

  await file.save(normalized.buffer, {
    metadata: {
      contentType: normalized.mimeType || mimeType,
      cacheControl: 'public, max-age=31536000',
    },
    // With uniform bucket-level access enabled we can't rely on per-object ACLs.
    // Public readability is controlled via IAM on the bucket itself.
    public: false,
    validation: false,
  });

  const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
  return {
    url: publicUrl,
    width: normalized.width,
    height: normalized.height,
    mimeType: normalized.mimeType || mimeType,
  };
}

async function uploadImage(imageBuffer, mimeType, productId, variant = 'main') {
  const targetPath = `products/${productId}/${variant}`;
  const result = await saveBufferToBucket(imageBuffer, mimeType, targetPath);
  console.log(`Image uploaded: ${result.url}`);
  return result;
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

/**
 * Upload a company/tenant logo from a base64 data URL. Tenant-scoped path so
 * every tenant keeps its own logo. Returns { url, width, height, mimeType }.
 * @param {string} base64Data - data:<mime>;base64,<...>
 * @param {string} tenantId
 */
async function uploadLogoImage(base64Data, tenantId) {
  const matches = String(base64Data || '').match(/^data:([A-Za-z-+/.]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error('Invalid base64 image data');
  }
  const mimeType = matches[1];
  const imageBuffer = Buffer.from(matches[2], 'base64');
  return saveBufferToBucket(imageBuffer, mimeType, `company/${tenantId || 'default'}/logo`);
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

// Dokument-Uploads (SDS-PDFs etc.) duerfen NICHT durch die sharp-Bild-
// Normalisierung laufen — deshalb eigene Extension-Map statt mime.split('/').
const DOCUMENT_EXTENSION_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function documentExtensionFromMime(mimeType) {
  const mt = typeof mimeType === 'string' ? mimeType.toLowerCase().trim() : '';
  if (DOCUMENT_EXTENSION_BY_MIME[mt]) return DOCUMENT_EXTENSION_BY_MIME[mt];
  const sub = mt.includes('/') ? mt.split('/')[1] : '';
  const cleaned = sub.replace(/[^a-z0-9]/g, '');
  return cleaned || 'bin';
}

/**
 * Upload eines Dokument-Buffers (z.B. Sicherheitsdatenblatt-PDF) zu einem
 * Produkt. Wie uploadImage, aber OHNE sharp-Normalisierung — der Buffer wird
 * byte-identisch gespeichert (PDFs wuerden sharp brechen bzw. verfaelscht).
 *
 * Pfad: products/${productId}/${name}_${md5hash}.${ext}
 *
 * @param {Buffer} buffer
 * @param {string} mimeType — z.B. 'application/pdf'
 * @param {string} productId
 * @param {string} name — logischer Dateiname (wird sanitized)
 * @returns {Promise<{ url: string, mimeType: string, size: number }>}
 */
async function uploadDocumentBuffer(buffer, mimeType, productId, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('uploadDocumentBuffer requires a non-empty Buffer');
  }
  if (!productId) {
    throw new Error('uploadDocumentBuffer requires a productId');
  }
  await ensureBucket();

  const contentType = mimeType || 'application/octet-stream';
  const safeName = sanitizeFilename(name || 'document') || 'document';
  const hash = crypto.createHash('md5').update(buffer).digest('hex');
  const extension = documentExtensionFromMime(contentType);
  const filename = `products/${productId}/${safeName}_${hash}.${extension}`;
  const file = bucket.file(filename);

  await file.save(buffer, {
    metadata: {
      contentType,
      cacheControl: 'public, max-age=31536000',
    },
    // Uniform bucket-level access: Public-Read via Bucket-IAM, nicht per Objekt-ACL.
    public: false,
    validation: false,
  });

  const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
  console.log(`Document uploaded: ${publicUrl}`);
  return {
    url: publicUrl,
    mimeType: contentType,
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
  uploadLogoImage,
  deleteProductImages,
  uploadJobFile,
  uploadDocumentBuffer,
  downloadFile,
};
