'use strict';
const { indexedOfferPrice } = require('../lib/capture-indexed-offer');
const { capturePageMatchesIdentity } = require('../lib/capture-price');
const p = { identification: { brand: 'Acme', name: 'Acme Model A' }, details: { identifiers: { ean: '4012345678901' } } };
const row = { url:'https://shop.de/product/4012345678901', title:'Acme Model A 4012345678901', richSnippet:{top:{detected_extensions:{price:1699,currency:'€'},extensions:['16,99 €','Auf Lager','Lieferung 4,99 €']}} };
it('reads the complete EUR offer label, never the mangled numeric field or shipping', () => {
  expect(indexedOfferPrice(row,p,capturePageMatchesIdentity)).toBe(16.99);
});
it.each([['ab 16,99 €','Auf Lager'],['16,99 CHF','Auf Lager'],['16,99 €','Ausverkauft'],['16,99 €','Auf Lager','Gebraucht'],['16,99 €','19,99 €','Auf Lager']])('rejects ambiguous or unsuitable labels %j', (...extensions) => {
  expect(indexedOfferPrice({...row,richSnippet:{top:{extensions}}},p,capturePageMatchesIdentity)).toBeNull();
});
it('rejects another article, a search page and a foreign storefront', () => {
  for(const other of [{title:'Acme other model',url:'https://shop.de/product/other'}, {url:'https://shop.de/search?q=4012345678901'}, {url:'https://shop.fr/product/4012345678901'}]) {
    expect(indexedOfferPrice({...row,...other},p,capturePageMatchesIdentity)).toBeNull();
  }
});
