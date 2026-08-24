'use strict';
const {
  classifyDestination,
  resolveCuratedOptions,
  modifierCount,
  isUntrackedOptionCode,
  requiresPremiumVariant,
  resolveOrderValueEur,
  trackedOnlyThresholdEur,
  trackedOnlyObligation,
  findPremiumSibling,
} = require('../lib/shipping-catalog-resolver');

// Live-Optionen wie SendCloud v3 /shipping-options sie liefert (echte Codes beobachtet).
const opt = (code, min = 0, max = 31.5) => ({ code, weight: { min: { value: min }, max: { value: max } } });

// Bestellwert unter der 10-€-Schwelle: unversicherte Briefprodukte bleiben erlaubt.
const CHEAP = { orderValueEur: 5 };

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
    opt('dp:maxibrief/mailbox', 0, 1),
    opt('dp:bucherwarensendung/mailbox', 0, 1),
    opt('dhl_de:warenpost', 0, 1),
    opt('dhl_de:dhl_paket', 0, 31.5),
    opt('dpd:classic', 0, 5),
    // Rauschen, das ausgeschlossen werden muss:
    opt('dhl_de:warenpost/gogreen', 0, 1),
    opt('dhl_de:paket_eco_delivery/home_address_only', 0, 31.5),
    opt('dhl_de:dhl_paket/service_point', 0, 31.5),
    opt('dhl_de:warenpostinternational', 0, 1),
  ];

  it('zeigt fuer 0,45 kg (Bestellwert < 10 €) die nationalen Produkte in Reihenfolge Maxibrief, Warensendung, Kleinpaket, DPD, DHL — ohne Zusatzleistungen', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.45, ...CHEAP });
    expect(r.scope).toBe('national');
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['maxibrief', 'warensendung', 'kleinpaket', 'dpd_classic', 'dhl_paket']);
    // exakter Code, plainste Variante:
    expect(r.products.find((p) => p.key === 'kleinpaket').shippingOptionCode).toBe('dhl_de:warenpost');
    // keine international-Produkte bei DE:
    expect(r.products.find((p) => p.key === 'warenpost_int')).toBeUndefined();
  });

  it('filtert nach Gewicht: 3 kg entfernt Brief/Warensendung/Kleinpaket', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 3, ...CHEAP });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket']);
  });

  it('erkennt Warensendung unter dem echten Post-Code dp:bucherwarensendung', () => {
    const live = [opt('dp:bucherwarensendung/mailbox', 0, 1), opt('dhl_de:dhl_paket', 0, 31.5)];
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.3, ...CHEAP });
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
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.3, ...CHEAP });
    const mb = r.products.find((p) => p.key === 'maxibrief');
    expect(mb).toBeTruthy();
    expect(mb.shippingOptionCode).toBe('dp:maxibrief/mailbox');
  });
});

// ── Tracking-Pflicht ab 10 € Bestellwert (Betreiber-Anweisung 2026-08-21) ──
// Maxibrief + Warensendung tragen keine Sendungsverfolgung. Ab 10 € Verkaufswert
// (und bei UNBEKANNTEM Wert — fail-safe) fliegen sie aus der Auswahl.
describe('Tracking-Pflicht ab 10 € Bestellwert', () => {
  const live = [
    opt('dp:maxibrief/mailbox', 0, 1),
    opt('dp:bucherwarensendung/mailbox', 0, 1),
    opt('dhl_de:warenpost', 0, 1),
    opt('dhl_de:dhl_paket', 0, 31.5),
    opt('dpd:classic', 0, 31.5),
  ];

  it('unter 10 €: Briefprodukte bleiben waehlbar, trackedOnly=false', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4, orderValueEur: 9.99 });
    expect(r.trackedOnly).toBe(false);
    expect(r.products.map((p) => p.key)).toContain('maxibrief');
    expect(r.products.map((p) => p.key)).toContain('warensendung');
  });

  it('ab 10 €: Maxibrief + Warensendung fliegen raus, trackedOnly=true', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4, orderValueEur: 10 });
    expect(r.trackedOnly).toBe(true);
    expect(r.products.map((p) => p.key)).toEqual(['kleinpaket', 'dpd_classic', 'dhl_paket']);
  });

  it('unbekannter Bestellwert: fail-safe Richtung Tracking (keine Briefprodukte)', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4 });
    expect(r.trackedOnly).toBe(true);
    expect(r.products.map((p) => p.key)).toEqual(['kleinpaket', 'dpd_classic', 'dhl_paket']);
  });

  it('Bestellwert 0 gilt als unbekannt (kein echter Verkaufswert)', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4, orderValueEur: 0 });
    expect(r.trackedOnly).toBe(true);
    expect(r.products.find((p) => p.key === 'maxibrief')).toBeUndefined();
  });

  it("'off' schaltet die Regel AUCH bei unbekanntem Bestellwert ab (Notbremsen-Semantik)", () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    try {
      const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4 });
      expect(r.trackedOnly).toBe(false);
      expect(r.products.map((p) => p.key)).toContain('maxibrief');
    } finally {
      delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    }
  });

  it('liefert Schwelle + Wert-bekannt-Flag fuer die UI mit (JSON-sicher, nie Infinity)', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4, orderValueEur: 25 });
    expect(r.trackedOnlyThresholdEur).toBe(10);
    expect(r.orderValueKnown).toBe(true);
    const unknown = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4 });
    expect(unknown.orderValueKnown).toBe(false);
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    try {
      expect(resolveCuratedOptions(live, { country: 'DE', weightKg: 0.4 }).trackedOnlyThresholdEur).toBe(null);
    } finally {
      delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    }
  });
});

