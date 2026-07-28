'use strict';

// P&L-Assembly. EINE Buchhaltungsbasis: ACCRUAL.
//   Umsatz − Retouren − Gebühren − Ware − Versand = Rohgewinn
// Gebühren sind gemessen oder modelliert — NIE `Umsatz − Retouren − Auszahlung`.
// Die Bank-Auszahlung ist eine EIGENE Größe (auszahlungIst/offeneAuszahlung) und
// verankert den Gewinn nicht mehr am Zahlungszyklus der Marktplätze.
// Hintergrund + Leiter: lib/marketplace-fee-resolver.js, Incident 2026-07-28.
const { buildPnl } = require('../../lib/financial-pnl');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const OPEN_WINDOW = '2026-07-28T12:00:00.000Z'; // endet jetzt → NICHT abgerechnet
const SETTLED_WINDOW = '2026-06-30T22:00:00.000Z'; // > 14 Tage her → abgerechnet

const BASE = {
  grossRevenue: 1000,
  ebayGross: 800,
  kauflandGross: 200,
  feeRateEbay: 0.12,
  feeRateKaufland: 0.1666,
  returnsValue: 50,
  shippingNetto: 100,
  cogs: 300,
  nowMs: NOW,
};

describe('buildPnl — REGRESSION Juli 2026 (Produktion zeigte 75 % Gebührenquote)', () => {
  // Exakt die Zahlen aus dem Produktions-Screenshot vom 28.07.2026.
  const JULY = {
    grossRevenue: 10796.41,
    ebayGross: 8133.57,
    kauflandGross: 2662.84,
    otherGross: 0,
    feeRateEbay: 0.11,
    feeRateKaufland: 0.1666,
    realPayout: 2051.04,
    realPayoutSource: 'sevdesk',
    returnsValue: 624.21,
    shippingNetto: 1318 / 1.19,
    cogs: 1494,
    windowEndIso: OPEN_WINDOW,
    nowMs: NOW,
  };
  const p = buildPnl(JULY);

  it('bucht die Settlement-Lücke NICHT als Gebühr', () => {
    expect(p.marketplaceFees).toBe(1338.32); // war 8121.16
    expect(p.marketplaceFees).not.toBe(8121.16);
    expect(p.feePctOfRevenue).toBe(12.4);
    expect(p.feeSource).toBe('rates');
  });

  it('weist die offene Auszahlung als eigene Größe aus', () => {
    expect(p.auszahlungErwartet).toBe(8833.88);
    expect(p.auszahlungIst).toBe(2051.04);
    expect(p.offeneAuszahlung).toBe(6782.84); // exakt die frühere Gebühren-Überhöhung
    expect(p.settlementCoveragePct).toBe(23.2);
    expect(p.settlementStatus).toBe('partial');
    expect(p.windowSettled).toBe(false);
  });

  it('Gewinn ist accrual und positiv — nicht −760,96', () => {
    expect(p.rohgewinn).toBe(6021.88);
    expect(p.margePct).toBe(55.8);
  });

  it('der Umsatz-Balken schließt bei genau 100 %', () => {
    const sum = p.rohgewinn + p.cogs + p.marketplaceFees + p.versandBrutto + p.retouren;
    expect(Math.round(sum * 100) / 100).toBe(p.umsatzBrutto);
  });

  it('Gewinn ist unabhängig vom Zahlungseingang (kein Cash-Anker mehr)', () => {
    const later = buildPnl({ ...JULY, realPayout: 8833.88 });
    expect(later.rohgewinn).toBe(p.rohgewinn);
    expect(later.marketplaceFees).toBe(p.marketplaceFees);
    expect(later.offeneAuszahlung).toBe(0);
    expect(later.settlementStatus).toBe('settled');
  });

  it('Retouren werden genau EINMAL abgezogen', () => {
    const more = buildPnl({ ...JULY, returnsValue: 1248.42 });
    expect(Math.round((p.rohgewinn - more.rohgewinn) * 100) / 100).toBe(624.21);
  });
});

