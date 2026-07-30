#!/usr/bin/env node
/**
 * Ruft die Original-Bilder für ein Produkt nach SKU ab und zeigt sie an.
 *
 * Verwendung:
 * cd /Users/oguz/Dev/avycloud/backend
 * node /private/tmp/claude-501/-Users-oguz-Dev-avycloud/3cab5877-406e-4bc1-a3ca-e12178b71f11/scratchpad/download-product-images.js SKU-5453828591
 */

const admin = require('firebase-admin');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'avycloud-prod',
  });
}

async function downloadImage(url, filePath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Redirect handling
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadImage(res.headers.location, filePath).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function getProductImages(sku) {
  const db = admin.firestore();

  console.log(`\n📦 Hole Original-Bilder für SKU: ${sku}\n`);

  try {
    // Query by SKU
    const query = db.collection('products_v2')
      .where('tenantId', '==', 'default')
      .where('sku', '==', sku);

    const snapshot = await query.get();

    if (snapshot.empty) {
      console.log('❌ Produkt nicht gefunden');
      return;
    }

    const doc = snapshot.docs[0];
    const product = doc.data();

    console.log('✅ Produkt gefunden:');
    console.log(`   ID: ${doc.id}`);
    console.log(`   Name: ${product.name}`);
    console.log(`   EAN: ${product.identifiers?.ean || 'keine'}`);

    const images = product.details?.images || [];

    if (!images.length) {
      console.log('\n❌ Keine Bilder gefunden');
      return;
    }

    console.log(`\n📸 ${images.length} Bilder gefunden:\n`);

    // Create output directory
    const outputDir = `/private/tmp/claude-501/-Users-oguz-Dev-avycloud/3cab5877-406e-4bc1-a3ca-e12178b71f11/scratchpad/${sku}-images`;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Download images
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const url = img.url || img.url_or_base64;

      console.log(`\n${i + 1}. Bild`);
      console.log(`   URL: ${url?.substring(0, 100)}${url && url.length > 100 ? '...' : ''}`);
      console.log(`   Source: ${img.source || 'unbekannt'}`);
      console.log(`   Size: ${img.width || '?'} × ${img.height || '?'}`);

      // Handle base64 images
      if (url && url.startsWith('data:')) {
        const base64Data = url.split(',')[1];
        const ext = url.match(/data:image\/(\w+)/)?.[1] || 'jpg';
        const filePath = path.join(outputDir, `bild-${i + 1}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        console.log(`   ✅ Gespeichert: ${filePath}`);
      } else if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        // Download from URL
        const ext = url.split('.').pop().split('?')[0] || 'jpg';
        const filePath = path.join(outputDir, `bild-${i + 1}.${ext}`);

        try {
          await downloadImage(url, filePath);
          console.log(`   ✅ Heruntergeladen: ${filePath}`);
        } catch (err) {
          console.log(`   ⚠️  Download-Fehler: ${err.message}`);
        }
      } else {
        console.log(`   ⚠️  Ungültige URL`);
      }
    }

    console.log(`\n✅ Alle Bilder gespeichert in: ${outputDir}\n`);

  } catch (err) {
    console.error('❌ Fehler:', err.message);
  }

  process.exit(0);
}

// Run
const sku = process.argv[2];
if (!sku) {
  console.log('Verwendung: node download-product-images.js SKU-XXXX');
  process.exit(1);
}

getProductImages(sku).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
