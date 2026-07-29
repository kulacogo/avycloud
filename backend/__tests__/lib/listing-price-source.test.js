/**
 * Woher käme der Angebotspreis? — reine Auswertung, kein I/O.
 *
 * Hintergrund (Audit 2026-07-29): 438 von 765 Bestandsprodukten haben keinen gesetzten
 * `details.pricing.sellPrice`. Beim Einstellen greift dann still die naechste Stufe der
 * Fallback-Kette — bei 408 Produkten der RECHERCHIERTE MARKTPREIS
 * (`details.pricing.lowest_price.amount`). Dieser Preis geht als Verkaufspreis online,
 * ohne dass ihn jemand bewusst entschieden hat.
 *
 * Diese Bibliothek bildet die bestehende Kette aus `mapProductToEbayItem` und
 * `validatePublishReadiness` 1:1 nach und benennt zusaetzlich die QUELLE, damit ein
 * Gate zwischen "bewusst gesetzt" und "still geerbt" unterscheiden kann.
 * Sie aendert nichts am Preis selbst.
 */

const {
  resolveListingPrice,
  resolveKauflandPrice,
  isExplicitPriceSource,
} = require('../../lib/listing-price-source');

const product = (pricing = {}, extra = {}) => ({
  id: 'p-price-test',
  details: { pricing },
  ...extra,
});

describe('resolveListingPrice — bildet die heutige Kette exakt nach', () => {
  it('nimmt overrides.startPrice zuerst', () => {
    const r = resolveListingPrice(product({ sellPrice: 20 }), { startPrice: 9.9 });
    expect(r.price).toBe(9.9);
    expect(r.source).toBe('override');
  });

  it('nimmt overrides.price wenn startPrice fehlt', () => {
    const r = resolveListingPrice(product({ sellPrice: 20 }), { price: 8.5 });
    expect(r.price).toBe(8.5);
    expect(r.source).toBe('override');
  });

  it('nimmt sellPrice vor dem Marktpreis (Incident 2026-07-10)', () => {
    const r = resolveListingPrice(product({ sellPrice: 479.9, lowest_price: { amount: 509.99 } }));
    expect(r.price).toBe(479.9);
    expect(r.source).toBe('sellPrice');
  });

  it('faellt still auf den recherchierten Marktpreis zurueck wenn sellPrice fehlt', () => {
    const r = resolveListingPrice(product({ lowest_price: { amount: 509.99 } }));
    expect(r.price).toBe(509.99);
    expect(r.source).toBe('lowest_price');
  });

  it('faellt auf den Spiegelpreis zurueck wenn auch der Marktpreis fehlt', () => {
    const r = resolveListingPrice(product({}, { marketplace: { ebay: { price: 44.9 } } }));
    expect(r.price).toBe(44.9);
    expect(r.source).toBe('marketplace_mirror');
  });

  it('liefert null wenn es gar keinen Preis gibt', () => {
    const r = resolveListingPrice(product({}));
    expect(r.price).toBe(null);
    expect(r.source).toBe('none');
  });
});

describe('resolveListingPrice — sellPrice muss echt gesetzt sein', () => {
  it('behandelt sellPrice 0 nicht als gesetzt (wie die heutige Kette)', () => {
    const r = resolveListingPrice(product({ sellPrice: 0, lowest_price: { amount: 12 } }));
    expect(r.price).toBe(12);
    expect(r.source).toBe('lowest_price');
  });

  it('behandelt negativen sellPrice nicht als gesetzt', () => {
    const r = resolveListingPrice(product({ sellPrice: -5, lowest_price: { amount: 12 } }));
    expect(r.source).toBe('lowest_price');
  });

  it('behandelt sellPrice als Zahlen-String (kommt aus der UI vor)', () => {
    const r = resolveListingPrice(product({ sellPrice: '19.90', lowest_price: { amount: 12 } }));
    expect(r.price).toBe(19.9);
    expect(r.source).toBe('sellPrice');
  });

  it('ignoriert unbrauchbaren sellPrice', () => {
    const r = resolveListingPrice(product({ sellPrice: 'abc', lowest_price: { amount: 12 } }));
    expect(r.source).toBe('lowest_price');
  });
});

describe('isExplicitPriceSource — was gilt als bewusst entschieden', () => {
  it('override und sellPrice gelten als bewusst', () => {
    expect(isExplicitPriceSource('override')).toBe(true);
    expect(isExplicitPriceSource('sellPrice')).toBe(true);
  });

  it('Marktpreis und Spiegel gelten NICHT als bewusst', () => {
    expect(isExplicitPriceSource('lowest_price')).toBe(false);
    expect(isExplicitPriceSource('marketplace_mirror')).toBe(false);
    expect(isExplicitPriceSource('none')).toBe(false);
  });
});

describe('resolveKauflandPrice — eigene Kette, gleiches Prinzip', () => {
  it('nimmt sellPrice zuerst und gilt als bewusst', () => {
    const r = resolveKauflandPrice(product({ sellPrice: 24.9, lowest_price: { amount: 30 } }));
    expect(r.price).toBe(24.9);
    expect(r.explicit).toBe(true);
  });

  it('erkennt den kanalspezifischen Kaufland-Preis als bewusst', () => {
    const r = resolveKauflandPrice(product({}, { pricing: { kaufland: { price: 26.5 } } }));
    expect(r.price).toBe(26.5);
    expect(r.source).toBe('kaufland_channel');
    expect(r.explicit).toBe(true);
  });

  it('markiert den stillen Marktpreis als NICHT bewusst', () => {
    const r = resolveKauflandPrice(product({ lowest_price: { amount: 509.99 } }));
    expect(r.price).toBe(509.99);
    expect(r.explicit).toBe(false);
  });

  it('markiert pricing.amount als NICHT bewusst', () => {
    const r = resolveKauflandPrice(product({ amount: 33 }));
    expect(r.source).toBe('amount');
    expect(r.explicit).toBe(false);
  });

  it('liefert none wenn es keinen Preis gibt', () => {
    expect(resolveKauflandPrice(product({})).source).toBe('none');
    expect(resolveKauflandPrice(null).source).toBe('none');
  });
});

describe('resolveListingPrice — robust gegen Muell', () => {
  it('wirft bei null/undefined nicht', () => {
    expect(resolveListingPrice(null).source).toBe('none');
    expect(resolveListingPrice(undefined).source).toBe('none');
    expect(resolveListingPrice({}).source).toBe('none');
  });

  it('wirft bei kaputtem details-Objekt nicht', () => {
    expect(resolveListingPrice({ details: null }).source).toBe('none');
    expect(resolveListingPrice({ details: { pricing: null } }).source).toBe('none');
  });
});