describe('buildPnl — abgerechnetes Fenster nutzt weiter den echten Flow (Owner-Entscheid 4971fba9)', () => {
  const p = buildPnl({
    ...BASE,
    realPayout: 766.68,
    realPayoutSource: 'sevdesk',
    windowEndIso: SETTLED_WINDOW,
  });

  it('leitet die Gebühren aus dem realen Geldfluss ab — inkl. Ads/Store-Fees', () => {
    expect(p.marketplaceFees).toBe(183.32); // 1000 − 50 − 766.68
    expect(p.feeSource).toBe('flow');
  });

  it('reproduziert das ALTE Ergebnis exakt, wenn das Fenster wirklich abgerechnet ist', () => {
    // Konservativitäts-Nachweis: der Fix ändert NUR unabgerechnete Fenster.
    expect(p.rohgewinn).toBe(347.68); // identisch zur Vor-Fix-Formel
    expect(p.auszahlung).toBe(766.68);
    expect(p.auszahlungSource).toBe('sevdesk');
    expect(p.settlementStatus).toBe('settled');
  });
});

describe('buildPnl — offenes Fenster ignoriert den Cash-Stand', () => {
  const p = buildPnl({
    ...BASE,
    realPayout: 766.68,
    realPayoutSource: 'sevdesk',
    windowEndIso: OPEN_WINDOW,
  });

  it('nutzt Sätze statt des Residuums', () => {
    expect(p.marketplaceFees).toBe(129.32); // 800×0.12 + 200×0.1666
    expect(p.feeSource).toBe('rates');
  });

  it('meldet die Bank-Auszahlung trotzdem ehrlich', () => {
    expect(p.auszahlungErwartet).toBe(820.68);
    expect(p.auszahlungIst).toBe(766.68);
    expect(p.offeneAuszahlung).toBe(54);
  });
});

describe('buildPnl — Plausibilitätsband schützt auch die Gesamtrechnung', () => {
  it('verwirft eine absurde Gebührenquote selbst über einem abgerechneten Fenster', () => {
    const p = buildPnl({
      ...BASE,
      realPayout: 100, // → Flow-Gebühren 850 = 85 % vom Umsatz
      realPayoutSource: 'sevdesk',
      windowEndIso: SETTLED_WINDOW,
    });
    expect(p.marketplaceFees).toBe(129.32); // Satz, nicht 850
    expect(p.feeSource).toBe('rates');
    expect(p.feeWarnings.length).toBe(1);
    expect(p.settlementStatus).toBe('partial');
  });

  it('verwirft negative Gebühren (Payout > Umsatz, z. B. Nachzahlung aus Vormonat)', () => {
    const p = buildPnl({
      ...BASE,
      realPayout: 1200,
      realPayoutSource: 'sevdesk',
      windowEndIso: SETTLED_WINDOW,
    });
    expect(p.marketplaceFees).toBe(129.32);
    expect(p.feeSource).toBe('rates');
  });
});

describe('buildPnl — rate-based fallback (keine Auszahlung bekannt)', () => {
  const p = buildPnl(BASE);

  it('nutzt die recherchierten Sätze', () => {
    expect(p.marketplaceFees).toBe(129.32);
    expect(p.feeSource).toBe('rates');
    expect(p.auszahlungSource).toBe('rates');
  });

  it('Rohgewinn (accrual) = Umsatz − Retouren − Gebühren − Ware − Versand', () => {
    expect(p.rohgewinn).toBe(401.68); // 1000 − 50 − 129.32 − 300 − 119
  });

  it('behauptet ohne Auszahlung keinen Settlement-Status', () => {
    expect(p.settlementStatus).toBe('unknown');
    expect(p.auszahlungIst).toBeNull();
    expect(p.offeneAuszahlung).toBeNull();
    expect(p.auszahlung).toBe(p.auszahlungErwartet); // Bestandsfeld bleibt befüllt
  });
});

describe('buildPnl — graceful inputs', () => {
  it('behandelt fehlenden Versand als null', () => {
    const p = buildPnl({
      grossRevenue: 500,
      realPayout: 400,
      realPayoutSource: 'sevdesk',
      returnsValue: 0,
      shippingNetto: null,
      cogs: 100,
      nowMs: NOW,
    });
    expect(p.versandBrutto).toBeNull();
    expect(p.rohgewinn).toBe(345); // 500 − 0 − 55 (11 % Satz) − 100 − 0
  });

  it('liefert keine Marge ohne Umsatz', () => {
    const p = buildPnl({
      grossRevenue: 0,
      realPayout: 0,
      realPayoutSource: 'sevdesk',
      returnsValue: 0,
      shippingNetto: 0,
      cogs: 0,
      nowMs: NOW,
    });
    expect(p.margePct).toBeNull();
    expect(p.marketplaceFees).toBe(0);
  });
});
