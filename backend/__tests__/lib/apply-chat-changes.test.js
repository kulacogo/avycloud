'use strict';

// TDD for backend/lib/apply-chat-changes.js
// Ports the frontend applyAssistantChange mapping to the backend so a bulk job
// can apply the FULL chat datasheet (title, price, gpsr, attributes, description,
// weight) onto a product. NEVER touches inventory/sku/storage; NEVER changes
// category; title is brand-first protected.

const { applyChatChangesToProduct } = require('../../lib/apply-chat-changes');

function baseProduct(over = {}) {
  return {
    id: 'p1',
    identification: { sku: 'SKU-1', name: 'Alt Titel', brand: 'BelleMax', category: 'Garten > Sonnenschutz > Markisen', barcodes: [] },
    inventory: { quantity: 7 },
    storage: { zone: 'A' },
    storageBins: [{ bin: 'X1', qty: 7 }],
    details: {
      categoryId: '180992',
      short_description: 'kurz',
      key_features: [],
      attributes: { Marke: 'BelleMax', Farbe: 'Anthrazit' },
      gpsr: { manufacturer_name: 'Alt GmbH' },
      pricing: {},
    },
    ops: {},
    ...over,
  };
}

describe('applyChatChangesToProduct', () => {
  it('applies the title (brand-first) and never touches inventory/sku/storage', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { title: 'BelleMax Seitenmarkise 300x160 cm Anthrazit Sichtschutz Balkon Windschutz' },
    ]);
    expect(product.identification.name).toMatch(/^BelleMax /);
    expect(changed).toContain('title');
    expect(product.inventory).toEqual({ quantity: 7 });
    expect(product.identification.sku).toBe('SKU-1');
    expect(product.storageBins).toEqual([{ bin: 'X1', qty: 7 }]);
  });

  it('prepends brand when the chat title dropped it', () => {
    const { product } = applyChatChangesToProduct(baseProduct(), [{ title: 'Seitenmarkise Anthrazit 300x160 cm Sichtschutz' }]);
    expect(product.identification.name.toLowerCase().startsWith('bellemax')).toBe(true);
  });

  it('merges attributes (object), keeping existing values', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { attributes: { Produktart: 'Seitenmarkise', Material: 'Polyester' } },
    ]);
    expect(product.details.attributes.Produktart).toBe('Seitenmarkise');
    expect(product.details.attributes.Marke).toBe('BelleMax'); // existing kept
    expect(product.details.attributes.Material).toBe('Polyester');
    expect(changed).toContain('attributes');
  });

  it('stores a researched price as lowest_price with a source URL (not sellPrice)', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { pricing: { amount: 119.95, currency: 'EUR', source_url: 'https://hersteller.de/markise' } },
    ]);
    expect(product.details.pricing.lowest_price.amount).toBe(119.95);
    expect(product.details.pricing.lowest_price.currency).toBe('EUR');
    expect(product.details.pricing.lowest_price.sources.some((s) => s.url)).toBe(true);
    expect(changed).toContain('pricing');
  });

  it('merges gpsr and sets description + key_features', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { short_description: 'x'.repeat(400), key_features: ['a', 'b', 'c'], gpsr: { email: 'info@hersteller.de' } },
    ]);
    expect(product.details.short_description.length).toBe(400);
    expect(product.details.key_features).toEqual(['a', 'b', 'c']);
    expect(product.details.gpsr.email).toBe('info@hersteller.de');
    expect(product.details.gpsr.manufacturer_name).toBe('Alt GmbH'); // existing kept
    expect(changed).toEqual(expect.arrayContaining(['description', 'gpsr', 'key_features']));
  });

  it('maps weight_grams to details.weight (kg) and the Gewicht attribute', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [{ weight_grams: 13500 }]);
    expect(product.details.weight).toBe(13.5);
    expect(changed).toContain('weight');
  });

  it('does NOT change the category (protected) even if proposed', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { categoryId: '999', categoryPath: 'Falsche > Kategorie', identity: { category: 'Falsche > Kategorie' } },
    ]);
    expect(product.details.categoryId).toBe('180992'); // unchanged
    expect(product.identification.category).toBe('Garten > Sonnenschutz > Markisen'); // unchanged
    expect(changed).not.toContain('category');
  });

  it('applies multiple datasheetChanges in order', () => {
    const { product, changed } = applyChatChangesToProduct(baseProduct(), [
      { title: 'BelleMax Seitenmarkise 300x160 cm Anthrazit' },
      { attributes: { Produktart: 'Seitenmarkise' } },
      { pricing: { amount: 100, currency: 'EUR', source_url: 'https://x.de' } },
    ]);
    expect(product.identification.name).toMatch(/^BelleMax/);
    expect(product.details.attributes.Produktart).toBe('Seitenmarkise');
    expect(product.details.pricing.lowest_price.amount).toBe(100);
    expect(changed).toEqual(expect.arrayContaining(['title', 'attributes', 'pricing']));
  });

  it('does NOT shorten an already-good description (keeps the longer existing one)', () => {
    const p = baseProduct();
    p.details.short_description = 'x'.repeat(1400);
    const { product, changed } = applyChatChangesToProduct(p, [{ short_description: 'kurz aber neu, viel zu wenig Inhalt hier drin' }]);
    expect(product.details.short_description.length).toBe(1400);
    expect(changed).not.toContain('description');
  });

  it('replaces a too-short existing description', () => {
    const p = baseProduct();
    p.details.short_description = 'zu kurz';
    const longNew = 'y'.repeat(400);
    const { product, changed } = applyChatChangesToProduct(p, [{ short_description: longNew }]);
    expect(product.details.short_description).toBe(longNew);
    expect(changed).toContain('description');
  });

  it('returns no changes for empty proposals', () => {
    const { changed } = applyChatChangesToProduct(baseProduct(), []);
    expect(changed).toEqual([]);
  });
});

