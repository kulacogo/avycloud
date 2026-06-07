'use strict';

// TDD for backend/lib/title-optimizer.js
// optimizeTitle calls the SAME research-grounded chat pipeline (runProductChatV3)
// the assistant uses — full research (googleSearch + tools), correct model/params —
// and takes its PROPOSED title (datasheetChanges), with a hard brand-first safety
// net. The chat pipeline is injected for offline tests.

const { optimizeTitle } = require('../../lib/title-optimizer');

function product(over = {}) {
  return {
    identification: { brand: 'BelleMax', name: 'Markise alt', category: 'Garten > Sonnenschutz > Markisen' },
    details: { attributes: { Produktart: 'Seitenmarkise' } },
    ...over,
  };
}

function chatResult(title, extra = {}) {
  return {
    datasheetChanges: title === undefined ? [{ summary: 'kein titel' }] : [{ summary: 'opt', title }],
    evidence: [{ url: 'https://hersteller.de/x', title: 'Datenblatt' }],
    confidence: { overall: 0.85 },
    model: 'gemini-3.1-pro-preview-customtools',
    ...extra,
  };
}

describe('optimizeTitle (via chat pipeline)', () => {
  it('returns the chat-proposed title (brand-first) + evidence + confidence + model', async () => {
    const runProductChatV3 = async () => chatResult('BelleMax Seitenmarkise 195x370 cm Anthrazit Sichtschutz Windschutz Balkon');
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res.title.startsWith('BelleMax ')).toBe(true);
    expect(res.evidence.length).toBeGreaterThan(0);
    expect(res.confidence).toBe(0.85);
    expect(res.model).toContain('gemini-3');
  });

  it('prepends the brand if the chat dropped it (safety net)', async () => {
    const runProductChatV3 = async () => chatResult('Seitenmarkise 195x370 cm Anthrazit Sichtschutz');
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res.title.toLowerCase().startsWith('bellemax')).toBe(true);
    expect(res.title.toLowerCase()).toContain('seitenmarkise');
  });

  it('returns null when the product has no brand (never risk a brandless title)', async () => {
    const runProductChatV3 = async () => chatResult('Seitenmarkise');
    const res = await optimizeTitle(product({ identification: { brand: '', name: 'x' } }), { deps: { runProductChatV3 } });
    expect(res).toBeNull();
  });

  it('returns null when the chat proposes no title', async () => {
    const runProductChatV3 = async () => chatResult(undefined);
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res).toBeNull();
  });

  it('uses the last datasheetChange that carries a title', async () => {
    const runProductChatV3 = async () => ({
      datasheetChanges: [{ title: 'BelleMax Alt' }, { summary: 'x' }, { title: 'BelleMax Seitenmarkise 195x370 cm Anthrazit FINAL' }],
      evidence: [],
      confidence: { overall: 0.9 },
      model: 'm',
    });
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res.title).toContain('FINAL');
  });

  it('returns null when the chat call throws (never crash the bulk)', async () => {
    const runProductChatV3 = async () => { throw new Error('gemini down'); };
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res).toBeNull();
  });

  it('hard-caps the title at 80 chars', async () => {
    const long = 'BelleMax ' + 'Seitenmarkise Anthrazit Sichtschutz Windschutz '.repeat(4);
    const runProductChatV3 = async () => chatResult(long);
    const res = await optimizeTitle(product(), { deps: { runProductChatV3 } });
    expect(res.title.length).toBeLessThanOrEqual(80);
    expect(res.title.toLowerCase().startsWith('bellemax')).toBe(true);
  });
});
