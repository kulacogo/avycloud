const crypto = require('crypto');

function normalizePart(value) {
  if (!value) return '';
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeProductIdentityKey(product = {}) {
  const name = normalizePart(product?.identification?.name);
  const brand = normalizePart(product?.identification?.brand);
  const mpn = normalizePart(product?.details?.identifiers?.mpn);
  const manufacturerSku = normalizePart(product?.details?.identifiers?.sku);
  const baseId = product?.ops?.base_product_id ? String(product.ops.base_product_id).trim() : null;

  if (baseId) {
    return `base:${baseId}`;
  }

  if (product?.identification?.barcodes?.length || product?.details?.identifiers?.ean || product?.details?.identifiers?.gtin || product?.details?.identifiers?.upc) {
    return null;
  }

  const parts = [brand, name, mpn, manufacturerSku].filter(Boolean);
  if (!parts.length) {
    return null;
  }

  const raw = parts.join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `identity:${hash}`;
}

module.exports = {
  computeProductIdentityKey,
};