describe('trackedOnlyObligation', () => {
  it('bekannter Wert unter der Schwelle: keine Pflicht', () => {
    expect(trackedOnlyObligation(5)).toBe(false);
  });
  it('ab Schwelle oder unbekannt: Pflicht', () => {
    expect(trackedOnlyObligation(10)).toBe(true);
    expect(trackedOnlyObligation(null)).toBe(true);
    expect(trackedOnlyObligation(0)).toBe(true);
  });
  it("'off': nie Pflicht, auch bei unbekanntem Wert", () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    try {
      expect(trackedOnlyObligation(null)).toBe(false);
      expect(trackedOnlyObligation(500)).toBe(false);
    } finally {
      delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    }
  });
});

// ── Premium-Schwester auf derselben Lane finden (Auto-Upgrade im Alt-Flow) ──
describe('findPremiumSibling', () => {
  const live = [
    opt('dhl_de:weltpaket', 0, 31.5),
    opt('dhl_de:weltpaket/premium', 0, 31.5),
    opt('dhl_de:weltpaket/premium,flex_delivery', 0, 31.5),
    opt('dhl_de:warenpostinternational', 0, 1),
    opt('dpd:classic', 0, 31.5),
  ];
  it('findet die plainste Premium-Variante desselben Basisprodukts', () => {
    expect(findPremiumSibling(live, 'dhl_de:weltpaket', 2)).toBe('dhl_de:weltpaket/premium');
  });
  it('nimmt nie eine Variante mit weiteren verbotenen Zusatzleistungen', () => {
    const onlyNoisy = [opt('dhl_de:weltpaket/premium,flex_delivery', 0, 31.5)];
    expect(findPremiumSibling(onlyNoisy, 'dhl_de:weltpaket', 2)).toBe(null);
  });
  it('respektiert das Gewichtsfenster', () => {
    const light = [opt('dhl_de:warenpostinternational/premium', 0, 1)];
    expect(findPremiumSibling(light, 'dhl_de:warenpostinternational', 0.5)).toBe('dhl_de:warenpostinternational/premium');
    expect(findPremiumSibling(light, 'dhl_de:warenpostinternational', 2)).toBe(null);
  });
  it('ohne Premium-Variante: null', () => {
    expect(findPremiumSibling([opt('dhl_de:weltpaket', 0, 31.5)], 'dhl_de:weltpaket', 2)).toBe(null);
  });
});

// ── Notbremse SHIPPING_PREMIUM_REQUIRED='off': Katalog akzeptiert plain wieder ──
describe("SHIPPING_PREMIUM_REQUIRED='off' (Notbremse fuer premiumlose Lanes)", () => {
  afterEach(() => { delete process.env.SHIPPING_PREMIUM_REQUIRED; });
  it('Katalog matcht plain-Codes wieder (plainste Variante gewinnt)', () => {
    process.env.SHIPPING_PREMIUM_REQUIRED = 'off';
    const live = [opt('dhl_de:weltpaket', 0, 31.5), opt('dhl_de:weltpaket/premium', 0, 31.5), opt('dpd:classic', 0, 31.5)];
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 5, orderValueEur: 50 });
    expect(r.products.find((p) => p.key === 'dhl_paket_int').shippingOptionCode).toBe('dhl_de:weltpaket');
  });
  it('Default (an): Premium bleibt Pflicht', () => {
    const live = [opt('dhl_de:weltpaket', 0, 31.5), opt('dhl_de:weltpaket/premium', 0, 31.5), opt('dpd:classic', 0, 31.5)];
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 5, orderValueEur: 50 });
    expect(r.products.find((p) => p.key === 'dhl_paket_int').shippingOptionCode).toBe('dhl_de:weltpaket/premium');
  });
});

