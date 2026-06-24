'use strict';

// Pure P&L assembly math. This is where double-counting / estimate bugs would hide.
const { buildPnl } = require('../../lib/financial-pnl');

describe('buildPnl — payout source', () => {
  it('uses eBay Finances net as exact payout when provided', () => {
    const p = buildPnl({
      grossRevenue: 1000,
      kauflandGross: 200,
      kauflandPayout: 166.68,
      ebayNetWindow: 620, // exact from Finances API
      returnsValue: 0,
      shippingNetto: 0,
      cogs: 0,
    });
    expect(p.auszahlung).toBe(786.68); // 620 + 166.68
    expect(p.auszahlungSource).toBe('ebay_finances');
  });

  it('estimates eBay payout as eBayGross × 0.75 when Finances API is unavailable', () => {
    const p = buildPnl({
      grossRevenue: 1000,
      kauflandGross: 200,
      kauflandPayout: 166.68,
      ebayNetWindow: null, // not available
      returnsValue: 0,
      shippingNetto: 0,
      cogs: 0,
    });
    // eBayGross = 1000 - 200 = 800 → 800 * 0.75 = 600 ; + Kaufland 166.68
    expect(p.auszahlung).toBe(766.68);
    expect(p.auszahlungSource).toBe('estimated');
  });
});

describe('buildPnl — full P&L math', () => {
  const base = {
    grossRevenue: 1000,
    kauflandGross: 200,
    kauflandPayout: 166.68,
    ebayNetWindow: null,
    returnsValue: 50,
    shippingNetto: 100,
    cogs: 300,
  };

  it('keeps Umsatz at gross (returns are a separate line, not subtracted from Umsatz)', () => {
    expect(buildPnl(base).umsatzBrutto).toBe(1000);
  });

  it('derives marketplace fees as Umsatz minus Auszahlung', () => {
    expect(buildPnl(base).marketplaceFees).toBe(233.32); // 1000 - 766.68
  });

  it('converts shipping netto to brutto (×1.19)', () => {
    expect(buildPnl(base).versandBrutto).toBe(119); // 100 * 1.19
  });

  it('computes Rohgewinn = Auszahlung − Versand − COGS − Retouren', () => {
    // 766.68 - 119 - 300 - 50 = 297.68
    expect(buildPnl(base).rohgewinn).toBe(297.68);
  });

  it('computes Marge % = Rohgewinn / Umsatz × 100', () => {
    expect(buildPnl(base).margePct).toBe(29.8); // 297.68 / 1000 → 29.768 → 29.8
  });
});

describe('buildPnl — no double counting of returns', () => {
  it('subtracts returns from Rohgewinn exactly once and never from Umsatz', () => {
    const without = buildPnl({ grossRevenue: 1000, kauflandGross: 0, kauflandPayout: 0, ebayNetWindow: 700, returnsValue: 0, shippingNetto: 0, cogs: 0 });
    const withR = buildPnl({ grossRevenue: 1000, kauflandGross: 0, kauflandPayout: 0, ebayNetWindow: 700, returnsValue: 100, shippingNetto: 0, cogs: 0 });
    expect(without.umsatzBrutto).toBe(1000);
    expect(withR.umsatzBrutto).toBe(1000); // Umsatz unaffected by returns
    expect(without.rohgewinn - withR.rohgewinn).toBe(100); // exactly one deduction
  });
});

describe('buildPnl — graceful inputs', () => {
  it('treats missing shipping as null and 0 in the profit math', () => {
    const p = buildPnl({ grossRevenue: 500, kauflandGross: 0, kauflandPayout: 0, ebayNetWindow: 400, returnsValue: 0, shippingNetto: null, cogs: 100 });
    expect(p.versandBrutto).toBeNull();
    expect(p.rohgewinn).toBe(300); // 400 - 0 - 100 - 0
  });

  it('returns null Marge when there is no revenue', () => {
    const p = buildPnl({ grossRevenue: 0, kauflandGross: 0, kauflandPayout: 0, ebayNetWindow: 0, returnsValue: 0, shippingNetto: 0, cogs: 0 });
    expect(p.margePct).toBeNull();
  });
});
