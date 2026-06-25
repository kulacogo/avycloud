'use strict';

// P&L assembly. Fees are PERIOD-SPECIFIC and derived from the real money flow:
//   Umsatz − Retouren − Auszahlung = Gebühren  (captures ALL marketplace fees:
//   commission, ads/Promoted Listings, store fees, …) and
//   Auszahlung − COGS − Versand = Rohgewinn.
// Rate-based fees are only a fallback when no real SevDesk payout is available.
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

describe('buildPnl — flow-based fees (real payout present)', () => {
  const p = buildPnl({ ...BASE, realPayout: 766.68, realPayoutSource: 'sevdesk' });

  it('derives fees as Umsatz − Retouren − Auszahlung (all fees, period-specific)', () => {
    expect(p.marketplaceFees).toBe(183.32); // 1000 − 50 − 766.68
    expect(p.feeSource).toBe('flow');
  });

  it('uses the real payout exactly', () => {
    expect(p.auszahlung).toBe(766.68);
    expect(p.auszahlungSource).toBe('sevdesk');
  });

  it('the waterfall closes: Umsatz − Gebühren − Retouren = Auszahlung', () => {
    expect(Math.round((p.umsatzBrutto - p.marketplaceFees - p.retouren) * 100) / 100).toBe(p.auszahlung);
  });

  it('Rohgewinn = Auszahlung − COGS − Versand (fees & returns already in the payout)', () => {
    // 766.68 − 300 − 119 = 347.68
    expect(p.rohgewinn).toBe(347.68);
  });

  it('does not subtract returns twice', () => {
    const more = buildPnl({ ...BASE, realPayout: 766.68, realPayoutSource: 'sevdesk', returnsValue: 150 });
    // Higher returns → higher fees figure, but Rohgewinn (=payout−cogs−versand) is unchanged
    expect(more.rohgewinn).toBe(p.rohgewinn);
    expect(more.marketplaceFees).toBe(83.32); // 1000 − 150 − 766.68
  });
});

describe('buildPnl — rate-based fallback (no real payout)', () => {
  const p = buildPnl(BASE);
  it('falls back to researched rates when SevDesk payout is unavailable', () => {
    expect(p.marketplaceFees).toBe(129.32); // 800*0.12 + 200*0.1666
    expect(p.feeSource).toBe('rates');
    expect(p.auszahlungSource).toBe('rates');
  });
  it('Rohgewinn (accrual) = Umsatz − Gebühren − COGS − Versand − Retouren', () => {
    expect(p.rohgewinn).toBe(401.68); // 1000 − 129.32 − 300 − 119 − 50
  });
});

describe('buildPnl — graceful inputs', () => {
  it('treats missing shipping as null/0', () => {
    const p = buildPnl({ grossRevenue: 500, realPayout: 400, realPayoutSource: 'sevdesk', returnsValue: 0, shippingNetto: null, cogs: 100 });
    expect(p.versandBrutto).toBeNull();
    expect(p.rohgewinn).toBe(300); // 400 − 100 − 0
  });
  it('returns null Marge when there is no revenue', () => {
    const p = buildPnl({ grossRevenue: 0, realPayout: 0, realPayoutSource: 'sevdesk', returnsValue: 0, shippingNetto: 0, cogs: 0 });
    expect(p.margePct).toBeNull();
  });
});
