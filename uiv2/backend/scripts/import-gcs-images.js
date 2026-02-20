/**
 * Holt Bilder aus dem GCS-Bucket prodsandjobs/products/<folder>/*
 * und verlinkt sie in die passenden Produkte (Firestore).
 *
 * Matching-Regeln:
 * - Ordnername = 12-14-stellige Zahl -> als EAN suchen
 * - Ordnername startet mit "SKU-" oder ist 10-stellige Nummer -> als SKU/Dokument-ID
 * - Ordnername exakt als Dokument-ID vorhanden -> nutzt diese
 *
 * Quelle der Bild-URL: https://storage.googleapis.com/prodsandjobs/products/<folder>/<file>
 *
 * Usage:
 *   node backend/scripts/import-gcs-images.js
 */

const { execSync } = require('child_process');
const path = require('path');
const {
  firestore,
  findProductByStrictIdentifier,
  saveProduct,
} = require('../lib/firestore');

const BUCKET = 'prodsandjobs';
const PREFIX = 'products/';

function isNumericEAN(key) {
  return /^\d{12,14}$/.test(key);
}

function isSkuLike(key) {
  return /^sku[-_]?/i.test(key) || /^\d{10}$/.test(key);
}

function buildPublicUrl(folder, filename) {
  return `https://storage.googleapis.com/${BUCKET}/${PREFIX}${folder}/${filename}`;
}

function listFolders() {
  const out = execSync(`gsutil ls gs://${BUCKET}/${PREFIX}`, { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line)
    .map((line) => line.replace(`gs://${BUCKET}/${PREFIX}`, '').replace(/\/$/, ''));
}

function listFilesInFolder(folder) {
  const out = execSync(`gsutil ls gs://${BUCKET}/${PREFIX}${folder}`, { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'))
    .map((line) => path.basename(line));
}

async function findProductForFolder(folder) {
  // 1) numeric EAN
  if (isNumericEAN(folder)) {
    const hit = await findProductByStrictIdentifier({ barcodes: [folder] });
    if (hit) return hit.id;
  }
  // 2) SKU-like
  if (isSkuLike(folder)) {
    const doc = await firestore.collection('products').doc(folder).get();
    if (doc.exists) return doc.id;
    const hit = await findProductByStrictIdentifier({ sku: folder });
    if (hit) return hit.id;
  }
  // 3) docId exact
  const doc = await firestore.collection('products').doc(folder).get();
  if (doc.exists) return doc.id;
  return null;
}

function mergeImages(existing = [], incoming = []) {
  const seen = new Set();
  const out = [];
  const add = (img) => {
    if (!img || !img.url_or_base64) return;
    const key = img.url_or_base64;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(img);
  };
  existing.forEach(add);
  incoming.forEach(add);
  return out.slice(0, 10);
}

async function main() {
  console.log('Listing folders …');
  const folders = await listFolders();
  console.log(`Found ${folders.length} folders`);

  let matched = 0;
  let updated = 0;
  let skipped = 0;

  for (const folder of folders) {
    const productId = await findProductForFolder(folder);
    if (!productId) {
      skipped += 1;
      continue;
    }
    matched += 1;
    const files = await listFilesInFolder(folder);
    if (!files.length) {
      skipped += 1;
      continue;
    }
    const newImages = files.map((fn) => ({
      url_or_base64: buildPublicUrl(folder, fn),
      source: 'gcs',
    }));

    const doc = await firestore.collection('products').doc(productId).get();
    if (!doc.exists) {
      skipped += 1;
      continue;
    }
    const data = doc.data() || {};
    const existing = Array.isArray(data.details?.images) ? data.details.images : [];
    const merged = mergeImages(existing, newImages);
    if (merged.length === existing.length) {
      continue; // nothing new
    }
    await saveProduct({
      ...data,
      id: productId,
      details: {
        ...(data.details || {}),
        images: merged,
      },
    });
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        folders: folders.length,
        matched,
        updated,
        skipped,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
