// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Policy-Verstoß 2026-07-20: das Repair-Script publizierte
// 63 Produkte mit Status "In Bearbeitung". Die Haus-Policy "nur Produkte mit
// Status Bereit werden gelistet" stand NIRGENDS im Code — weder
// validatePublishReadiness noch die Publish-Routen prüften ops.readiness.
//
// Seit dem Fix ist der Bereit-Status ein BLOCKER in validatePublishReadiness
// (Herzstück aller Publish-Pfade: publishProduct, verifyPublishProduct,
// Bulk-Publish, Repair-Scripts). Override NUR explizit via
// overrides.allowNonReady === true (bewusste Operator-Entscheidung).

const { validatePublishReadiness } = require('../lib/ebay-direct');

function readyProduct(readiness) {
  return {
    id: 'p1',
    ops: { readiness },
    identification: { name: 'Testprodukt mit gutem Titel' },
    details: {
      categoryId: '33564',
      pricing: { sellPrice: 49.95 },
      images: [{ url: 'https://storage.googleapis.com/x/bild1.jpg' }],
      identifiers: { ean: '4006633144780' },
      description: 'Eine ausreichend lange Beschreibung für das Produkt.',
    },
  };
}

describe('Bereit-Gate in validatePublishReadiness (Policy-Verstoß 2026-07-20)', () => {
  it('blockt Produkte mit Status "In Bearbeitung"', () => {
    const r = validatePublishReadiness(readyProduct('in_progress'));
    expect(r.canPublish).toBe(false);
    expect(r.blockers.some((b) => b.includes('nicht "Bereit"') && b.includes('In Bearbeitung'))).toBe(true);
  });

  it('blockt Produkte ohne Status (pending/unbekannt)', () => {
    const r1 = validatePublishReadiness(readyProduct('pending'));
    expect(r1.blockers.some((b) => b.includes('nicht "Bereit"'))).toBe(true);
    const r2 = validatePublishReadiness(readyProduct(undefined));
    expect(r2.blockers.some((b) => b.includes('nicht "Bereit"'))).toBe(true);
  });

  it('lässt Bereit-Produkte durch (kein Status-Blocker)', () => {
    const r = validatePublishReadiness(readyProduct('ready'));
    expect(r.blockers.some((b) => b.includes('nicht "Bereit"'))).toBe(false);
  });

  it('explizites allowNonReady=true überschreibt den Gate (bewusste Operator-Entscheidung)', () => {
    const r = validatePublishReadiness(readyProduct('in_progress'), { allowNonReady: true });
    expect(r.blockers.some((b) => b.includes('nicht "Bereit"'))).toBe(false);
  });
});
