'use strict';
const {
  classifyDestination,
  resolveCuratedOptions,
  modifierCount,
} = require('../lib/shipping-catalog-resolver');

// Live-Optionen wie SendCloud v3 /shipping-options sie liefert (echte Codes beobachtet).
const opt = (code, min = 0, max = 31.5) => ({ code, weight: { min: { value: min }, max: { value: max } } });

describe('classifyDestination', () => {
  it('DE ist national ohne Warnung', () => {
    expect(classifyDestination('DE')).toEqual({ country: 'DE', scope: 'national', warn: false });
  });
  it('leer -> DE national', () => {
    expect(classifyDestination('').scope).toBe('national');
  });
  it('Zone-1-Land (FR) ist international ohne Warnung', () => {
    expect(classifyDestination('fr')).toEqual({ country: 'FR', scope: 'international', warn: false });
  });
  it('Nicht-Zone-Land (GR) ist international MIT Warnung', () => {
    expect(classifyDestination('GR')).toEqual({ country: 'GR', scope: 'international', warn: true });
  });
});

describe('modifierCount', () => {
  it('zaehlt Modifier nach dem Slash', () => {
    expect(modifierCount('dhl_de:dhl_paket')).toBe(0);
    expect(modifierCount('dp:grossbrief/mailbox')).toBe(1);
    expect(modifierCount('dp:maxibrief_integral/extra_fee,mailbox,signature')).toBe(3);
  });
});

describe('resolveCuratedOptions – national (DE)', () => {
  const live = [
    opt('dp:grossbrief/mailbox', 0, 0.5),
    opt('dp:warensendung/mailbox', 0, 1),
    opt('dhl_de:warenpost', 0, 1),
    opt('dhl_de:dhl_paket', 0, 31.5),
    opt('dpd:classic', 0, 5),
    // Rauschen, das ausgeschlossen werden muss:
    opt('dhl_de:warenpost/gogreen', 0, 1),
    opt('dhl_de:paket_eco_delivery/home_address_only', 0, 31.5),
    opt('dhl_de:dhl_paket/service_point', 0, 31.5),
    opt('dhl_de:warenpostinternational', 0, 1),
  ];

  it('zeigt fuer 0,45 kg die nationalen Produkte, billigste zuerst, ohne Zusatzleistungen', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.45 });
    expect(r.scope).toBe('national');
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['grossbrief', 'warensendung', 'kleinpaket', 'dpd_classic', 'dhl_paket']);
    // exakter Code, plainste Variante:
    expect(r.products.find((p) => p.key === 'kleinpaket').shippingOptionCode).toBe('dhl_de:warenpost');
    // keine international-Produkte bei DE:
    expect(r.products.find((p) => p.key === 'warenpost_int')).toBeUndefined();
  });

  it('filtert nach Gewicht: 3 kg entfernt Brief/Warensendung/Kleinpaket', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 3 });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket']);
  });

  it('erkennt Warensendung unter dem echten Post-Code dp:bucherwarensendung', () => {
    const live = [opt('dp:bucherwarensendung/mailbox', 0, 1), opt('dhl_de:dhl_paket', 0, 31.5)];
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.3 });
    const ws = r.products.find((p) => p.key === 'warensendung');
    expect(ws).toBeTruthy();
    expect(ws.shippingOptionCode).toBe('dp:bucherwarensendung/mailbox');
  });

  it('erkennt Maxibrief unter dp:maxibrief, aber nicht die extra_fee-/integral-Varianten', () => {
    const live = [
      opt('dp:maxibrief/extra_fee,mailbox', 0, 1),
      opt('dp:maxibrief/mailbox', 0, 1),
      opt('dp:maxibrief_integral/extra_fee,mailbox,signature', 0, 1),
    ];
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.3 });
    const mb = r.products.find((p) => p.key === 'maxibrief');
    expect(mb).toBeTruthy();
    expect(mb.shippingOptionCode).toBe('dp:maxibrief/mailbox');
  });
});

describe('resolveCuratedOptions – international', () => {
  const live = [
    opt('dhl_de:warenpostinternational', 0, 1),
    opt('dpd:classic', 0, 5),
    opt('dhl_de:weltpaket', 0, 31.5),
    opt('dhl_de:warenpostinternational/premium', 0, 1), // muss raus
  ];

  it('FR (Zone1, DPD-Land): Warenpost Int + DPD Classic Europa + DHL Paket Int, keine Warnung', () => {
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 0.8 });
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['warenpost_int', 'dpd_classic_europa', 'dhl_paket_int']);
  });

  it('IT (Zone2, NICHT DPD-Land): kein DPD Classic Europa', () => {
    const r = resolveCuratedOptions(live, { country: 'IT', weightKg: 5 });
    expect(r.products.find((p) => p.key === 'dpd_classic_europa')).toBeUndefined();
    expect(r.products.map((p) => p.key)).toEqual(['dhl_paket_int']);
  });

  it('GR (Nicht-Zone): International erlaubt, aber warn=true', () => {
    const r = resolveCuratedOptions(live, { country: 'GR', weightKg: 5 });
    expect(r.warn).toBe(true);
    expect(r.products.find((p) => p.key === 'dhl_paket_int')).toBeTruthy();
  });
});
