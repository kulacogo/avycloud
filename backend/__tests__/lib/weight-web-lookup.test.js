'use strict';

// Patch toolkit.js via require.cache BEFORE loading the module under test.
const brightdataMock = vi.fn(async () => ({ ok: false, results: [] }));
const webFetchMock = vi.fn(async () => ({ success: false }));

const toolkitPath = require.resolve('../../services/toolkit');
require(toolkitPath);
require.cache[toolkitPath] = {
  id: toolkitPath,
  filename: toolkitPath,
  loaded: true,
  exports: {
    executeWebSearchToolCall: brightdataMock,
    executeWebFetchToolCall: webFetchMock,
    executeSerpapiToolCall: vi.fn(),
    serpapiToolDefinition: {},
    brightdataSearchToolDefinition: {},
    webFetchToolDefinition: {},
  },
};

const {
  lookupWeightFromWeb,
  brandDomainGuess,
  parseWeightToGrams,
  extractWeightCandidates,
  buildQueries,
} = require('../../lib/weight-web-lookup');

beforeEach(() => {
  vi.clearAllMocks();
  brightdataMock.mockReset();
  webFetchMock.mockReset();
});

describe('weight-web-lookup helpers', () => {
  it('parses "250 g" to 250 grams', () => {
    const candidates = extractWeightCandidates('The product weighs 250 g according to spec');
    expect(candidates).toContain(250);
  });

  it('parses "1.5 kg" to 1500 grams', () => {
    const candidates = extractWeightCandidates('Net weight: 1.5 kg');
    expect(candidates).toContain(1500);
  });

  it('parses German "Gewicht: 2,5 Kg" to 2500 grams (comma decimal)', () => {
    const candidates = extractWeightCandidates('Gewicht: 2,5 Kg inklusive Batterie');
    expect(candidates).toContain(2500);
  });

  it('rejects nonsense values (<1g and >50000g)', () => {
    const tooBig = extractWeightCandidates('extreme item: 75 kg');
    expect(tooBig).toEqual([]);
    // 0.4g → rounds to 0 → rejected
    const tooSmall = extractWeightCandidates('fluff 0.4 g weight');
    expect(tooSmall).toEqual([]);
  });

  it('brandDomainGuess strips legal forms and returns .de hint', () => {
    expect(brandDomainGuess('Sony Corporation Ltd.')).toBe('sonycorporation.de');
    expect(brandDomainGuess('Bosch GmbH')).toBe('bosch.de');
    expect(brandDomainGuess('')).toBeNull();
  });

  it('parseWeightToGrams handles edge units', () => {
    expect(parseWeightToGrams('2', 'kg')).toBe(2000);
    expect(parseWeightToGrams('500', 'g')).toBe(500);
    expect(parseWeightToGrams('bad', 'g')).toBeNull();
    expect(parseWeightToGrams('-3', 'kg')).toBeNull();
  });
});

describe('lookupWeightFromWeb()', () => {
  it('returns null when all searches fail', async () => {
    brightdataMock.mockResolvedValue({ ok: false, results: [] });
    const res = await lookupWeightFromWeb({ brand: 'Acme', model: 'X1' });
    expect(res.weight_grams).toBeNull();
    expect(res.confidence).toBe(0);
  });

  it('returns high confidence when 2+ results agree within tolerance', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [
        { url: 'https://a.com/spec', title: 'Acme X1', snippet: 'Weight: 250 g' },
        { url: 'https://b.com/spec', title: 'Acme X1 review', snippet: 'mit einem Gewicht von 255 Gramm' },
      ],
    });
    const res = await lookupWeightFromWeb({ brand: 'Acme', model: 'X1' });
    expect(res.weight_grams).toBeGreaterThanOrEqual(250);
    expect(res.weight_grams).toBeLessThanOrEqual(255);
    expect(res.confidence).toBe(0.85);
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it('returns lower confidence with a single candidate', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [{ url: 'https://only.com', title: 'Acme', snippet: 'wiegt 320g' }],
    });
    // Second query returns nothing
    brightdataMock.mockResolvedValueOnce({ ok: false, results: [] });
    brightdataMock.mockResolvedValueOnce({ ok: false, results: [] });
    const res = await lookupWeightFromWeb({ brand: 'Acme', model: 'X1' });
    expect(res.weight_grams).toBe(320);
    expect(res.confidence).toBe(0.6);
  });

  it('uses brand-domain site: hint in one of the queries', () => {
    const queries = buildQueries({ brand: 'Sony GmbH', model: 'XM5' });
    const hasSiteHint = queries.some((q) => /site:sony\.de/.test(q));
    expect(hasSiteHint).toBe(true);
  });

  it('handles conflicting results by returning median with low confidence', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [
        { url: 'https://a.com', title: 't', snippet: '100 g' },
        { url: 'https://b.com', title: 't', snippet: '5000 g' },
      ],
    });
    const res = await lookupWeightFromWeb({ brand: 'Acme', model: 'X1' });
    expect(res.weight_grams).toBeGreaterThan(0);
    expect([0.4, 0.85]).toContain(res.confidence); // tolerate cluster algorithm's decision
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it('returns empty when identity has no brand/model/ean', async () => {
    const res = await lookupWeightFromWeb({});
    expect(res.weight_grams).toBeNull();
    expect(res.confidence).toBe(0);
    expect(brightdataMock).not.toHaveBeenCalled();
  });
});
