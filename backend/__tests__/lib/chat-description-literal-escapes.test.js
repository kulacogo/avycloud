'use strict';

/**
 * Regression: the ACTIVE chat path (Chat-V3, default on) must not persist a
 * literal backslash-n in the product description. Incident 2026-06-29.
 *
 * Chat-V3 keeps the model's NATIVE prose verbatim (it does NOT route the
 * description through listing-sanitize's prose builder), so the de-literalization
 * has to happen on the two chat chokepoints:
 *   - sanitizeDatasheetChangeV3()  (builds the change returned to the frontend)
 *   - applyChatChangesToProduct()  (backend bulk/auto-enrich persist)
 *
 * NOTE: in this source file, the JS literal '\\n' is the two characters
 * backslash + n — the exact corruption the model emits by over-escaping.
 */
const { sanitizeDatasheetChangeV3 } = require('../../services/product-chat-v3')._testables;
const { applyChatChangesToProduct } = require('../../lib/apply-chat-changes');

const LITERAL_BACKSLASH_N = '\\n';

describe('chat description literal-escape hardening', () => {
  it('sanitizeDatasheetChangeV3 strips a literal backslash-n from short_description', () => {
    const out = sanitizeDatasheetChangeV3({
      short_description:
        'Holen Sie sich Energie.\\n\\n \\n Einzigartiges Set mit Emaille-Pin.\\n Perfekt fuer Sammler.',
    });
    expect(out.short_description).toBeTruthy();
    expect(out.short_description).not.toContain(LITERAL_BACKSLASH_N);
    expect(out.short_description).toContain('Einzigartiges Set');
    expect(out.short_description).toContain('Perfekt fuer Sammler');
  });

  it('applyChatChangesToProduct never persists a literal backslash-n in the description', () => {
    const product = {
      id: 'p1',
      identification: { sku: 'SKU-1', name: 'Alt', brand: 'Funko', barcodes: [] },
      details: { short_description: 'kurz', key_features: [] },
      ops: {},
    };
    const { product: out, changed } = applyChatChangesToProduct(product, [
      {
        short_description:
          'Eine ausfuehrliche, gute Beschreibung.\\n\\n \\n Mit einem zweiten Absatz und vielen Details fuer Sammler dieser Edition.',
      },
    ]);
    expect(changed).toContain('description');
    expect(out.details.short_description).not.toContain(LITERAL_BACKSLASH_N);
    expect(out.details.short_description).toContain('zweiten Absatz');
  });
});
