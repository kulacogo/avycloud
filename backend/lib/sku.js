const crypto = require('crypto');

const SKU_PATTERN = /^SKU-\d{10}$/;

function generateSku() {
  const digits = crypto.randomInt(0, 1_000_000_0000);
  return `SKU-${digits.toString().padStart(10, '0')}`;
}

function ensureProductSku(product) {
  if (!product) return null;

  const current =
    product.identification?.sku ||
    product.details?.identifiers?.sku ||
    product.details?.identifiers?.ean ||
    null;

  const existing = current && SKU_PATTERN.test(current) ? current : null;
  const sku = existing || generateSku();

  if (!product.identification) {
    product.identification = {};
  }
  product.identification.sku = sku;

  if (!product.details) {
    product.details = {};
  }
  if (!product.details.identifiers) {
    product.details.identifiers = {};
  }
  product.details.identifiers.sku = sku;

  return sku;
}

module.exports = {
  generateSku,
  ensureProductSku,
  SKU_PATTERN,
};