// ── DPD Express (Betreiber-Anweisung 2026-08-21: Teil des DPD-Vertrags) ──
// Live gemessen 2026-08-21: dpd:express existiert NIE nackt, nur mit
// delivery=0830|12|18. National verfuegbar, auf keiner Auslands-Lane.
describe('DPD Express', () => {
  const live = [
    opt('dp:maxibrief/mailbox', 0, 1),
    opt('dpd:classic', 0, 31.5),
    opt('dhl_de:dhl_paket', 0, 31.5),
    opt('dpd:express/delivery=12', 0, 31.5),
    opt('dpd:express/delivery=18', 0, 31.5),
    opt('dpd:express/delivery=0830', 0, 31.5),
  ];

  it('bietet Express 18 und Express 12 als eigene Produkte mit exakten Codes an (nach DHL Paket)', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 2, orderValueEur: 50 });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket', 'dpd_express_18', 'dpd_express_12']);
    expect(r.products.find((p) => p.key === 'dpd_express_18').shippingOptionCode).toBe('dpd:express/delivery=18');
    expect(r.products.find((p) => p.key === 'dpd_express_12').shippingOptionCode).toBe('dpd:express/delivery=12');
    expect(r.products.find((p) => p.key === 'dpd_express_18').tracking).toBe(true);
  });

  it('die 08:30-Variante wird nicht angeboten', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 2, orderValueEur: 50 });
    expect(r.products.map((p) => p.shippingOptionCode)).not.toContain('dpd:express/delivery=0830');
  });

  it('Express nur national — auf Auslands-Lanes nie', () => {
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 2, orderValueEur: 50 });
    expect(r.products.map((p) => p.key).some((k) => k.startsWith('dpd_express'))).toBe(false);
  });

  it('Express-Codes mit verbotenen Zusatzleistungen bleiben draussen', () => {
    const noisy = [opt('dpd:express/delivery=18,incoterm=ddp', 0, 31.5), opt('dhl_de:dhl_paket', 0, 31.5)];
    const r = resolveCuratedOptions(noisy, { country: 'DE', weightKg: 2, orderValueEur: 50 });
    expect(r.products.map((p) => p.key)).toEqual(['dhl_paket']);
  });
});

// ── Premium-Pflicht DHL International (Betreiber-Anweisung 2026-08-21) ──
// Warenpost International und DHL Paket International (weltpaket) haben nur als
// Premium eine Sendungsverfolgung — sie werden IMMER als Premium versendet.
describe('Premium-Pflicht DHL International', () => {
  const live = [
    opt('dhl_de:warenpostinternational', 0, 1),
    opt('dhl_de:warenpostinternational/premium', 0, 1),
    opt('dpd:classic', 0, 31.5),
    opt('dhl_de:weltpaket', 0, 31.5),
    opt('dhl_de:weltpaket/premium', 0, 31.5),
    opt('dhl_de:weltpaket/premium,flex_delivery', 0, 31.5), // Zusatzservice -> bleibt verboten
  ];

  it('Warenpost International liefert NUR den Premium-Code und gilt als tracked', () => {
    const r = resolveCuratedOptions(live, { country: 'AT', weightKg: 0.5, orderValueEur: 50 });
    const wp = r.products.find((p) => p.key === 'warenpost_int');
    expect(wp).toBeTruthy();
    expect(wp.shippingOptionCode).toBe('dhl_de:warenpostinternational/premium');
    expect(wp.tracking).toBe(true);
  });

  it('DHL Paket International liefert NUR weltpaket/premium (nie plain, nie premium+flex_delivery)', () => {
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 5, orderValueEur: 50 });
    const wp = r.products.find((p) => p.key === 'dhl_paket_int');
    expect(wp).toBeTruthy();
    expect(wp.shippingOptionCode).toBe('dhl_de:weltpaket/premium');
  });

  it('ohne Premium-Variante auf der Lane verschwindet der DHL-Slot statt ohne Tracking zu versenden', () => {
    const noPremium = [opt('dhl_de:weltpaket', 0, 31.5), opt('dhl_de:warenpostinternational', 0, 1), opt('dpd:classic', 0, 31.5)];
    const r = resolveCuratedOptions(noPremium, { country: 'FR', weightKg: 0.5, orderValueEur: 50 });
    expect(r.products.find((p) => p.key === 'dhl_paket_int')).toBeUndefined();
    expect(r.products.find((p) => p.key === 'warenpost_int')).toBeUndefined();
    expect(r.products.find((p) => p.key === 'dpd_classic_europa')).toBeTruthy();
  });
});

