const { getProduct, saveProduct } = require('../lib/firestore');
const { runProductIdentification } = require('./enrichment');

const MAX_REFERENCE_IMAGES = parseInt(process.env.IMPROVE_REFERENCE_IMAGES || '4', 10);

function collectBarcodes(product) {
  const codes = new Set(
    Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : []
  );
  const identifiers = product?.details?.identifiers || {};
  ['ean', 'gtin', 'upc'].forEach((key) => {
    if (identifiers[key]) {
      codes.add(String(identifiers[key]));
    }
  });
  return Array.from(codes).filter(Boolean).join(', ');
}

function buildImproveContext(product) {
  const lines = [];
  lines.push(`Aktueller Titel: ${product?.identification?.name || 'unbekannt'}`);
  lines.push(`Marke: ${product?.identification?.brand || 'unbekannt'}`);
  lines.push(`Kategorie: ${product?.identification?.category || 'unbekannt'}`);
  if (product?.details?.short_description) {
    lines.push(`Beschreibung:\n${product.details.short_description}`);
  }
  if (Array.isArray(product?.details?.key_features) && product.details.key_features.length) {
    lines.push(`Highlights:\n- ${product.details.key_features.join('\n- ')}`);
  }
  const attributes = product?.details?.attributes;
  if (attributes) {
    if (Array.isArray(attributes)) {
      lines.push(
        `Attribute:\n${attributes
          .map((entry) => `• ${entry?.key}: ${entry?.value}`)
          .filter(Boolean)
          .join('\n')}`
      );
    } else {
      lines.push(
        `Attribute:\n${Object.entries(attributes)
          .map(([key, value]) => `• ${key}: ${value}`)
          .join('\n')}`
      );
    }
  }
  const price = product?.details?.pricing?.lowest_price;
  if (price?.amount) {
    lines.push(`Aktueller Preis: ${price.amount} ${price.currency || 'EUR'}`);
  }
  return lines.join('\n');
}

async function downloadImageBuffer(url, index) {
  if (!url || typeof url !== 'string') return null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      fieldname: 'images',
      originalname: `improve_${index}`,
      encoding: '7bit',
      mimetype: mimeType,
      size: buffer.length,
      buffer,
    };
  } catch (error) {
    console.warn(`Failed to download reference image ${url}:`, error.message);
    return null;
  }
}

async function buildReferenceFiles(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const candidates = images
    .filter((img) => typeof img?.url_or_base64 === 'string' && img.url_or_base64.startsWith('http'))
    .slice(0, MAX_REFERENCE_IMAGES);

  const files = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const file = await downloadImageBuffer(candidates[i].url_or_base64, i);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

async function improveExistingProduct(productId) {
  const product = await getProduct(productId);
  if (!product) {
    const error = new Error('Produkt wurde nicht gefunden.');
    error.code = 404;
    throw error;
  }

  const files = await buildReferenceFiles(product);
  const barcodes = collectBarcodes(product);

  const result = await runProductIdentification({
    files,
    barcodes,
    locale: product.locale || 'de-DE',
    modelOverride: null,
    improveContext: buildImproveContext(product),
  });

  const improved = result?.bundle?.products?.[0];
  if (!improved) {
    throw new Error('Improve-Fluss hat kein Produkt zurückgegeben.');
  }

  improved.id = product.id;
  improved.inventory = product.inventory || improved.inventory || null;
  improved.storage = product.storage || improved.storage || null;
  improved.ops = {
    ...product.ops,
    sync_status: 'pending',
  };

  const mergedNotes = {
    unsure: [
      ...(product.notes?.unsure || []),
      ...(improved.notes?.unsure || []),
    ],
    warnings: [
      ...(product.notes?.warnings || []),
      ...(improved.notes?.warnings || []),
    ],
  };
  improved.notes = mergedNotes;

  await saveProduct(improved);
  return improved;
}

module.exports = {
  improveExistingProduct,
};

