const { classifyListingError } = require('../../lib/listing-error-classify');

describe('classifyListingError', () => {
  it('classifies the real errors from the bulk-list modal (Incident 2026-07-10)', () => {
    expect(classifyListingError('Bild-URL oder Video-ID dürfen keinen Strichpunkt enthalten.').groupKey)
      .toBe('IMG_URL_SEMICOLON');
    expect(classifyListingError('Das Feld ISBN fehlt. Fügen Sie bitte ISBN zum Angebot hinzu und versuchen Sie es noch einmal.').groupKey)
      .toBe('ISBN_MISSING');
    expect(classifyListingError('Bereits auf eBay gelistet (ItemID: 389648509375). Artikel kann nicht erneut gelistet werden.').groupKey)
      .toBe('ALREADY_LISTED');
  });

  it('classifies by explicit error code', () => {
    expect(classifyListingError({ code: 'EBAY_PUBLISH_NO_CATEGORY', message: '' }).groupKey).toBe('CATEGORY_MISSING');
    expect(classifyListingError({ code: 'EBAY_PUBLISH_NO_PRICE', message: '' }).groupKey).toBe('PRICE_MISSING');
    expect(classifyListingError({ code: 'EBAY_PUBLISH_NO_TITLE', message: '' }).groupKey).toBe('TITLE_MISSING');
    expect(classifyListingError({ code: 'KAUFLAND_EAN_INVALID', message: 'bla' }).groupKey).toBe('EAN_ISSUE');
    expect(classifyListingError({ code: '240', message: 'restricted', kind: 'policy' }).groupKey).toBe('POLICY_RESTRICTED');
  });

  it('classifies Kaufland skip reasons', () => {
    expect(classifyListingError('Keine EAN vorhanden').groupKey).toBe('EAN_ISSUE');
    expect(classifyListingError('Kein Preis ableitbar (weder VK, EK noch Niedrigstpreis)').groupKey).toBe('PRICE_MISSING');
    expect(classifyListingError('Kein Bestand vorhanden (publishWithOnHold=false)').groupKey).toBe('NO_STOCK');
  });

  it('falls back to OTHER for unknown errors, keeping the message', () => {
    const r = classifyListingError('Irgendein exotischer Fehler xyz');
    expect(r.groupKey).toBe('OTHER');
    expect(r.message).toBe('Irgendein exotischer Fehler xyz');
  });

  it('never throws on odd input', () => {
    expect(classifyListingError(null).groupKey).toBe('OTHER');
    expect(classifyListingError(undefined).groupKey).toBe('OTHER');
    expect(classifyListingError({}).groupKey).toBe('OTHER');
  });
});
