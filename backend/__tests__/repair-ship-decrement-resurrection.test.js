/**
 * Tests fuer die pure Signatur-Erkennung des Repair-Scripts
 * (Incident 2026-08-28, Ship-Decrement-Resurrektion).
 *
 * Das Script selbst laeuft nur via `require.main === module` — der Require
 * hier darf weder Firestore anfassen noch main() starten.
 */

const { matchResurrectionPair, PAIR_WINDOW_MS } = require('../scripts/repair-ship-decrement-resurrection');

const SHIP = {
  id: 'QD90aoMWGw6dXo0c47Se',
  productId: '97f1adf2-31d5-4f52-934d-cef75f4965da',
  before: 1,
  after: 0,
  createdAt: '2026-08-27T13:33:30.474Z',
};

describe('matchResurrectionPair', () => {
  it('erkennt das echte Incident-Paar (exakt invertierte Werte, 94ms Abstand)', () => {
    const pair = matchResurrectionPair(SHIP, [
      { before: 0, after: 1, createdAt: '2026-08-27T13:33:30.380Z' },
    ]);
    expect(pair).not.toBeNull();
    expect(pair.phantomQty).toBe(1);
    expect(pair.shipLedgerDocId).toBe(SHIP.id);
  });

  it('lehnt Refresh ausserhalb des Zeitfensters ab', () => {
    const outside = new Date(new Date(SHIP.createdAt).getTime() + PAIR_WINDOW_MS + 1000).toISOString();
    const pair = matchResurrectionPair(SHIP, [{ before: 0, after: 1, createdAt: outside }]);
    expect(pair).toBeNull();
  });

  it('lehnt Refresh ab, dessen Werte NICHT exakt invertiert sind', () => {
    expect(matchResurrectionPair(SHIP, [{ before: 0, after: 2, createdAt: SHIP.createdAt }])).toBeNull();
    expect(matchResurrectionPair(SHIP, [{ before: 1, after: 0, createdAt: SHIP.createdAt }])).toBeNull();
  });

  it('liefert null bei fehlenden/unlesbaren Zeitstempeln', () => {
    expect(matchResurrectionPair({ ...SHIP, createdAt: 'kein-datum' }, [{ before: 0, after: 1, createdAt: SHIP.createdAt }])).toBeNull();
    expect(matchResurrectionPair(SHIP, [])).toBeNull();
  });

  it('Mehrfach-Einheiten: phantomQty folgt before−after', () => {
    const ship2 = { ...SHIP, before: 5, after: 3 };
    const pair = matchResurrectionPair(ship2, [{ before: 3, after: 5, createdAt: SHIP.createdAt }]);
    expect(pair).not.toBeNull();
    expect(pair.phantomQty).toBe(2);
  });
});
