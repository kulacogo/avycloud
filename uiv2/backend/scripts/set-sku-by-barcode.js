/**
 * Force-set an Avycloud SKU for a product identified by barcode/EAN,
 * while preserving the vendor SKU in attributes.
 *
 * Usage:
 *   node backend/scripts/set-sku-by-barcode.js \
 *     --barcode 001716533745855 \
 *     --newSku SKU-4919757592 \
 *     --vendorSku 0M0028-502-L
 */

const { FieldValue } = require('@google-cloud/firestore');
const {
  firestore,
  setSkuIndexEntry,
} = require('../lib/firestore');
const {
  buildIdentityAliasSet,
  computeProductIdentityKey,
} = require('../lib/product-identity');

function normalizeSkuValue(val) {
  return (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');
}

function normalizeEanValue(val) {
  return (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = args[i + 1];
    result[key] = value;
    i += 1;
  }
  return result;
}

async function main() {
  const { barcode, newSku, vendorSku } = parseArgs();
  if (!barcode || !newSku) {
    console.error('Usage: --barcode <EAN> --newSku <SKU-##########> [--vendorSku <vendor>]');
    process.exit(1);
  }

  const normalizedBarcode = normalizeEanValue(barcode);
  const normalizedSku = normalizeSkuValue(newSku);

  const queryCandidates = [
    firestore.collection('products').where('identification.barcodes', 'array-contains', normalizedBarcode),
    firestore.collection('products').where('details.identifiers.ean', '==', normalizedBarcode),
    firestore.collection('products').where('details.identifiers.gtin', '==', normalizedBarcode),
  ];

  let targetSnap = null;
  for (const q of queryCandidates) {
    const snap = await q.limit(5).get();
    if (!snap.empty) {
      targetSnap = snap;
      break;
    }
  }

  if (!targetSnap || targetSnap.empty) {
    console.error(`No product found for barcode ${normalizedBarcode}`);
    process.exit(1);
  }

  for (const doc of targetSnap.docs) {
    const data = doc.data() || {};
    const updated = { ...data };

    // Set SKUs
    updated.identification = {
      ...(data.identification || {}),
      sku: newSku,
      barcodes: Array.isArray(data.identification?.barcodes)
        ? Array.from(new Set(data.identification.barcodes.concat([normalizedBarcode])))
        : [normalizedBarcode],
    };
    const existingIds = data.details?.identifiers || {};
    updated.details = {
      ...(data.details || {}),
      identifiers: {
        ...existingIds,
        sku: newSku,
        ean: existingIds.ean || normalizedBarcode,
      },
      attributes: {
        ...(data.details?.attributes || {}),
        vendor_sku: vendorSku || existingIds.sku || null,
        vendorSku: vendorSku || existingIds.sku || null,
      },
    };

    // Update ops metadata
    const aliases = buildIdentityAliasSet(updated);
    updated.ops = {
      ...(data.ops || {}),
      identity_aliases: aliases,
      identity_key: computeProductIdentityKey(updated),
      last_saved_iso: new Date().toISOString(),
      revision: (data.ops?.revision || 0) + 1,
    };

    await doc.ref.set(updated, { merge: false });

    const indexPayload = {
      baseProductId: data.ops?.base_product_id || null,
      productId: doc.id,
      sku: newSku,
      ean: updated.details?.identifiers?.ean || null,
      updatedAt: new Date().toISOString(),
    };
    const skuKey = `sku:${normalizedSku}`;
    await setSkuIndexEntry(skuKey, indexPayload);
    if (indexPayload.ean) {
      const eanKey = `ean:${normalizeEanValue(indexPayload.ean)}`;
      await setSkuIndexEntry(eanKey, indexPayload);
    }

    console.log(
      `Updated product ${doc.id}: sku=${newSku}, vendor_sku=${vendorSku || '(kept)'}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
