'use strict';

// REGRESSION GUARD — Incident 2026-07-16: US-Produkte (Funko, 12-stellige
// UPCs) hingen dauerhaft im pending-Zustand (healed=0 über Tage):
//
//   1. pickUnitData padded UPC-12 → EAN-13 beim Unit-Create, aber ALLE
//      anderen EAN-Pfade nutzten die rohe 12-stellige Form: die Status-
//      Abfragen des Heal-Loops liefen ins 404 ("Product Data not found"),
//      normalizeProductDataEans verwarf die EAN still → tryRepair meldete
//      "ean is required" und resubmittete nie.
//   2. tryRepairKauflandProductData starb am ungesicherten PATCH (404 bei
//      nicht-existentem Datensatz), BEVOR sein PUT-Fallback greifen konnte.
//
// Live-Beweis: PUT mit gepaddeter EAN 0889698608299 → sofort ready:true.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

const { toKauflandEan } = require('../lib/kaufland-api');

describe('toKauflandEan — UPC-12 wird auf EAN-13 gepadded', () => {
  it('padded 12-stellige UPCs mit führender 0', () => {
    expect(toKauflandEan('889698608299')).toBe('0889698608299');
    expect(toKauflandEan('442922550988')).toBe('0442922550988');
  });

  it('lässt EAN-13/GTIN-14 unverändert', () => {
    expect(toKauflandEan('4046806150866')).toBe('4046806150866');
    expect(toKauflandEan('04046806150866')).toBe('04046806150866');
  });

  it('strippt Nicht-Ziffern und ist defensiv bei leerem Input', () => {
    expect(toKauflandEan(' 889698-608299 ')).toBe('0889698608299');
    expect(toKauflandEan('')).toBe('');
    expect(toKauflandEan(null)).toBe('');
  });
});

describe('tryRepairKauflandProductData — UPC-Padding + PATCH-404-Robustheit', () => {
  it('padded die EAN und erreicht den PUT-Fallback auch wenn PATCH wirft', async () => {
    const calls = { status: [], patch: [], put: [], getData: [] };
    patchCjsModule('../lib/kaufland-api', {
      toKauflandEan: (v) => {
        const d = String(v || '').replace(/\D+/g, '');
        return d.length === 12 ? '0' + d : d;
      },
      getProductDataStatus: async (ean) => {
        calls.status.push(ean);
        const err = new Error('Product Data not found');
        err.status = 404;
        throw err;
      },
      getProductData: async (ean) => {
        calls.getData.push(ean);
        // vor dem PUT: kein Datensatz; nach dem PUT: vorhanden
        if (!calls.put.length) { const e = new Error('not found'); e.status = 404; throw e; }
        return { ean: [ean], attributes: { title: ['x'] } };
      },
      patchProductData: async ({ ean }) => {
        calls.patch.push(ean);
        const err = new Error('Product Data not found');
        err.status = 404;
        throw err; // GENAU der Fehler der tryRepair früher tötete
      },
      putProductData: async ({ ean }) => { calls.put.push(ean); return {}; },
      getProductByEan: async () => null,
      decideCategory: async () => [],
    });
    // Whitelist-Lookup neutralisieren (kein Firestore im Test)
    patchCjsModule('../lib/kaufland-manufacturer-whitelist', {
      findManufacturerInWhitelist: async () => ({ found: false, source: 'test', total: 0 }),
    });
    delete require.cache[require.resolve('../services/kaufland-product-data-repair')];
    const { tryRepairKauflandProductData } = require('../services/kaufland-product-data-repair');

    const result = await tryRepairKauflandProductData({
      product: {
        id: 'p-upc-1',
        identification: { name: 'Funko Pop! Tom Brady', sku: 'SKU-UPC-1' },
        details: { identifiers: { ean: '889698608299' }, description: 'Sammelfigur aus Vinyl, ca. 9 cm.' },
      },
      ean: '889698608299',
      storefront: 'de',
    });

    expect(result.attempted).toBe(true);
    // Alle Kaufland-Calls liefen mit der GEPADDETEN EAN (Status: vorher+nachher)
    expect(calls.status.length).toBeGreaterThanOrEqual(1);
    expect(calls.status.every((e) => e === '0889698608299')).toBe(true);
    expect(calls.patch).toEqual([['0889698608299']]);
    // PATCH warf 404 → PUT-Fallback lief trotzdem (vorher: Abbruch)
    expect(calls.put).toEqual([['0889698608299']]);
    expect(result.message).toContain('patch+put');
    expect(result.message).toContain('PATCH-Fehler');
  });
});
