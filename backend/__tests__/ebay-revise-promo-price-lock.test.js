/**
 * eBay-Fehler 21919248 — Preissperre durch Sonderaktion (2026-08-26).
 *
 * Befund: Steckt ein Artikel in einer eBay-Sonderaktion, lehnt eBay JEDEN
 * ReviseFixedPriceItem mit <StartPrice> komplett ab ("Der Preis fuer diesen
 * Artikel kann nicht aktualisiert werden, da der Artikel Teil einer
 * Sonderaktion ist"). Der Bediener sah in der Oberflaeche nur
 * "0/1 · 1 fehlgeschlagen" — Titel, Bilder, Merkmale, Menge blieben ALLE
 * ungepusht, obwohl nur der Preis gesperrt war.
 *
 * Neu: Genau bei diesem Fehlercode wird EINMAL ohne Preisfeld erneut
 * gesendet. Ergebnis: alles ausser dem Preis wird aktualisiert, und das
 * Resultat traegt einen sichtbaren Warnhinweis. Jeder andere Fehler fliegt
 * unveraendert durch.
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

// ebay-trading-api gezielt ueberlagern: reale Exporte behalten, nur die vom
// Revise-Pfad genutzten Netz-Funktionen mocken. Muss VOR dem ebay-direct-
// Require passieren (Destructuring beim Modul-Load).
const tradingPath = require.resolve('../lib/ebay-trading-api');
const realTrading = require(tradingPath);
const reviseFixedPriceItemMock = vi.fn();
const getItemDetailsMock = vi.fn();
require.cache[tradingPath].exports = {
  ...realTrading,
  reviseFixedPriceItem: reviseFixedPriceItemMock,
  getItemDetails: getItemDetailsMock,
};

const { reviseListingFromProduct } = require('../lib/ebay-direct');

function promoLockError() {
  const err = new Error('Der Preis für diesen Artikel kann nicht aktualisiert werden, da der Artikel Teil einer Sonderaktion ist.');
  err.code = 'EBAY_TRADING_CALL_FAILED';
  err.details = {
    ack: 'Failure',
    errors: [{ code: '21919248', shortMessage: 'Preis gesperrt: Sonderaktion', severity: 'Error' }],
  };
  return err;
}

function makeProduct() {
  return {
    id: 'p-promo',
    identification: { name: 'KONO Reisekoffer 28 Zoll Hartschale', brand: 'KONO' },
    details: {
      categoryId: '11236',
      pricing: { sellPrice: 69.99 },
      images: ['https://example.com/koffer.jpg'],
    },
    inventory: { quantity: 1 },
    ops: { readiness: 'ready' },
  };
}

beforeEach(() => {
  reviseFixedPriceItemMock.mockReset();
  getItemDetailsMock.mockReset();
  getItemDetailsMock.mockResolvedValue({ item: { listingType: 'FixedPriceItem' } });
});

describe('reviseListingFromProduct — Sonderaktions-Preissperre (eBay 21919248)', () => {
  it('wiederholt EINMAL ohne Preisfeld und meldet Erfolg mit Warnhinweis', async () => {
    reviseFixedPriceItemMock
      .mockRejectedValueOnce(promoLockError())
      .mockResolvedValueOnce({ ack: 'Success', warnings: [] });

    const r = await reviseListingFromProduct('800315409133', makeProduct());

    expect(r.ok).toBe(true);
    expect(reviseFixedPriceItemMock).toHaveBeenCalledTimes(2);
    // Erster Versuch trug den Preis, der Retry laesst ihn weg —
    // buildReviseItemRequestXml emittiert dann kein <StartPrice>.
    expect(reviseFixedPriceItemMock.mock.calls[0][0].startPrice).toBeGreaterThan(0);
    expect(reviseFixedPriceItemMock.mock.calls[1][0].startPrice).toBeUndefined();
    expect((r.warnings || []).join(' | ')).toMatch(/Sonderaktion/);
    // Das Ergebnis darf NICHT behaupten, der Preis sei aktualisiert worden —
    // updatedFields muss den tatsaechlich GESENDETEN Patch beschreiben.
    expect(r.updatedFields).not.toContain('startPrice');
    expect(r.updatedFields).toContain('title');
  });

  it('anderer eBay-Fehler: KEIN Preis-Retry, Fehler fliegt unveraendert durch', async () => {
    const err = new Error('Ein anderes Problem.');
    err.code = 'EBAY_TRADING_CALL_FAILED';
    err.details = { ack: 'Failure', errors: [{ code: '12345', shortMessage: 'anders' }] };
    reviseFixedPriceItemMock.mockRejectedValueOnce(err);

    await expect(reviseListingFromProduct('800315409133', makeProduct())).rejects.toThrow('Ein anderes Problem.');
    expect(reviseFixedPriceItemMock).toHaveBeenCalledTimes(1);
  });

  it('scheitert auch der Retry, fliegt der Fehler durch — genau zwei Versuche, keine Schleife', async () => {
    reviseFixedPriceItemMock.mockRejectedValue(promoLockError());

    await expect(reviseListingFromProduct('800315409133', makeProduct())).rejects.toThrow(/Sonderaktion/);
    expect(reviseFixedPriceItemMock).toHaveBeenCalledTimes(2);
  });
});
