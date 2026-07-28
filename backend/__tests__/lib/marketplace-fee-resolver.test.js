// globals: true in vitest.config.js — kein require('vitest')
const {
  resolveFees,
  isWindowSettled,
  FEE_PCT_MIN,
  FEE_PCT_MAX,
} = require('../../lib/marketplace-fee-resolver');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

describe('isWindowSettled', () => {
  it('offenes Fenster (endet jetzt) gilt NICHT als abgerechnet', () => {
    expect(isWindowSettled('2026-07-28T12:00:00.000Z', { nowMs: NOW })).toBe(false);
  });

  it('genau 14 Tage alt gilt als abgerechnet', () => {
    expect(isWindowSettled('2026-07-14T12:00:00.000Z', { nowMs: NOW })).toBe(true);
  });

  it('13 Tage alt gilt noch nicht als abgerechnet', () => {
    expect(isWindowSettled('2026-07-15T12:00:00.000Z', { nowMs: NOW })).toBe(false);
  });

  it('fehlendes/ungültiges Fensterende ist fail-closed (nicht abgerechnet)', () => {
    expect(isWindowSettled(null, { nowMs: NOW })).toBe(false);
    expect(isWindowSettled('kein-datum', { nowMs: NOW })).toBe(false);
  });
});

describe('resolveFees — offenes Fenster nutzt Sätze, NIE das Residuum', () => {
  // Reproduziert exakt das Produktions-Fenster Juli 2026 (Incident 2026-07-28).
  const r = resolveFees({
    marketplaces: {
      ebay: { gross: 8133.57, retouren: 500, payout: 100, rate: 0.11 },
      kaufland: { gross: 2662.84, retouren: 124.21, payout: 1951.04, rate: 0.1666 },
      other: { gross: 0, rate: 0.11 },
    },
    windowEndIso: '2026-07-28T12:00:00.000Z',
    nowMs: NOW,
  });

  it('summiert Sätze statt Umsatz − Retouren − Auszahlung', () => {
    expect(r.byMarketplace.ebay.fees).toBe(894.69); // 8133.57 × 0.11
    expect(r.byMarketplace.kaufland.fees).toBe(443.63); // 2662.84 × 0.1666
    expect(r.total).toBe(1338.32);
    expect(r.feeSource).toBe('rates');
    expect(r.windowSettled).toBe(false);
  });

  it('meldet die Gebührenquote je Marktplatz', () => {
    expect(r.byMarketplace.ebay.feePct).toBe(11);
    expect(r.byMarketplace.kaufland.feePct).toBe(16.7);
  });
});

describe('resolveFees — abgerechnetes Fenster nutzt den echten Flow (Owner-Entscheid 4971fba9)', () => {
  const r = resolveFees({
    marketplaces: {
      ebay: { gross: 8000, retouren: 400, payout: 6600, rate: 0.11 },
      kaufland: { gross: 2000, retouren: 100, payout: 1580, rate: 0.1666 },
      other: { gross: 0, rate: 0.11 },
    },
    windowEndIso: '2026-06-30T22:00:00.000Z',
    nowMs: NOW,
  });

  it('nimmt Flow wenn plausibel — erfasst damit auch Ads/Store-Fees', () => {
    expect(r.byMarketplace.ebay.fees).toBe(1000); // 12.5 %
    expect(r.byMarketplace.kaufland.fees).toBe(320); // 16.0 %
    expect(r.total).toBe(1320);
    expect(r.feeSource).toBe('flow');
    expect(r.windowSettled).toBe(true);
  });
});

describe('resolveFees — Plausibilitätsband greift in BEIDE Richtungen', () => {
  it('verwirft eine Gebührenquote > 40 % (Settlement-Lag) und warnt', () => {
    const r = resolveFees({
      marketplaces: {
        ebay: { gross: 8000, retouren: 0, payout: 500, rate: 0.11 },
        kaufland: {},
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.byMarketplace.ebay.fees).toBe(880); // Satz, NICHT 7500
    expect(r.byMarketplace.ebay.feeSource).toBe('rates');
    expect(r.warnings.length).toBe(1);
  });

  it('verwirft negative Gebühren (Kaufland-Undercount, dokumentiert in 4971fba9)', () => {
    const r = resolveFees({
      marketplaces: {
        kaufland: { gross: 2000, retouren: 0, payout: 2400, rate: 0.1666 },
        ebay: {},
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.byMarketplace.kaufland.fees).toBe(333.2);
    expect(r.byMarketplace.kaufland.feeSource).toBe('rates');
    expect(r.warnings.length).toBe(1);
  });

  it('eine Auszahlung von 0 bucht NICHT den ganzen Umsatz als Gebühr', () => {
    const r = resolveFees({
      marketplaces: {
        ebay: { gross: 8000, retouren: 0, payout: 0, rate: 0.11 },
        kaufland: {},
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.byMarketplace.ebay.fees).toBe(880);
    expect(r.byMarketplace.ebay.feeSource).toBe('rates');
  });
});

describe('resolveFees — gemessene Gebühren schlagen alles', () => {
  it('nutzt den gemessenen Wert vor Flow und Satz', () => {
    const r = resolveFees({
      marketplaces: {
        kaufland: { gross: 2000, retouren: 0, payout: 1600, measured: 351.4, rate: 0.1666 },
        ebay: {},
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.byMarketplace.kaufland.fees).toBe(351.4);
    expect(r.byMarketplace.kaufland.feeSource).toBe('measured');
  });

  it('verwirft einen unplausiblen gemessenen Wert und fällt auf den Satz zurück', () => {
    const r = resolveFees({
      marketplaces: {
        kaufland: { gross: 2000, measured: 1900, rate: 0.1666 },
        ebay: {},
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.byMarketplace.kaufland.fees).toBe(333.2);
    expect(r.byMarketplace.kaufland.feeSource).toBe('rates');
    expect(r.warnings.length).toBe(1);
  });
});

describe('resolveFees — Randfälle', () => {
  it('ohne Umsatz gibt es keine Gebühren und keine Quelle-Verwirrung', () => {
    const r = resolveFees({ marketplaces: {}, windowEndIso: null, nowMs: NOW });
    expect(r.total).toBe(0);
    expect(r.feeSource).toBe('rates');
    expect(r.warnings).toEqual([]);
  });

  it('mischt Quellen sichtbar, statt eine zu behaupten', () => {
    const r = resolveFees({
      marketplaces: {
        ebay: { gross: 8000, retouren: 400, payout: 6600, rate: 0.11 }, // flow
        kaufland: { gross: 2000, measured: 333, rate: 0.1666 }, // measured
        other: {},
      },
      windowEndIso: '2026-06-30T22:00:00.000Z',
      nowMs: NOW,
    });
    expect(r.feeSource).toBe('mixed');
  });

  it('das Band ist die dokumentierte Invariante', () => {
    expect(FEE_PCT_MIN).toBe(0.02);
    expect(FEE_PCT_MAX).toBe(0.4);
  });
});
