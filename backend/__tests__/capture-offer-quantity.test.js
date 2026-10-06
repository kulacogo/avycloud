'use strict';
const { explicitQuantity, captureOfferQuantityMatches } = require('../lib/capture-offer-quantity');
it.each(['140 x 200 cm', 'BLK008', '75257', 'Ø 9,8 cm Höhe 29 cm', '50x70 cm'])('does not interpret dimensions or identifiers as pack size: %s', text => {
  expect(explicitQuantity(text)).toBeNull();
});
it.each([['4 Rollen Tapete', 4], ['Pattex 12er-Pack', 12], ['2-teiliges Bettwäsche-Set', 2], ['Pack of 8 rolls', 8]])('reads explicit sale quantities: %s', (text, qty) => {
  expect(explicitQuantity(text)).toBe(qty);
});
it('rejects a different pack size or a missing pack size, even with a shared barcode', () => {
  const product = { identification: { name: 'Erfurt 4 Rollen' }, details: { identifiers: { ean: '4001234567890' } } };
  for (const title of ['Erfurt 8 Rollen + Kleister', 'Erfurt Rauhfaser']) expect(captureOfferQuantityMatches(product, title)).toBe(false);
  expect(captureOfferQuantityMatches(product, 'Erfurt 4 Rollen')).toBe(true);
  expect(captureOfferQuantityMatches({ identification: { name: 'Erfurt Rauhfaser' } }, 'Erfurt 8 Rollen')).toBe(false);
});
