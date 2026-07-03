'use strict';

/**
 * Interne Produkt-Notizen (2026-07-04): Mitarbeiter-Kommentare am Produkt.
 * Liegen in einer EIGENEN Collection (product_notes), getrennt von products_v2 —
 * dürfen NIEMALS Teil eines Marktplatz-Angebots werden. Jede Notiz trägt
 * user/email, Text und Zeitstempel. Die Doc-Bau-Logik ist pure + getestet.
 */

const { buildNoteDoc, aggregateNoteCounts } = require('../services/product-notes');

describe('buildNoteDoc', () => {
  it('baut eine Notiz mit getrimmtem Text, Nutzer und Zeitstempel', () => {
    const doc = buildNoteDoc({
      productId: 'p1',
      tenantId: 'default',
      user: { uid: 'u1', email: 'a@x.de', name: 'Anna Becker' },
      text: '  Karton beschädigt, geprüft  ',
      nowIso: '2026-07-04T10:00:00.000Z',
    });
    expect(doc).toEqual({
      productId: 'p1',
      tenantId: 'default',
      userId: 'u1',
      userEmail: 'a@x.de',
      userName: 'Anna Becker',
      text: 'Karton beschädigt, geprüft',
      createdAt: '2026-07-04T10:00:00.000Z',
    });
  });

  it('wirft bei leerem Text', () => {
    expect(() => buildNoteDoc({ productId: 'p1', user: { uid: 'u1' }, text: '   ', nowIso: 'x' })).toThrow();
  });

  it('wirft ohne Produkt', () => {
    expect(() => buildNoteDoc({ productId: '', user: { uid: 'u1' }, text: 'hi', nowIso: 'x' })).toThrow();
  });
});

describe('aggregateNoteCounts', () => {
  it('zählt Notizen pro Produkt', () => {
    const counts = aggregateNoteCounts([
      { productId: 'p1' }, { productId: 'p1' }, { productId: 'p2' }, { productId: '' },
    ]);
    expect(counts).toEqual({ p1: 2, p2: 1 });
  });
});
