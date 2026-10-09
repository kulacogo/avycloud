'use strict';
const { buildCapturePriceQueries, capturePageMatchesIdentity } = require('../lib/capture-price');
const { extractProductOffer } = require('../lib/capture-web-price');
const ikea = { identification: { brand: 'IKEA', name: 'IKEA SÄFFEROT warm 140x200' }, details: { identifiers: { mpn: '805.657.16' }, attributes: { Modell: 'SÄFFEROT' } } };
const html = node => `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
it('searches identifiers and a separate model query without excluding .com merchants', () => {
  expect(buildCapturePriceQueries(ikea)).toEqual(['IKEA 805.657.16', 'IKEA SÄFFEROT']);
});
it('prefers GTIN and retains variant information in the model fallback', () => {
  expect(buildCapturePriceQueries({ identification: { brand: 'Acme', name: 'Acme Alpha 140x200 blue' }, details: { identifiers: { ean: '4012345678901' }, attributes: { Modell: 'Alpha', Größe: '140x200', Farbe: 'blue' } } })).toEqual(['4012345678901', 'Acme Alpha 140x200 blue', '"Acme" "Alpha"']);
});
it('matches formatted manufacturer numbers, never a partial number or another model', () => {
  expect(capturePageMatchesIdentity({ product: ikea, page: { text: 'IKEA SÄFFEROT 80565716' } })).toBe(true);
  expect(capturePageMatchesIdentity({ product: ikea, page: { text: 'IKEA SÄFFEROT 805657160' } })).toBe(false);
  expect(capturePageMatchesIdentity({ product: ikea, page: { text: 'IKEA SÄFFEROT 80565717' } })).toBe(false);
});
it('reads a nested main product price specification without using list prices', () => {
  const product = { '@type': 'Product', sku: '80565716', name: 'IKEA SÄFFEROT', offers: { '@type': 'Offer', priceSpecification: [{ '@type':'UnitPriceSpecification', price: 29.99, priceCurrency: 'EUR', priceType: 'https://schema.org/StrikethroughPrice' }, { '@type':'UnitPriceSpecification', price: 19.99, priceCurrency: 'EUR' }] } };
  expect(extractProductOffer(html({ '@type':'WebPage', mainEntity:product }),ikea,capturePageMatchesIdentity)).toBe(19.99);
});
it('does not assign a ProductGroup aggregate low price to a specific variant', () => {
  const product = { '@type':'ProductGroup', name:'IKEA SÄFFEROT', offers:{'@type':'AggregateOffer',lowPrice:9.99,priceCurrency:'EUR'},hasVariant:[{'@type':'Product',name:'IKEA SÄFFEROT',sku:'80565716',offers:{price:19.99,priceCurrency:'EUR'}},{'@type':'Product',name:'IKEA SÄFFEROT',sku:'80565717',offers:{price:9.99,priceCurrency:'EUR'}}]};
  expect(extractProductOffer(html(product),ikea,capturePageMatchesIdentity)).toBe(19.99);
});
it('rejects unavailable and used price specifications', () => {
  for(const change of [{availability:'OutOfStock'},{itemCondition:'UsedCondition'}]) {
    expect(extractProductOffer(html({'@type':'Product',sku:'80565716',offers:{...change,priceSpecification:{price:19.99,priceCurrency:'EUR'}}}),ikea,capturePageMatchesIdentity)).toBeNull();
  }
});