// ─── GPSR Etikett-Quelle: Rollen-Block ersetzen, stale Falschwerte weg (2026-07-17) ──
describe('applyChatChangesToProduct — GPSR image-sourced role replace', () => {
  const { applyChatChangesToProduct } = require('../../lib/apply-chat-changes');

  function productWithStaleGpsr() {
    return {
      id: 'p1',
      identification: { sku: 'SKU-1', name: 'X', brand: 'X' },
      details: {
        attributes: {},
        gpsr: {
          // Alt-Müll: EU-REP-PLZ + Chinesen-Telefon beim Hersteller hängen
          manufacturer_name: 'Gr4tec',
          manufacturer_postalcode: '69-100',
          manufacturer_phone: '+8675523736321',
          eu_responsible_name: 'eVatmaster Consulting GmbH',
          eu_responsible_address: 'Raiffeisenstr. 2 B11',
          eu_responsible_country: 'Germany',
        },
      },
    };
  }

  it('Etikett-Quelle: alter manufacturer_*-Block wird ersetzt (stale postalcode/phone weg)', () => {
    const change = {
      gpsr: {
        manufacturer_name: 'Guangzhou Yuanshi Technology Co., Ltd.',
        manufacturer_address: '106 Fengze East Road, Nansha District, Guangzhou',
        eu_responsible_name: 'Pro Logistik SP. Zo.o',
        eu_responsible_address: 'Mickiewicza 21/10, 69-100 Slubice',
        eu_responsible_country: 'Poland',
      },
      gpsr_evidence_check: { outcome: 'product_image' },
    };
    const { product } = applyChatChangesToProduct(productWithStaleGpsr(), [change]);
    const g = product.details.gpsr;
    expect(g.manufacturer_name).toBe('Guangzhou Yuanshi Technology Co., Ltd.');
    // Stale Hersteller-Felder sind WEG (nicht mehr additiv überlebt):
    expect(g.manufacturer_postalcode).toBeUndefined();
    expect(g.manufacturer_phone).toBeUndefined();
    // EU-REP komplett ersetzt (kein eVatmaster mehr):
    expect(g.eu_responsible_name).toBe('Pro Logistik SP. Zo.o');
    expect(g.eu_responsible_country).toBe('Poland');
    expect(JSON.stringify(g)).not.toContain('eVatmaster');
  });

  it('OHNE image-source: additiver Merge unverändert (kein Datenverlust)', () => {
    const change = {
      gpsr: { manufacturer_name: 'Neuer Name' }, // kein gpsr_evidence_check
    };
    const { product } = applyChatChangesToProduct(productWithStaleGpsr(), [change]);
    const g = product.details.gpsr;
    expect(g.manufacturer_name).toBe('Neuer Name');
    // Alt-Felder bleiben (altes additives Verhalten, nur ohne Etikett-Autorität)
    expect(g.manufacturer_postalcode).toBe('69-100');
  });
});

describe('pricing.sellPrice — Gap-Füllung, nie überschreiben (Incident 2026-07-18)', () => {
  it('setzt sellPrice, wenn Produkt keinen Verkaufspreis hat', () => {
    const { product } = applyChatChangesToProduct(baseProduct(), [{ pricing: { sellPrice: 499, amount: 499 } }]);
    expect(product.details.pricing.sellPrice).toBe(499);
    // Marktpreis-Recherche landet weiter in lowest_price
    expect(product.details.pricing.lowest_price.amount).toBe(499);
  });

  it('überschreibt einen bestehenden (menschlich gesetzten) sellPrice NIE', () => {
    const p = baseProduct();
    p.details.pricing = { sellPrice: 350 };
    const { product } = applyChatChangesToProduct(p, [{ pricing: { sellPrice: 499 } }]);
    expect(product.details.pricing.sellPrice).toBe(350);
  });
});
