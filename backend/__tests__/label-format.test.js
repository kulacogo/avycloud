'use strict';
// Zielformat je Transporteur (Betreiber-Vorgabe 2026-08-24):
//   DHL + DPD  -> 103 x 164 mm (Paketrolle)
//   Deutsche Post -> 62 x 100 mm (Briefrolle)
// Reine Entscheidung, kein Netz — deshalb ohne Firestore-Patch testbar.

const {
  PARCEL_FORMAT,
  LETTER_FORMAT,
  optionCodePrefix,
  resolveLabelFormat,
  labelExactSizeEnabled,
} = require('../lib/label-format');

describe('label-format: Zielmasse', () => {
  it('Paketrolle ist exakt 103 x 164 mm', () => {
    expect(PARCEL_FORMAT.widthMm).toBe(103);
    expect(PARCEL_FORMAT.heightMm).toBe(164);
    expect(PARCEL_FORMAT.printerRole).toBe('parcel');
  });

  it('Briefrolle ist exakt 62 x 100 mm', () => {
    expect(LETTER_FORMAT.widthMm).toBe(62);
    expect(LETTER_FORMAT.heightMm).toBe(100);
    expect(LETTER_FORMAT.printerRole).toBe('letter');
  });
});

describe('label-format: Praefix statt Teilstring', () => {
  // Der Vorfall 2026-07-11: `'dp'` steckt in `'dpd'`. Ein includes()-Test
  // schickt jedes DPD-Paket auf die 62-mm-Briefrolle -> abgeschnittenes,
  // unscannbares Etikett.
  it('dpd:classic ist DPD, NICHT Deutsche Post', () => {
    expect(optionCodePrefix('dpd:classic')).toBe('dpd');
    expect(resolveLabelFormat({ shippingOptionCode: 'dpd:classic' })).toBe(PARCEL_FORMAT);
  });

  it('dpd:express/delivery=18 bleibt Paketformat', () => {
    expect(resolveLabelFormat({ shippingOptionCode: 'dpd:express/delivery=18' })).toBe(PARCEL_FORMAT);
  });

  it('dp:maxibrief ist Deutsche Post', () => {
    expect(optionCodePrefix('dp:maxibrief')).toBe('dp');
    expect(resolveLabelFormat({ shippingOptionCode: 'dp:maxibrief' })).toBe(LETTER_FORMAT);
  });

  it('dp:bucherwarensendung ist Deutsche Post', () => {
    expect(resolveLabelFormat({ shippingOptionCode: 'dp:bucherwarensendung' })).toBe(LETTER_FORMAT);
  });

  it('dhl_de:dhl_paket ist Paketformat', () => {
    expect(resolveLabelFormat({ shippingOptionCode: 'dhl_de:dhl_paket' })).toBe(PARCEL_FORMAT);
  });

  it('dhl_de:warenpost (Kleinpaket) ist ein DHL-Paketetikett, kein Brief', () => {
    expect(resolveLabelFormat({ shippingOptionCode: 'dhl_de:warenpost' })).toBe(PARCEL_FORMAT);
  });

  it('dhl_de:weltpaket/premium ist Paketformat', () => {
    expect(resolveLabelFormat({ shippingOptionCode: 'dhl_de:weltpaket/premium' })).toBe(PARCEL_FORMAT);
  });
});

describe('label-format: SendCloud-Transporteur-Codes', () => {
  it('carrier=dhl -> Paketformat', () => {
    expect(resolveLabelFormat({ carrier: 'dhl' })).toBe(PARCEL_FORMAT);
  });

  it('carrier=dpd -> Paketformat', () => {
    expect(resolveLabelFormat({ carrier: 'dpd' })).toBe(PARCEL_FORMAT);
  });

  it('carrier=deutsche_post -> Briefformat', () => {
    expect(resolveLabelFormat({ carrier: 'deutsche_post' })).toBe(LETTER_FORMAT);
  });

  it('Grossschreibung und Leerzeichen stoeren nicht', () => {
    expect(resolveLabelFormat({ carrier: '  DHL  ' })).toBe(PARCEL_FORMAT);
    expect(resolveLabelFormat({ shippingOptionCode: 'DP:Maxibrief' })).toBe(LETTER_FORMAT);
  });
});

describe('label-format: Vorrang und Fail-open', () => {
  it('Versandprodukt-Code schlaegt den Transporteur-Code', () => {
    // Der Produktcode benennt das gebuchte Produkt, der Transporteur nur die
    // grobe Firma. Bei Widerspruch gewinnt der genauere Wert.
    const fmt = resolveLabelFormat({ shippingOptionCode: 'dp:maxibrief', carrier: 'dpd' });
    expect(fmt).toBe(LETTER_FORMAT);
  });

  it('unbekannter Transporteur liefert null — es wird NICHT geraten', () => {
    expect(resolveLabelFormat({ carrier: 'ups' })).toBeNull();
    expect(resolveLabelFormat({ shippingOptionCode: 'postnl:standard' })).toBeNull();
  });

  it('gar keine Angabe liefert null', () => {
    expect(resolveLabelFormat({})).toBeNull();
    expect(resolveLabelFormat()).toBeNull();
    expect(resolveLabelFormat({ carrier: null, shippingOptionCode: '' })).toBeNull();
  });
});

describe('label-format: Notbremse LABEL_EXACT_SIZE', () => {
  const original = process.env.LABEL_EXACT_SIZE;
  afterEach(() => {
    if (original === undefined) delete process.env.LABEL_EXACT_SIZE;
    else process.env.LABEL_EXACT_SIZE = original;
  });

  it('ist ohne Konfiguration an', () => {
    delete process.env.LABEL_EXACT_SIZE;
    expect(labelExactSizeEnabled()).toBe(true);
  });

  it('nur der exakte Wert off schaltet ab', () => {
    process.env.LABEL_EXACT_SIZE = 'off';
    expect(labelExactSizeEnabled()).toBe(false);
    process.env.LABEL_EXACT_SIZE = 'OFF';
    expect(labelExactSizeEnabled()).toBe(false);
  });

  it('ein Tippfehler schaltet NICHT ab', () => {
    // Gleiche Strenge wie AUTO_INVOICE: ein verrutschter Wert darf das
    // Druckbild nicht still veraendern.
    process.env.LABEL_EXACT_SIZE = 'false';
    expect(labelExactSizeEnabled()).toBe(true);
    process.env.LABEL_EXACT_SIZE = '0';
    expect(labelExactSizeEnabled()).toBe(true);
  });
});
