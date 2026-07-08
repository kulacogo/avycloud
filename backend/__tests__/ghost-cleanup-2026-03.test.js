// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Kern-Logik des Geister-Cleanups (Incident 2026-03-23: 206 leere Hüllen aus
// den Dual-Write-Bugs BUG-084/085). Getestet werden die puren Funktionen —
// Klassifikation (restore/delete/skip) und der Restore-Payload (Whitelist,
// keine BaseLinker-/Listing-/Bestands-Felder).

const {
  isInertGhost,
  legacyHasContent,
  buildRestorePayload,
  classifyGhost,
} = require('../scripts/cleanup-ghost-products-2026-03');

// Echte Produktions-Form (products_v2/fab309b3-…, gekürzt)
function emptyShell(overrides = {}) {
  return {
    id: 'fab309b3-784b-4e9a-861b-a53eca92313d',
    tenantId: 'default',
    identification: { name: '', category: '', sku: 'SKU-1341452362' },
    details: {
      identifiers: { sku: 'SKU-1341452362' },
      short_description: '',
      description: '',
      attributes: {},
      images: [],
      key_features: [],
    },
    inventory: { quantity: 0 },
    storage: null,
    storageBins: [],
    ops: { listingStatus: { ebay: null, kaufland: null }, pending_intake_quantity: 0 },
    ...overrides,
  };
}

function legacyDoc() {
  return {
    id: 'SKU-0058749943',
    identification: {
      name: 'WMF Knuddel Kinderbesteck-Set 3201002485',
      brand: 'WMF',
      category: 'Baby > Ernährung > Kinderbesteck',
      barcodes: ['4000530351531'],
      method: 'barcode',
      confidence: 0.82,
      sku: 'SKU-0058749943',
    },
    details: {
      description: '',
      short_description: '<p>Das WMF Kinderbesteck-Set…</p>',
      key_features: ['Sicherer Halt'],
      attributes: { Marke: 'WMF' },
      identifiers: { ean: '4000530351531', gtin: '4000530351531', mpn: '3201002485', sku: 'SKU-0058749943' },
      images: [{ url_or_base64: 'https://storage.googleapis.com/x/1.png' }],
      gpsr: { manufacturer_name: 'WMF' },
      pricing: { lowest_price: { amount: 34.95, currency: 'EUR' } },
      weight: 0.15,
      baselinkerCategoryPath: 'Baby > …',
    },
    ops: { baselinker: { product_id: 463190152 } },
    marketplace: { ebay: { itemId: '389682056566' } },
    inventory: { quantity: 1 },
  };
}

describe('ghost-cleanup: isInertGhost', () => {
  it('echte leere Hülle → inert', () => {
    expect(isInertGhost(emptyShell())).toBe(true);
  });

  it('Platzhalter-Name "Unbekanntes Produkt" ohne Inhalt → inert', () => {
    const g = emptyShell();
    g.identification.name = 'Unbekanntes Produkt';
    expect(isInertGhost(g)).toBe(true);
  });

  it.each([
    ['echter Name', (g) => { g.identification.name = 'Bosch GSR 18V'; }],
    ['Bestand > 0', (g) => { g.inventory.quantity = 3; }],
    ['StorageBins belegt', (g) => { g.storageBins = [{ binCode: 'XGA0102B' }]; }],
    ['eBay-Listing-Zeiger', (g) => { g.ops.ebay = { itemId: '123' }; }],
    ['Kaufland-Listing-Zeiger', (g) => { g.ops.kaufland = { unitId: '456' }; }],
    ['listingStatus aktiv', (g) => { g.ops.listingStatus.ebay = 'active'; }],
    ['Orders vorhanden', (g) => { g.ops.order_count = 2; }],
    ['Bilder vorhanden', (g) => { g.details.images = [{ url_or_base64: 'x.png' }]; }],
    ['Beschreibung vorhanden', (g) => { g.details.description = 'Ein echtes Produkt.'; }],
    ['pending intake', (g) => { g.ops.pending_intake_quantity = 5; }],
  ])('NICHT inert wenn %s', (_label, mutate) => {
    const g = emptyShell();
    mutate(g);
    expect(isInertGhost(g)).toBe(false);
  });
});

describe('ghost-cleanup: classifyGhost', () => {
  it('inert + Legacy-Zwilling mit Namen → restore', () => {
    expect(classifyGhost(emptyShell(), legacyDoc())).toBe('restore');
  });

  it('inert + kein Legacy-Doc → delete', () => {
    expect(classifyGhost(emptyShell(), null)).toBe('delete');
  });

  it('inert + Legacy-Doc ohne brauchbaren Namen → delete', () => {
    const legacy = legacyDoc();
    legacy.identification.name = '';
    expect(legacyHasContent(legacy)).toBe(false);
    expect(classifyGhost(emptyShell(), legacy)).toBe('delete');
  });

  it('nicht-inert → skip, egal ob Legacy existiert', () => {
    const g = emptyShell();
    g.inventory.quantity = 1;
    expect(classifyGhost(g, legacyDoc())).toBe('skip');
    expect(classifyGhost(g, null)).toBe('skip');
  });
});

describe('ghost-cleanup: buildRestorePayload', () => {
  it('übernimmt Inhalt (Name, Marke, Bilder, GPSR, Identifiers, echte SKU)', () => {
    const p = buildRestorePayload(emptyShell(), legacyDoc());
    expect(p.identification.name).toBe('WMF Knuddel Kinderbesteck-Set 3201002485');
    expect(p.identification.brand).toBe('WMF');
    expect(p.identification.barcodes).toEqual(['4000530351531']);
    expect(p.identification.sku).toBe('SKU-0058749943'); // Legacy-SKU gewinnt über Zufalls-SKU
    expect(p.details.images).toHaveLength(1);
    expect(p.details.gpsr.manufacturer_name).toBe('WMF');
    expect(p.details.identifiers.ean).toBe('4000530351531');
    expect(p.details.weight).toBe(0.15);
    expect(p.id).toBe(emptyShell().id); // Doc-ID bleibt stabil
  });

  it('übernimmt NIE BaseLinker-, Listing- oder Bestands-Felder', () => {
    const p = buildRestorePayload(emptyShell(), legacyDoc());
    const json = JSON.stringify(p.details);
    expect(json).not.toMatch(/baselinker/i);
    expect(p.marketplace).toBeUndefined();
    expect(p.ops?.baselinker).toBeUndefined();
    expect(p.ops?.ebay?.itemId).toBeUndefined();
    // Bestand bleibt der des v2-Docs (0), nicht der Legacy-Bestand (1)
    expect(p.inventory.quantity).toBe(0);
  });
});
