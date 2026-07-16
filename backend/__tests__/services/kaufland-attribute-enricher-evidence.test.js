'use strict';

/**
 * Beleg-Gates im Kaufland-Attribut-Enricher (AUDIT 2026-07-16):
 *
 * 1. gpsr-gemini-Tier: Lookup-Ergebnisse werden NUR uebernommen, wenn sie
 *    evidence.status verified|partial tragen. Alt-Cache-Eintraege (cached:true
 *    OHNE evidence — die unverifizierte Halluzinations-Quelle des Audits) und
 *    unverifiable-Ergebnisse werden abgelehnt (errors.push, nichts schreiben).
 *
 * 2. brandGpsrMap-Tier: Geschwister-Kopie nur wenn (a) die Quelle einen
 *    verified-Beleg traegt ODER (b) das Ziel GAR keine echte manufacturer_name
 *    hat — dann wird die Kopie EXPLIZIT als unverified markiert
 *    (details.gpsr.evidence={status:'inherited_unverified', fromSku}).
 *    Nie stumm verified-los kopieren.
 *
 * Mocks via require.cache-Patching (CJS-Muster wie
 * __tests__/services/kaufland-attribute-enricher.test.js).
 */

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

const getOrFetchBrandGpsrMock = vi.fn();
installModuleMock('../../lib/gpsr-gemini-lookup', {
  getOrFetchBrandGpsr: getOrFetchBrandGpsrMock,
  lookupGpsrViaGemini: vi.fn(async () => null),
  readBrandGpsrCache: vi.fn(async () => null),
  writeBrandGpsrCache: vi.fn(async () => {}),
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const { enrichProductForKaufland } = require('../../services/kaufland-attribute-enricher');

const GEMINI_GPSR = {
  manufacturer_name: 'GANT International GmbH',
  manufacturer_address: 'Frankfurter Str. 12',
  manufacturer_city: 'Eschborn',
  manufacturer_postalcode: '65760',
  country_code: 'DE',
  email: 'info-de@gant.com',
  url: 'https://www.gant.de',
};

beforeEach(() => {
  lookupGpsrFromWebMock.mockReset();
  callGeminiVisionMock.mockReset();
  getOrFetchBrandGpsrMock.mockReset();
  getOrFetchBrandGpsrMock.mockResolvedValue(null);
  lookupGpsrFromWebMock.mockResolvedValue(null);
});

describe('gpsr-gemini-Tier — Beleg-Gate', () => {
  it('lehnt Alt-Cache-Ergebnisse OHNE evidence ab (cached:true — die Audit-Quelle)', async () => {
    getOrFetchBrandGpsrMock.mockResolvedValueOnce({
      gpsr: { ...GEMINI_GPSR },
      confidence: 0.9,
      source: 'gemini-googleSearch',
      cached: true, // Alt-Cache-Eintrag, geschrieben VOR der Beleg-Pflicht
    });
    const product = {
      id: 'p1',
      identification: { name: 'GANT Shirt', brand: 'GANT' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);
    expect(out.enrichedFields).not.toContain('gpsr-gemini');
    expect(out.enriched.details.gpsr.manufacturer_name).toBeUndefined();
    expect(out.errors.some((e) => /gpsr-gemini/.test(e))).toBe(true);
  });

  it('lehnt Ergebnisse mit evidence.status unverifiable ab', async () => {
    getOrFetchBrandGpsrMock.mockResolvedValueOnce({
      gpsr: { ...GEMINI_GPSR },
      confidence: 0.3,
      source: 'gemini-googleSearch',
      cached: false,
      unverified: true,
      evidence: { status: 'unverifiable', url: null, checked_at: '2026-07-16T00:00:00.000Z' },
    });
    const product = {
      id: 'p1',
      identification: { name: 'GANT Shirt', brand: 'GANT' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);
    expect(out.enrichedFields).not.toContain('gpsr-gemini');
    expect(out.enriched.details.gpsr.manufacturer_name).toBeUndefined();
    expect(out.errors.some((e) => /gpsr-gemini.*unverifiable/.test(e))).toBe(true);
  });

  it('uebernimmt verified-Ergebnisse und schreibt die Beleg-Metadaten mit', async () => {
    getOrFetchBrandGpsrMock.mockResolvedValueOnce({
      gpsr: { ...GEMINI_GPSR },
      confidence: 0.9,
      source: 'gemini-googleSearch',
      cached: false,
      evidence: {
        status: 'verified',
        url: 'https://www.gant.de/impressum',
        checked_at: '2026-07-16T00:00:00.000Z',
        method: 'direct',
      },
    });
    const product = {
      id: 'p1',
      identification: { name: 'GANT Shirt', brand: 'GANT' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);
    expect(out.enrichedFields).toContain('gpsr-gemini');
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('GANT International GmbH');
    expect(out.enriched.details.gpsr.evidence).toEqual(expect.objectContaining({
      status: 'verified',
      url: 'https://www.gant.de/impressum',
      source: 'gemini-lookup',
    }));
    // verified + komplett → kein Web-Fallback mehr noetig
    expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
  });

  it('uebernimmt partial-Ergebnisse (Name belegt, Adresse nicht)', async () => {
    getOrFetchBrandGpsrMock.mockResolvedValueOnce({
      gpsr: { ...GEMINI_GPSR },
      confidence: 0.7,
      source: 'gemini-googleSearch',
      cached: false,
      evidence: { status: 'partial', url: 'https://www.gant.de/impressum', checked_at: '2026-07-16T00:00:00.000Z' },
    });
    const product = {
      id: 'p1',
      identification: { name: 'GANT Shirt', brand: 'GANT' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact']);
    expect(out.enrichedFields).toContain('gpsr-gemini');
    expect(out.enriched.details.gpsr.evidence.status).toBe('partial');
  });
});

describe('brandGpsrMap-Tier — Beleg-Gate', () => {
  const SOURCE_GPSR = {
    manufacturer_name: 'Anker Innovations Deutschland GmbH',
    manufacturer_address: 'Georg-Muche-Straße 3',
    manufacturer_city: 'München',
    manufacturer_postalcode: '80807',
    country_code: 'DE',
    email: 'support@anker.com',
  };

  it('blockiert die verified-lose Kopie, wenn das Ziel eine EIGENE manufacturer_name hat', async () => {
    const brandGpsrMap = new Map();
    brandGpsrMap.set('anker', { score: 11, fromSku: 'SKU-1', gpsr: { ...SOURCE_GPSR } });
    const product = {
      id: 'p1',
      identification: { name: 'Anker Charger', brand: 'Anker' },
      // Echte (von der Brand abweichende) Herstellerangabe → darf nicht
      // von einer unbelegten Geschwister-Kopie ueberformt werden.
      details: { gpsr: { manufacturer_name: 'Original Hersteller GmbH' } },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact'], { brandGpsrMap });
    expect(out.enrichedFields).not.toContain('gpsr-brand');
    expect(out.enriched.details.gpsr).toEqual({ manufacturer_name: 'Original Hersteller GmbH' });
    expect(out.errors.some((e) => /gpsr-brand/.test(e))).toBe(true);
  });

  it('kopiert auf Ziel OHNE manufacturer_name, markiert aber inherited_unverified', async () => {
    const brandGpsrMap = new Map();
    brandGpsrMap.set('anker', { score: 11, fromSku: 'SKU-9303003754', gpsr: { ...SOURCE_GPSR } });
    const product = {
      id: 'p1',
      identification: { name: 'Anker Charger', brand: 'Anker' },
      details: { gpsr: {} },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact'], { brandGpsrMap });
    expect(out.enrichedFields).toContain('gpsr-brand');
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('Anker Innovations Deutschland GmbH');
    expect(out.enriched.details.gpsr.evidence).toEqual({
      status: 'inherited_unverified',
      fromSku: 'SKU-9303003754',
    });
  });

  it('kopiert mit verified-Quelle auch auf Ziele mit eigener manufacturer_name (existing-wins) und vererbt den Beleg', async () => {
    const brandGpsrMap = new Map();
    brandGpsrMap.set('anker', {
      score: 11,
      fromSku: 'SKU-2',
      gpsr: {
        ...SOURCE_GPSR,
        evidence: {
          status: 'verified',
          url: 'https://www.anker.com/de/impressum',
          checked_at: '2026-07-16T00:00:00.000Z',
        },
      },
    });
    const product = {
      id: 'p1',
      identification: { name: 'Anker Charger', brand: 'Anker' },
      details: { gpsr: { manufacturer_name: 'Original Hersteller GmbH' } },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact'], { brandGpsrMap });
    expect(out.enrichedFields).toContain('gpsr-brand');
    // Existing gewinnt weiterhin
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('Original Hersteller GmbH');
    expect(out.enriched.details.gpsr.manufacturer_address).toBe('Georg-Muche-Straße 3');
    expect(out.enriched.details.gpsr.evidence).toEqual({
      status: 'inherited_verified',
      fromSku: 'SKU-2',
      url: 'https://www.anker.com/de/impressum',
      checked_at: '2026-07-16T00:00:00.000Z',
    });
  });

  it('Brand-Echo als manufacturer_name (Erfindungs-Artefakt) zaehlt NICHT als echte Herstellerangabe', async () => {
    const brandGpsrMap = new Map();
    brandGpsrMap.set('anker', { score: 11, fromSku: 'SKU-3', gpsr: { ...SOURCE_GPSR } });
    const product = {
      id: 'p1',
      identification: { name: 'Anker Charger', brand: 'Anker' },
      // manufacturer_name === brand: Artefakt des alten brand-Fallbacks
      details: { gpsr: { manufacturer_name: 'Anker' } },
    };
    const out = await enrichProductForKaufland(product, ['product_safety_contact'], { brandGpsrMap });
    expect(out.enrichedFields).toContain('gpsr-brand');
    // Existing-wins bleibt erhalten, aber die Kopie ist als unverified markiert
    expect(out.enriched.details.gpsr.manufacturer_name).toBe('Anker');
    expect(out.enriched.details.gpsr.manufacturer_address).toBe('Georg-Muche-Straße 3');
    expect(out.enriched.details.gpsr.evidence.status).toBe('inherited_unverified');
  });
});
