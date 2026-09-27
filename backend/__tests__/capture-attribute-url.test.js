'use strict';
const { coerceAttributeValueToPolicy, canonicalizeAttributesStrict } = require('../lib/attribute-policy');

it('preserves evidence URLs across the canonicalization used by the save boundary', () => {
  const url = 'https://manufacturer.example/safety/' + 'model-reference-'.repeat(20) + '.pdf';
  expect(coerceAttributeValueToPolicy('Sicherheitsdatenblatt', url, { maxLen: 60 })).toBe(url);
  expect(canonicalizeAttributesStrict({ Sicherheitsdatenblatt: url }).attributes.Sicherheitsdatenblatt).toBe(url);
});

it('keeps text length limits and blocked attribute keys', () => {
  expect(coerceAttributeValueToPolicy('Material', 'x'.repeat(100))).toHaveLength(60);
  expect(canonicalizeAttributesStrict({ ebay_id: 'https://example.com/test' }).attributes).toEqual({});
});
