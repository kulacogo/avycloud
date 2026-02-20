/* eslint-disable no-console */
/**
 * Deterministic checks for barcode web-evidence scoring logic (no network).
 *
 * Usage:
 *   node backend/scripts/test-barcode-web-evidence-scoring.js
 */

const { findEvidenceInText } = require('../lib/barcode-web-confirm');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function run() {
  const barcode = '8719114322466'; // valid EAN-13 checkdigit
  const anchors = [
    { type: 'brand', value: 'Calvin Klein', strong: true },
    { type: 'mpn', value: 'U2664', strong: true },
    { type: 'title', value: 'Boxershorts', strong: false },
  ];

  // Non-marketplace: require strong OR >=2 anchors
  {
    const text = `Produktdetails Calvin Klein Boxershorts. EAN ${barcode}. MPN U2664.`;
    const res = findEvidenceInText({ barcode, text, anchors, host: 'www.brandshop.de' });
    assert(res.ok === true, 'expected ok for non-marketplace with strong anchors');
  }

  // Marketplace: requires strong anchor
  {
    const text = `Angebot: Boxershorts ... EAN ${barcode} ...`;
    const res = findEvidenceInText({ barcode, text, anchors: [{ type: 'title', value: 'Boxershorts', strong: false }], host: 'www.ebay.de' });
    assert(res.ok === false, 'expected reject for marketplace without strong anchor');
  }

  // Missing barcode should reject
  {
    const text = `Calvin Klein Boxershorts MPN U2664`;
    const res = findEvidenceInText({ barcode, text, anchors, host: 'www.brandshop.de' });
    assert(res.ok === false, 'expected reject when barcode not present');
  }

  console.log('OK: barcode web-evidence scoring checks passed.');
}

run();

