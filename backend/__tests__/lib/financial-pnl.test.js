'use strict';

// Pure P&L assembly math. Accrual margin (order-date basis) with researched fee rates;
// the exact SevDesk payout is shown for display + cross-check, NOT as the margin basis
// (it lags by settlement date, which would make short-window fees nonsensical).
const { buildPnl } = require('../../lib/financial-pnl');

const BASE = {
  grossRevenue: 1000,
  ebayGross: 800,
  kauflandGross: 200,
  feeRateEbay: 0.12,
  feeRateKaufland: 0.1666,
  returnsValue: 50,
  shippingNetto: 100,
  cogs: 300,
};

describe('buildPnl — fees from researched rates', () => {
  it('computes fees per marketplace from rates (not from the payout)', () => {
    const p = buildPnl(BASE);
    // 800*0.12 + 200*0.1666 = 96 + 33.32 = 129.32
    expect(p.marketplaceFees).toBe(129.32);
    expect(p.feeSource).toBe('rates');
  });

  it('keeps Umsatz at gross', () => {
    expect(buildPnl(BASE).umsatzBrutto).toBe(1000);
  });

  it('converts shipping netto to brutto (×1.19)', () => {
    expect(buildPnl(BASE).versandBrutto).toBe(119);
  });

  it('computes Rohgewinn on accrual basis = Umsatz − Gebühren − COGS − Versand − Retouren', () => {
    // 1000 - 129.32 - 300 - 119 - 50 = 401.68
    expect(buildPnl(BASE).rohgewinn).toBe(401.68);
  });

  it('computes Marge % = Rohgewinn / Umsatz × 100', () => {
    expect(buildPnl(BASE).margePct).toBe(40.2); // 401.68/1000 → 40.168 → 40.2
  });
});

describe('buildPnl — real payout (SevDesk) for display + cross-check', () => {
  it('shows the real payout and the variance vs expected (Umsatz − Gebühren)', () => {
    const p = buildPnl({ ...BASE, realPayout: 805, realPayoutSource: 'sevdesk' });
    expect(p.auszahlung).toBe(805); // exact, real money
    expect(p.auszahlungSource).toBe('sevdesk');
    expect(p.expectedPayout).toBe(870.68); // 1000 - 129.32
    expect(p.payoutVariance).toBe(-65.68); // 805 - 870.68 (settlement timing / data gap)
  });

  it('does NOT let the payout change the accrual Rohgewinn', () => {
    const withPayout = buildPnl({ ...BASE, realPayout: 805, realPayoutSource: 'sevdesk' });
    const without = buildPnl(BASE);
    expect(withPayout.rohgewinn).toBe(without.rohgewinn); // margin is accrual, payout is info
  });

  it('falls back to expected payout (rates) when no real payout is available', () => {
    const p = buildPnl(BASE);
    expect(p.auszahlung).toBe(p.expectedPayout);
    expect(p.auszahlungSource).toBe('rates');
    expect(p.payoutVariance).toBeNull();
  });
});

describe('buildPnl — no double counting of returns', () => {
  it('subtracts returns from Rohgewinn exactly once and never from Umsatz', () => {
    const without = buildPnl({ ...BASE, returnsValue: 0 });
    const withR = buildPnl({ ...BASE, returnsValue: 100 });
    expect(without.umsatzBrutto).toBe(1000);
    expect(withR.umsatzBrutto).toBe(1000);
    expect(without.rohgewinn - withR.rohgewinn).toBe(100);
  });
});

describe('buildPnl — graceful inputs', () => {
  it('treats missing shipping as null and 0 in the profit math', () => {
    const p = buildPnl({ grossRevenue: 500, ebayGross: 500, kauflandGross: 0, feeRateEbay: 0.1, feeRateKaufland: 0.1666, returnsValue: 0, shippingNetto: null, cogs: 100 });
    expect(p.versandBrutto).toBeNull();
    // 500 - (500*0.1=50) - 100 - 0 - 0 = 350
    expect(p.rohgewinn).toBe(350);
  });

  it('returns null Marge when there is no revenue', () => {
    const p = buildPnl({ grossRevenue: 0, ebayGross: 0, kauflandGross: 0, returnsValue: 0, shippingNetto: 0, cogs: 0 });
    expect(p.margePct).toBeNull();
  });

  it('derives ebayGross from grossRevenue − kauflandGross when not given', () => {
    const p = buildPnl({ grossRevenue: 1000, kauflandGross: 200, feeRateEbay: 0.1, feeRateKaufland: 0.1666, returnsValue: 0, shippingNetto: 0, cogs: 0 });
    // ebayGross = 800 → fees 800*0.1 + 200*0.1666 = 80 + 33.32 = 113.32
    expect(p.marketplaceFees).toBe(113.32);
  });
});
