'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// Regression coverage for the chat "Kategorie-Korrektur" bug (2026-06-24):
// the assistant proposed a category in prose ("Sammeln & Seltenes > Figuren >
// Action-Figuren") but the structured change never set details.categoryId, so
// applying the change left the wrong category in place. Two compounding causes:
//   1. findEbayCategory() cannot match an approximate/LLM breadcrumb -> dropped.
//   2. consolidateChanges() strips the top-level categoryId before it ships.
// resolveProposedCategoryForChanges() is the post-processing step that resolves
// a proposed category to a real eBay categoryId (strict local match first, then
// the existing robust resolveCategoryV2) and attaches it to the change.

const {
  resolveProposedCategoryForChanges,
} = require('../../services/category-resolver');

const FUNKO_PRODUCT = {
  tenantId: 'default',
  identification: {
    name: 'Funko Pop! Rocks Queen Freddie Mercury #184 Platinum Metallic Figur & Pin',
    brand: 'Funko',
    category: 'Bastel- & Künstlerbedarf > Bastelmaterialien > Bastelpapier > Bastel- & Metallicfolie',
    barcodes: ['889698689533'],
  },
  details: { categoryId: '183183', categorySource: 'auto:local' },
};

const throwingResolver = () => {
  throw new Error('robust resolver must NOT be called in this scenario');
};

describe('resolveProposedCategoryForChanges', () => {
  test('attaches a real categoryId via the local strict match without calling the robust resolver', async () => {
    let resolverCalled = false;
    const change = {
      summary: 'Kategorie korrigiert',
      identity: { category: 'Sammeln & Seltenes > Figuren & Statuen > Sammelfiguren & Zubehör' },
    };

    await resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, {
      resolver: async () => {
        resolverCalled = true;
        return null;
      },
    });

    expect(resolverCalled).toBe(false);
    expect(change.categoryId).toMatch(/^\d+$/);
    expect(change.categoryPath).toContain('Figuren & Statuen');
    expect(change.identity.category).toContain('Figuren & Statuen');
  });

  test('falls back to the robust resolver when the local strict match fails, and attaches its result', async () => {
    let calledWith = null;
    const change = {
      summary: 'Kategorie korrigiert',
      identity: { category: 'Sammeln & Seltenes > Figuren > Action-Figuren' },
    };

    await resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, {
      resolver: async (product) => {
        calledWith = product;
        return {
          categoryId: '261068',
          breadcrumb: 'Spielzeug > Action-Figuren & Zubehör > Action- & Spielfiguren',
          source: 'suggestions',
          confidence: 0.85,
        };
      },
    });

    expect(change.categoryId).toBe('261068');
    expect(change.categoryPath).toBe('Spielzeug > Action-Figuren & Zubehör > Action- & Spielfiguren');
    expect(change.identity.category).toBe('Spielzeug > Action-Figuren & Zubehör > Action- & Spielfiguren');
    // The resolver receives a product whose category reflects the proposal so the
    // suggestion/local tiers can act on the assistant's intent (not the stale one).
    expect(calledWith).toBeTruthy();
    expect(calledWith.identification.category).toBe('Sammeln & Seltenes > Figuren > Action-Figuren');
  });

  test('drops the unverified breadcrumb and records a warning when nothing resolves', async () => {
    const change = {
      summary: 'Kategorie korrigiert',
      identity: { category: 'Voll Erfundene Kategorie Ohne Treffer' },
    };

    await resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, {
      resolver: async () => null,
    });

    expect(change.categoryId).toBeUndefined();
    expect(change.categoryPath).toBeUndefined();
    expect(change.identity.category).toBeUndefined();
    const warnings = (change.notes && change.notes.warnings) || [];
    expect(warnings.some((w) => /Kategorie/i.test(w))).toBe(true);
  });

  test('never throws when the robust resolver rejects — degrades to drop + warning', async () => {
    const change = { identity: { category: 'Sammeln & Seltenes > Figuren > Action-Figuren' } };

    await expect(
      resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, {
        resolver: async () => {
          throw new Error('eBay taxonomy API down');
        },
      }),
    ).resolves.toBeTruthy();

    expect(change.categoryId).toBeUndefined();
    expect(change.identity.category).toBeUndefined();
  });

  test('leaves changes without a proposed category untouched and does not call the resolver', async () => {
    const change = { title: 'Neuer Titel', short_description: 'foo' };

    await resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, { resolver: throwingResolver });

    expect(change).toEqual({ title: 'Neuer Titel', short_description: 'foo' });
  });

  test('skips resolution when a numeric categoryId is already present on the change', async () => {
    const change = { categoryId: '139973', identity: { category: 'Whatever > Path' } };

    await resolveProposedCategoryForChanges([change], FUNKO_PRODUCT, { resolver: throwingResolver });

    expect(change.categoryId).toBe('139973');
  });
});

