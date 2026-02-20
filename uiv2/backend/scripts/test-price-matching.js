#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Smoke test: price matching & fallback similarity.
 *
 * Usage:
 *   node backend/scripts/test-price-matching.js
 */

const { __test } = require('../services/enrichment');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion_failed');
}

function makeProduct(overrides = {}) {
  return {
    id: 'p1',
    identification: {
      brand: 'Acme',
      name: 'LED Hallenleuchte 150W 230V schwarz 120x60x10 cm',
      barcodes: [],
      ...overrides.identification,
    },
    details: {
      identifiers: { ean: null, gtin: null, upc: null, mpn: 'ACME-150W', sku: null, ...overrides.details?.identifiers },
      attributes: {
        Leistung: '150 W',
        Spannung: '230 V',
        Farbe: 'Schwarz',
        Abmessungen: '120 x 60 x 10 cm',
        Gewicht: '3,2 kg',
        ...(overrides.details?.attributes || {}),
      },
      ...(overrides.details || {}),
    },
    notes: { unsure: [], warnings: [] },
    ...overrides,
  };
}

function run() {
  assert(__test, 'Missing __test exports from enrichment.js');

  const product = makeProduct();
  const keywords = ['acme', 'acme-150w', 'hallenleuchte', 'led', 'schwarz'];

  // Mock serpTrace with mixed results:
  // - exact match but not the cheapest (still should pick cheapest among good matches)
  // - used offer should be rejected
  // - accessory should be rejected
  // - similar-by-specs (no mpn/barcode) should be accepted only if no exact match present
  const serpTrace = [
    {
      engine: 'google_shopping',
      query: 'acme acme-150w neu preis',
      summary: [
        { title: 'Acme LED Hallenleuchte ACME-150W 150W 230V schwarz', price: 129.99, source: 'Shop A', url: 'https://a.example/p' },
        { title: 'Acme LED Hallenleuchte ACME-150W 150W 230V schwarz', price: 119.99, source: 'Shop B', url: 'https://b.example/p' }, // cheapest exact
        { title: 'Acme LED Hallenleuchte ACME-150W gebraucht', price: 59.99, source: 'Used', url: 'https://u.example/p' }, // reject used
        { title: 'Adapter / Zubehör für Hallenleuchte 230V', price: 9.99, source: 'Accessory', url: 'https://z.example/p' }, // reject accessory
      ],
      params: {},
      error: null,
      fallback: true,
    },
  ];

  const cands = __test.collectPriceCandidates(product, serpTrace, keywords);
  assert(cands.length >= 2, `Expected >=2 candidates, got ${cands.length}`);
  const best = __test.pickBestPriceCandidate(cands);
  assert(best, 'Expected a best candidate');
  assert(best.amount === 119.99, `Expected cheapest exact 119.99, got ${best.amount}`);

  // Now: no exact candidates, only similar-by-specs should pick cheapest similar
  const serpTraceSimilarOnly = [
    {
      engine: 'google_shopping',
      query: 'led hallenleuchte neu preis',
      summary: [
        { title: 'LED Hallenleuchte 150W 230V schwarz 120x60 cm', price: 89.99, source: 'Similar A', url: 'https://sa.example/p' },
        { title: 'LED Hallenleuchte 100W 230V schwarz', price: 79.99, source: 'Wrong watt', url: 'https://sw.example/p' },
      ],
      params: {},
      error: null,
      fallback: true,
    },
  ];
  const cands2 = __test.collectPriceCandidates(product, serpTraceSimilarOnly, keywords);
  const best2 = __test.pickBestPriceCandidate(cands2);
  assert(best2, 'Expected a best candidate for similar-only');
  assert(best2.amount === 89.99, `Expected best similar 89.99, got ${best2.amount}`);

  console.log('OK: price matching smoke tests passed.');
}

run();