describe('resolveCuratedOptions – international', () => {
  const live = [
    opt('dhl_de:warenpostinternational', 0, 1),
    opt('dhl_de:warenpostinternational/premium', 0, 1),
    opt('dpd:classic', 0, 5),
    opt('dhl_de:weltpaket', 0, 31.5),
    opt('dhl_de:weltpaket/premium', 0, 31.5),
  ];

  it('FR (Zone1, DPD-Land): Warenpost Int Premium + DPD Classic Europa + DHL Paket Int Premium, keine Warnung', () => {
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 0.8, orderValueEur: 50 });
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['warenpost_int', 'dpd_classic_europa', 'dhl_paket_int']);
  });

  it('IT: DPD wird angeboten, sobald SendCloud es fuer die Lane liefert (keine eigene Laender-Sperre)', () => {
    const r = resolveCuratedOptions(live, { country: 'IT', weightKg: 5, orderValueEur: 50 });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic_europa', 'dhl_paket_int']);
  });

  // Realfall Auftrag 06-14936-67724: Portugal, 2,9 kg — Operator will DHL ODER DPD.
  // Echte SendCloud-Codes aus dem Prod-Log dieser Lane; seit der Premium-Pflicht
  // (2026-08-21) zaehlt fuer DHL nur noch weltpaket/premium.
  it('PT 2,9 kg: DPD UND DHL (Premium) zur Auswahl; Komma-Zusatzleistungen fliegen raus', () => {
    const ptLive = [
      opt('dhl_de:weltpaket,flex_delivery', 0, 31.5), // Zusatzservice -> raus
      opt('dpd:classic/service_point', 0, 31.5),      // Service-Point -> raus
      opt('dhl_de:weltpaket,incoterm=ddp', 0, 31.5),  // Einfuhrabgaben zu unseren Lasten -> raus
      opt('dpd:classic', 0, 31.5),
      opt('dhl_de:weltpaket', 0, 31.5),
      opt('dhl_de:weltpaket/premium', 0, 31.5),
    ];
    const r = resolveCuratedOptions(ptLive, { country: 'PT', weightKg: 2.9, orderValueEur: 50 });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic_europa', 'dhl_paket_int']);
    expect(r.products.find((p) => p.key === 'dpd_classic_europa').shippingOptionCode).toBe('dpd:classic');
    expect(r.products.find((p) => p.key === 'dhl_paket_int').shippingOptionCode).toBe('dhl_de:weltpaket/premium');
  });

  it('GR (Nicht-Zone): International erlaubt, aber warn=true', () => {
    const r = resolveCuratedOptions(live, { country: 'GR', weightKg: 5, orderValueEur: 50 });
    expect(r.warn).toBe(true);
    expect(r.products.find((p) => p.key === 'dhl_paket_int')).toBeTruthy();
  });
});