// ─── Confidence-Gate (Incident 2026-07-16: Cornhole → "PC- & Videospiele") ───
// resolveCategoryV2 liefert auch UNTERHALB des Accept-Thresholds den besten
// Kandidaten (best_below_threshold). Ohne Gate wurde ein 0.4-Ratekandidat zur
// autoritativen Kategorie auf der Übernehmen-Karte und beim Apply als
// categorySource='manual' zementiert.

describe('resolveProposedCategoryForChanges — Confidence-Gate', () => {
  const PRODUCT = {
    tenantId: 'default',
    identification: { name: 'Decathlon Cornhole Game Standard', brand: 'Decathlon' },
    details: { categoryId: '261823', categorySource: 'auto:local' },
  };

  test('Kandidat UNTER dem Threshold (conf 0.4) wird verworfen + Warnung, kein categoryId-Attach', async () => {
    const change = { summary: 'Kategorie korrigiert', categoryPath: 'Fantasiewelt > Wurfdinge > Bohnensack-Zielwurf' };
    await resolveProposedCategoryForChanges([change], PRODUCT, {
      resolver: async () => ({ categoryId: '139973', breadcrumb: 'PC- & Videospiele > PC- & Videospiele', confidence: 0.4 }),
    });
    expect(change.categoryId).toBeUndefined();
    expect(change.categoryPath).toBeUndefined();
    const warnings = (change.notes && change.notes.warnings) || [];
    expect(warnings.join(' ')).toContain('konnte keiner gültigen eBay-Kategorie zugeordnet werden');
  });

  test('Kandidat ÜBER dem Threshold (conf 0.9) wird angehängt', async () => {
    const change = { summary: 'Kategorie korrigiert', categoryPath: 'Fantasiewelt > Draussenzeug > Zielwurf' };
    await resolveProposedCategoryForChanges([change], PRODUCT, {
      resolver: async () => ({ categoryId: '22148', breadcrumb: 'Spielzeug > Spielzeug für draußen > Sonstige', confidence: 0.9 }),
    });
    expect(change.categoryId).toBe('22148');
  });

  test('opts.minConfidence überschreibt den Default-Threshold', async () => {
    const change = { summary: 'x', categoryPath: 'Fantasiewelt > Spielkram' };
    await resolveProposedCategoryForChanges([change], PRODUCT, {
      minConfidence: 0.3,
      resolver: async () => ({ categoryId: '22148', breadcrumb: 'Spielzeug > Spielzeug für draußen > Sonstige', confidence: 0.4 }),
    });
    expect(change.categoryId).toBe('22148');
  });

  test('Resolver-Ergebnis ohne confidence-Feld zählt als 0 → verworfen', async () => {
    const change = { summary: 'x', categoryPath: 'Irgendwas' };
    await resolveProposedCategoryForChanges([change], PRODUCT, {
      resolver: async () => ({ categoryId: '139973', breadcrumb: 'PC- & Videospiele > PC- & Videospiele' }),
    });
    expect(change.categoryId).toBeUndefined();
  });
});

describe('Gemini-Strategie-Reparatur (Export-Regression)', () => {
  test('enrichment.js exportiert resolveCategoryWithGemini (Strategie 4 starb sonst mit "is not a function")', () => {
    const enrichment = require('../../services/enrichment');
    expect(typeof enrichment.resolveCategoryWithGemini).toBe('function');
  });
});
