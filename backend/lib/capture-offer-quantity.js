'use strict';

// Compare the quantity sold, not dimensions (140 x 200 cm) or model numbers.
// A shared barcode can occur on a single roll and a retailer's multi-pack.
function explicitQuantity(text) {
  const value = String(text || '').toLowerCase();
  const match = value.match(/\b(\d{1,3})\s*[- ]?\s*(?:rollen?|st(?:ü|ue)ck|pcs|pieces|er[- ]?pack|packs?|teilig(?:es|er|e)?)\b/) ||
    value.match(/\b(?:set|pack)\s*(?:mit|of|aus|à|a)?\s*(\d{1,3})\b/);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

function captureOfferQuantityMatches(product, offerTitle) {
  const attrs = product.details?.attributes || {};
  const target = explicitQuantity(product.identification?.name) ||
    explicitQuantity(attrs.Modell) ||
    explicitQuantity(`${attrs['Anzahl Einheiten'] || attrs.Stückzahl || ''} Stück`);
  const offered = explicitQuantity(offerTitle);
  // No explicit quantity means a single sale unit. Never convert a bundle's
  // price into a unit price or silently assign a unit price to a bundle.
  return (target || 1) === (offered || 1);
}

module.exports = { explicitQuantity, captureOfferQuantityMatches };
