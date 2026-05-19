'use strict';

/**
 * Service-level tests for services/kaufland-attribute-enricher.js
 *
 * Mocks lib/gpsr-web-fallback.js and lib/gemini-client.js via require.cache
 * patching (Vitest 4.x CJS-friendly pattern — same as the other service tests
 * in this folder).
 */

// vitest globals: true — describe/it/expect/vi are global.

function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// ─── Mocks ────────────────────────────────────────────────────────────────
const lookupGpsrFromWebMock = vi.fn();
installModuleMock('../../lib/gpsr-web-fallback', {
  lookupGpsrFromWeb: lookupGpsrFromWebMock,
});

const callGeminiVisionMock = vi.fn();
installModuleMock('../../lib/gemini-client', {
  callGeminiVision: callGeminiVisionMock,
  getGeminiClient: vi.fn(),
  getGeminiApiKey: vi.fn(),
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const {
  enrichProductForKaufland,
  classifyMissingAttribute,
  mergeGpsr,
} = require('../../services/kaufland-attribute-enricher');

beforeEach(() => {
  lookupGpsrFromWebMock.mockReset();
  callGeminiVisionMock.mockReset();
});

// ─── classifyMissingAttribute ─────────────────────────────────────────────
describe('classifyMissingAttribute', () => {
  it('maps GPSR-related labels to "gpsr"', () => {
    expect(classifyMissingAttribute('product_safety_contact')).toBe('gpsr');
    expect(classifyMissingAttribute('Verantwortliche Person')).toBe('gpsr');
    expect(classifyMissingAttribute('Hersteller-Kontakt')).toBe('gpsr');
  });

  it('maps description labels to "description"', () => {
    expect(classifyMissingAttribute('description')).toBe('description');
    expect(classifyMissingAttribute('Produktbeschreibung')).toBe('description');
  });

  it('maps material composition labels to "material"', () => {
    expect(classifyMissingAttribute('Materialzusammensetzung')).toBe('material');
    expect(classifyMissingAttribute('material composition')).toBe('material');
  });

  it('maps standalone manufacturer to "manufacturer"', () => {
    expect(classifyMissingAttribute('manufacturer')).toBe('manufacturer');
    expect(classifyMissingAttribute('Hersteller')).toBe('manufacturer');
  });

  it('returns null for unrelated labels', () => {
    expect(classifyMissingAttribute('foo_bar_unknown')).toBeNull();
    expect(classifyMissingAttribute('')).toBeNull();
  });

  it('maps picture labels to "picture"', () => {
    expect(classifyMissingAttribute('picture')).toBe('picture');
    expect(classifyMissingAttribute('Bild')).toBe('picture');
  });
});

// ─── mergeGpsr ────────────────────────────────────────────────────────────
describe('mergeGpsr', () => {
  it('does not overwrite existing non-empty fields', () => {
    const existing = { manufacturer_name: 'Original GmbH', email: 'info@orig.de' };
    const web = { manufacturer_name: 'Web GmbH', manufacturer_address: 'Webstr. 1, D-10115 Berlin', manufacturer_email: 'web@web.de' };
    const out = mergeGpsr(existing, web);
    expect(out.manufacturer_name).toBe('Original GmbH'); // preserved
    expect(out.email).toBe('info@orig.de'); // preserved
    expect(out.manufacturer_address).toBe('Webstr. 1, D-10115 Berlin'); // filled
  });

  it('returns existing as-is when webResult is null/empty', () => {
    expect(mergeGpsr({ manufacturer_name: 'X' }, null)).toEqual({ manufacturer_name: 'X' });
    expect(mergeGpsr({}, { manufacturer_name: '', manufacturer_address: '' })).toEqual({});
  });
});

// ─── enrichProductForKaufland ─────────────────────────────────────────────
describe('enrichProductForKaufland', () => {
  it('no-ops when missingAttributes is empty', async () => {
    const product = {
      id: 'p1',
      identification: { name: 'X', brand: 'Y' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, []);
    expect(out.enrichedFields).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('GPSR-only path: fetches web fallback and merges manufacturer info', async () => {
    lookupGpsrFromWebMock.mockResolvedValueOnce({
      manufacturer_name: 'ACME GmbH',
      manufacturer_address: 'Hauptstr. 1, D-10115 Berlin',
      manufacturer_email: 'info@acme.de',
      manufacturer_url: 'https://acme.de',
      confidence: 0.75,
      sources: [],
    });

    const product = {
      id: 'p1',
      identification: { name: 'ACME Widget', brand: 'ACME' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);

    expect(out.enrichedFields).toContain('gpsr');
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('ACME GmbH');
    expect(out.enriched.details.gpsr.email).toBe('info@acme.de');
    expect(out.enriched.details.gpsr.url).toBe('https://acme.de');
    expect(lookupGpsrFromWebMock).toHaveBeenCalledTimes(1);
    expect(lookupGpsrFromWebMock).toHaveBeenCalledWith('ACME', expect.objectContaining({ timeout: expect.any(Number) }));
    // No description / material asked for -> Gemini not called.
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('description-only path: calls Gemini for description, sets details.description', async () => {
    callGeminiVisionMock.mockResolvedValueOnce(
      'Praktischer Haushaltshelfer aus robustem Edelstahl. Ergonomischer Griff, spülmaschinengeeignet. Geeignet für den täglichen Einsatz in Küche und Gastronomie. Lieferung in stabiler Originalverpackung.'
    );

    const product = {
      id: 'p1',
      identification: { name: 'Edelstahl Spatel 30cm', brand: 'KitchenPro' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, ['Produktbeschreibung']);

    expect(out.enrichedFields).toContain('description');
    expect(out.enriched.details.description).toMatch(/Edelstahl/);
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(1);
    // GPSR not in missing -> no web call.
    expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
  });

  it('all-fields-needed path: GPSR + description + material + manufacturer all run', async () => {
    lookupGpsrFromWebMock.mockResolvedValueOnce({
      manufacturer_name: 'ACME GmbH',
      manufacturer_address: 'Hauptstr. 1, D-10115 Berlin',
      manufacturer_email: 'info@acme.de',
      manufacturer_url: 'https://acme.de',
      confidence: 0.75,
      sources: [],
    });
    // Two Gemini calls (description + material), order parallel — use mockImplementation
    // to return based on prompt content.
    callGeminiVisionMock.mockImplementation(async (prompt) => {
      if (/Materialzusammensetzung|Material1, YY/.test(prompt)) {
        return '100% Baumwolle';
      }
      return 'Hochwertiger Baumwoll-Artikel der Marke ACME. Angenehmes Tragegefühl, langlebige Verarbeitung und vielseitig einsetzbar. Geeignet für den täglichen Gebrauch.';
    });

    const product = {
      id: 'p1',
      identification: { name: 'ACME T-Shirt', brand: 'ACME', category: 'Bekleidung' },
      details: {}, // empty: nothing exists yet
    };
    const out = await enrichProductForKaufland(product, [
      'product_safety_contact',
      'description',
      'Materialzusammensetzung',
      'manufacturer',
    ]);

    expect(out.enrichedFields).toEqual(expect.arrayContaining(['manufacturer', 'gpsr', 'description', 'material']));
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('ACME GmbH');
    expect(out.enriched.details.description).toMatch(/ACME/);
    expect(out.enriched.details.attributes.Materialzusammensetzung).toBe('100% Baumwolle');
    expect(out.enriched.details.attributes.Hersteller).toBe('ACME');
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(2);
    expect(lookupGpsrFromWebMock).toHaveBeenCalledTimes(1);
  });

  it('skips GPSR web-fallback when existing data is already complete (name+address)', async () => {
    // Behaviour change 2026-05-20: brand-lookup is the new 1st-tier (cheap,
    // no IO). Web-fallback only runs when GPSR still lacks name OR address
    // AFTER brand-lookup. If already complete locally → both pathways are
    // skipped (saves time + API calls).
    const product = {
      id: 'p1',
      identification: { name: 'X', brand: 'ACME' },
      details: {
        gpsr: {
          manufacturer_name: 'ACME GmbH',
          manufacturer_address: 'Hauptstr. 1',
          email: 'info@acme.de',
        },
      },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);
    expect(out.enrichedFields).toEqual([]);
    // Complete GPSR → no web-fallback needed
    expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
  });

  it('uses brand-lookup as 1st-tier when sibling product has GPSR (no web call needed)', async () => {
    // The new flow: if opts.brandGpsrMap has a hit for the same brand,
    // merge that GPSR (existing-wins) and skip web-scrape entirely.
    const brandGpsrMap = new Map();
    brandGpsrMap.set('anker', {
      score: 11,
      fromSku: 'SKU-9303003754',
      gpsr: {
        manufacturer_name: 'Anker Innovations Deutschland GmbH',
        manufacturer_address: 'Georg-Muche-Straße 3',
        manufacturer_city: 'München',
        manufacturer_postalcode: '80807',
        country_code: 'DE',
        email: 'support@anker.com',
        manufacturer_phone: '+496995797960',
      },
    });
    const product = {
      id: 'p1',
      identification: { name: 'Anker Charger', brand: 'Anker' },
      details: { gpsr: { manufacturer_name: 'Anker' } }, // incomplete
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact'], { brandGpsrMap });
    expect(out.enrichedFields).toContain('gpsr-brand');
    expect(out.enriched.details.gpsr.manufacturer_address).toBe('Georg-Muche-Straße 3');
    expect(out.enriched.details.gpsr.email).toBe('support@anker.com');
    // Existing manufacturer_name wins (we don't overwrite)
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('Anker');
    // Web-fallback not needed because brand-lookup completed the GPSR
    expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
  });

  it('swallows Gemini errors per-field without crashing (no enrichment, no throw)', async () => {
    callGeminiVisionMock.mockRejectedValueOnce(new Error('gemini boom'));

    const product = {
      id: 'p1',
      identification: { name: 'X', brand: 'Y' },
      details: {},
    };
    // Should resolve normally, not throw. description bucket fails silently
    // (generateDescription returns null on Gemini error → no field added).
    const out = await enrichProductForKaufland(product, ['description']);
    expect(out.enrichedFields).toEqual([]);
    // details.description must remain unset
    expect(out.enriched.details.description).toBeUndefined();
  });

  it('reports missing pictures via errors but does not throw', async () => {
    const product = {
      id: 'p1',
      identification: { name: 'X', brand: 'Y' },
      details: { images: [] },
    };
    const out = await enrichProductForKaufland(product, ['picture']);
    expect(out.enrichedFields).toEqual([]);
    expect(out.errors.some((e) => /picture.*no images/.test(e))).toBe(true);
  });
});
