'use strict';

// TDD for backend/services/chat-enricher.js
// enrichViaChatV3 runs the chat pipeline for the FULL datasheet and applies all
// proposals via applyChatChangesToProduct. Chat is injected for offline tests.

const { enrichViaChatV3 } = require('../../services/chat-enricher');

function product() {
  return {
    id: 'p1',
    identification: { sku: 'SKU-1', name: 'Alt', brand: 'BelleMax', category: 'Garten > Markisen' },
    inventory: { quantity: 4 },
    details: { attributes: { Marke: 'BelleMax' }, pricing: {} },
    ops: {},
  };
}

describe('enrichViaChatV3', () => {
  it('runs the chat for the full datasheet and applies all proposals (content only)', async () => {
    const runProductChatV3 = async () => ({
      datasheetChanges: [
        { title: 'BelleMax Seitenmarkise 300x160 cm Anthrazit Sichtschutz Balkon Windschutz' },
        { attributes: { Produktart: 'Seitenmarkise' } },
        { pricing: { amount: 119.95, currency: 'EUR', source_url: 'https://hersteller.de/x' } },
      ],
      evidence: [{ url: 'https://hersteller.de/x', title: 'Datenblatt' }],
      confidence: { overall: 0.9 },
      model: 'gemini-3.1-pro-preview-customtools',
    });

    const res = await enrichViaChatV3(product(), { deps: { runProductChatV3 } });

    expect(res.product.identification.name).toMatch(/^BelleMax /);
    expect(res.product.details.attributes.Produktart).toBe('Seitenmarkise');
    expect(res.product.details.pricing.lowest_price.amount).toBe(119.95);
    expect(res.changed).toEqual(expect.arrayContaining(['title', 'attributes', 'pricing']));
    expect(res.evidence.length).toBe(1);
    expect(res.confidence).toBe(0.9);
    expect(res.model).toContain('gemini-3');
    // inventory untouched
    expect(res.product.inventory).toEqual({ quantity: 4 });
  });

  it('never crashes when the chat throws — returns no changes + error', async () => {
    const runProductChatV3 = async () => { throw new Error('gemini down'); };
    const res = await enrichViaChatV3(product(), { deps: { runProductChatV3 } });
    expect(res.changed).toEqual([]);
    expect(res.error).toMatch(/gemini down/);
    expect(res.product.identification.name).toBe('Alt'); // unchanged
  });
});
