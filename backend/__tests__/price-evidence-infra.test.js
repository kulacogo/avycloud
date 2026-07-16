/**
 * Infrastruktur-Ausfall vs. echte Nicht-Verifizierbarkeit (Incident 2026-07-16).
 *
 * Der BrightData-Token war seit ~April tot (401) — JEDER Seiten-Abruf scheiterte,
 * der Validator brandmarkte daraufhin auch korrekte Quellen als "UNBELEGT" und
 * der Chat lieferte widersprüchliche Antworten ("übernommen" + "UNBELEGT").
 * Seitdem gilt: Abruf-Ausfall (0/401/403/407/408/429/5xx, Netz-Exception) ist
 * KEIN Urteil über den Beleg — 404/410 dagegen schon (Incident 2026-07-11:
 * erfundene 404-Herstellerseite MUSS unbelegt bleiben).
 *
 * PURE-API — kein Netz, fetchPage wird injiziert.
 */

const {
  isInfraFetchFailure,
  verifyPriceSources,
  validatePricingProposal,
} = require('../lib/price-evidence');

const PRODUCT = {
  identification: { name: 'HOMEDEMO Klemmmarkise 300x150cm Anthrazit', brand: 'HOMEDEMO' },
  details: { identifiers: { mpn: '65858' } },
};

const PADDING = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat. '.repeat(3);
const PAGE_OFF_TOPIC = `Silikon Schutzhülle kompatibel zum Smartphone, stoßfest, transparent. Jetzt reduziert: 61,99 € statt regulär. ${PADDING}`;

function pricingWith(urls) {
  return {
    lowest_price: {
      amount: 105.99,
      currency: 'EUR',
      sources: urls.map((url, i) => ({ name: `Quelle ${i + 1}`, url, price: 105.99 })),
    },
    price_confidence: 0.9,
  };
}

describe('isInfraFetchFailure', () => {
  it.each([[0], [401], [403], [407], [408], [429], [500], [503]])(
    'Status %d → Infrastruktur-Fehler (kein Urteil über den Beleg)',
    (status) => {
      expect(isInfraFetchFailure(status)).toBe(true);
    }
  );

  it.each([[200], [404], [410]])('Status %d → KEIN Infrastruktur-Fehler', (status) => {
    expect(isInfraFetchFailure(status)).toBe(false);
  });
});

describe('verifyPriceSources — infra-Tagging', () => {
  it('401-Fetch (toter Unlocker-Token) → failed mit infra:true', async () => {
    const fetchPage = vi.fn(async () => ({ ok: false, status: 401, text: '' }));
    const { failed } = await verifyPriceSources({
      sources: [{ url: 'https://shop.example.de/produkt', price: 105.99 }],
      product: PRODUCT,
      fetchPage,
    });
    expect(failed).toHaveLength(1);
    expect(failed[0].infra).toBe(true);
    expect(failed[0].reason).toBe('fetch_failed_401');
  });

  it('werfender Fetch (Netz-Exception) → infra:true', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('socket hang up'); });
    const { failed } = await verifyPriceSources({
      sources: [{ url: 'https://shop.example.de/produkt', price: 105.99 }],
      product: PRODUCT,
      fetchPage,
    });
    expect(failed[0].infra).toBe(true);
  });

  it('404 → infra NICHT gesetzt (Evidenz GEGEN die Quelle, Incident 2026-07-11)', async () => {
    const fetchPage = vi.fn(async () => ({ ok: false, status: 404, text: '' }));
    const { failed } = await verifyPriceSources({
      sources: [{ url: 'https://hersteller.example.de/erfunden', price: 61.99 }],
      product: PRODUCT,
      fetchPage,
    });
    expect(failed[0].infra).toBe(false);
  });
});

describe('validatePricingProposal — Infra-Ehrlichkeit', () => {
  it('ALLE Kandidaten scheitern am Abruf (503/401) → infraFailure, ehrliche Note statt UNBELEGT', async () => {
    const fetchPage = vi.fn(async (url) => ({ ok: false, status: url.includes('amazon') ? 503 : 401, text: '' }));
    const res = await validatePricingProposal({
      pricing: pricingWith(['https://www.amazon.de/dp/B0TEST', 'https://shop.example.de/produkt']),
      product: PRODUCT,
      fetchPage,
    });
    expect(res.infraFailure).toBe(true);
    expect(res.note).toContain('technisch nicht geprüft');
    expect(res.note).not.toContain('UNBELEGT');
    expect(res.pricing.lowest_price.evidence_check.outcome).toBe('fetch_infrastructure_failure');
    expect(res.pricing.lowest_price.evidence_check.unchecked_urls).toHaveLength(2);
    // Fail-closed bleibt: keine unverifizierten Quellen durchreichen, Confidence deckeln.
    expect(res.pricing.lowest_price.sources).toEqual([]);
    expect(res.pricing.price_confidence).toBeLessThanOrEqual(0.3);
  });

  it('404 → weiterhin UNBELEGT, infraFailure=false (Regression Incident 2026-07-11)', async () => {
    const fetchPage = vi.fn(async () => ({ ok: false, status: 404, text: '' }));
    const res = await validatePricingProposal({
      pricing: pricingWith(['https://hersteller.example.de/erfunden']),
      product: PRODUCT,
      fetchPage,
    });
    expect(res.infraFailure).toBe(false);
    expect(res.note).toContain('UNBELEGT');
    expect(res.pricing.lowest_price.evidence_check.outcome).toBe('unverified');
  });

  it('Mischfall infra(503) + Content-Fail (Seite themenfremd) → UNBELEGT, infraFailure=false', async () => {
    const fetchPage = vi.fn(async (url) =>
      url.includes('amazon')
        ? { ok: false, status: 503, text: '' }
        : { ok: true, status: 200, text: PAGE_OFF_TOPIC }
    );
    const res = await validatePricingProposal({
      pricing: pricingWith(['https://www.amazon.de/dp/B0TEST', 'https://shop.example.de/falsches-produkt']),
      product: PRODUCT,
      fetchPage,
    });
    expect(res.infraFailure).toBe(false);
    expect(res.note).toContain('UNBELEGT');
  });

  it('Mischfall infra(0) + 404 → UNBELEGT (404 ist kein Infra-Fehler)', async () => {
    const fetchPage = vi.fn(async (url) =>
      url.includes('tot') ? { ok: false, status: 0, text: '' } : { ok: false, status: 404, text: '' }
    );
    const res = await validatePricingProposal({
      pricing: pricingWith(['https://tot.example.de/produkt', 'https://hersteller.example.de/erfunden']),
      product: PRODUCT,
      fetchPage,
    });
    expect(res.infraFailure).toBe(false);
    expect(res.note).toContain('UNBELEGT');
  });
});