// ── Klassifikator fuer den Ship-Guard: welche Codes tragen keine Sendungsnummer? ──
describe('isUntrackedOptionCode', () => {
  it('Deutsche-Post-Briefprodukte sind untracked', () => {
    expect(isUntrackedOptionCode('dp:maxibrief/mailbox')).toBe(true);
    expect(isUntrackedOptionCode('dp:grossbrief/mailbox')).toBe(true);
    expect(isUntrackedOptionCode('dp:bucherwarensendung/mailbox')).toBe(true);
    expect(isUntrackedOptionCode('dp:brief_kilotarif_international/mailbox')).toBe(true);
  });
  it('Einschreiben/Tracked-Varianten der Post gelten als tracked', () => {
    expect(isUntrackedOptionCode('dp:maxibrief_integral/mailbox,registered,signature')).toBe(false);
    expect(isUntrackedOptionCode('dp:global_mail/tracked')).toBe(false);
  });
  it('Warenpost International ohne Premium ist untracked, mit Premium tracked', () => {
    expect(isUntrackedOptionCode('dhl_de:warenpostinternational')).toBe(true);
    expect(isUntrackedOptionCode('dhl_de:warenpostinternational/premium')).toBe(false);
  });
  it('sendcloud:letter ist untracked', () => {
    expect(isUntrackedOptionCode('sendcloud:letter')).toBe(true);
  });
  it('Paketprodukte (DHL/DPD) sind tracked — fail-open fuer Unbekanntes', () => {
    expect(isUntrackedOptionCode('dhl_de:dhl_paket')).toBe(false);
    expect(isUntrackedOptionCode('dpd:classic')).toBe(false);
    expect(isUntrackedOptionCode('dpd:express/delivery=18')).toBe(false);
    expect(isUntrackedOptionCode('dhl_de:weltpaket/premium')).toBe(false);
    expect(isUntrackedOptionCode('')).toBe(false);
    expect(isUntrackedOptionCode(null)).toBe(false);
  });
});

// ── Premium-Pflicht-Klassifikator: DHL-International-Codes OHNE Premium sind
// IMMER verboten (wertunabhaengig — "muessen immer als Premium versendet werden") ──
describe('requiresPremiumVariant', () => {
  it('DHL Paket International (weltpaket) ohne Premium braucht Premium', () => {
    expect(requiresPremiumVariant('dhl_de:weltpaket')).toBe(true);
    expect(requiresPremiumVariant('dhl_de:weltpaket,flex_delivery')).toBe(true);
    expect(requiresPremiumVariant('dhl_de:paket_international')).toBe(true);
  });
  it('Warenpost International ohne Premium braucht Premium', () => {
    expect(requiresPremiumVariant('dhl_de:warenpostinternational')).toBe(true);
  });
  it('mit Premium-Modifier ist alles gut', () => {
    expect(requiresPremiumVariant('dhl_de:weltpaket/premium')).toBe(false);
    expect(requiresPremiumVariant('dhl_de:warenpostinternational/premium')).toBe(false);
  });
  it('nationale und fremde Produkte sind nicht betroffen', () => {
    expect(requiresPremiumVariant('dhl_de:dhl_paket')).toBe(false);
    expect(requiresPremiumVariant('dhl_de:warenpost')).toBe(false); // Kleinpaket national
    expect(requiresPremiumVariant('dpd:classic')).toBe(false);
    expect(requiresPremiumVariant('dp:maxibrief/mailbox')).toBe(false);
    expect(requiresPremiumVariant('')).toBe(false);
    expect(requiresPremiumVariant(null)).toBe(false);
  });
});

// ── Bestellwert-Aufloesung: totalAmount zuerst, dann Positionssumme, sonst null ──
describe('resolveOrderValueEur', () => {
  it('liest order.totalAmount', () => {
    expect(resolveOrderValueEur({ totalAmount: 24.9 })).toBe(24.9);
  });
  it('faellt auf die Positionssumme zurueck (priceBrutto * quantity)', () => {
    expect(resolveOrderValueEur({ items: [{ priceBrutto: 4.5, quantity: 2 }, { priceBrutto: 3, quantity: 1 }] })).toBe(12);
  });
  it('ohne Betragsdaten: null (= unbekannt, Guard entscheidet fail-safe)', () => {
    expect(resolveOrderValueEur({})).toBe(null);
    expect(resolveOrderValueEur({ totalAmount: 0, items: [] })).toBe(null);
    expect(resolveOrderValueEur(null)).toBe(null);
  });
});

describe('trackedOnlyThresholdEur', () => {
  const OLD = process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    else process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = OLD;
  });
  it('Default 10 €', () => {
    delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    expect(trackedOnlyThresholdEur()).toBe(10);
  });
  it('ENV-Override als Zahl', () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = '25';
    expect(trackedOnlyThresholdEur()).toBe(25);
  });
  it("'off' schaltet die Regel ab (Schwelle unendlich)", () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    expect(trackedOnlyThresholdEur()).toBe(Infinity);
  });
  it('Muell faellt auf 10 zurueck', () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'abc';
    expect(trackedOnlyThresholdEur()).toBe(10);
  });
});
