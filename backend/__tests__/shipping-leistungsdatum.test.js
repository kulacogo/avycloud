'use strict';

/**
 * Versandkosten nach Leistungsdatum statt Abbuchungstag.
 *
 * Betreiber 2026-10-09: Marge sprang am Monatsanfang 50 % -> 36 %; 7 Punkte
 * davon war die DHL-Rechnung vom 30.09. (1.482,32 EUR), die am 05.10. vom
 * Konto ging. Die Buchungstexte unten sind echte Verwendungszwecke aus dem
 * SevDesk-Kontoauszug (Kundennummern unveraendert, sie sind nicht geheim).
 */

const {
  datumAusVerwendungszweck,
  leistungsdatum,
  imFenster,
  addDays,
  NACHLAUF_FENSTER_TAGE,
} = require('../lib/shipping-leistungsdatum');

const DHL = '/OBO/DHL PAKET GMBH/KD 6398258559/ZB 2804769088/RG 1041606335/30.09.2026/VFTN 0101';
const DP = '/OBO/DEUTSCHE POST AG/KD6398258559 2807165459 REF1567335350 RE5701906385 DAT30.09.2026 Warenpost International';
const DPD = 'DPD RECHNUNG RE-66841150';
const SENDCLOUD = 'SendCloud GMBH 2-26-DE0063740';

describe('datumAusVerwendungszweck', () => {
  it('liest das DHL-Rechnungsdatum aus dem /RG .../dd.mm.yyyy/-Block', () => {
    expect(datumAusVerwendungszweck(DHL)).toBe('2026-09-30');
  });

  it('liest das Deutsche-Post-Datum aus DATdd.mm.yyyy', () => {
    expect(datumAusVerwendungszweck(DP)).toBe('2026-09-30');
  });

  it('findet bei DPD und SendCloud nichts — die tragen kein Datum', () => {
    expect(datumAusVerwendungszweck(DPD)).toBeNull();
    expect(datumAusVerwendungszweck(SENDCLOUD)).toBeNull();
  });

  it('haelt eine Kundennummer nicht fuer ein Datum', () => {
    // 6398258559 / 2804769088 duerfen nie als dd.mm.yyyy durchgehen.
    expect(datumAusVerwendungszweck('KD 6398258559 ZB 2804769088')).toBeNull();
  });

  it('verwirft ein unmoegliches Datum', () => {
    expect(datumAusVerwendungszweck('RG 1/31.02.2026/')).toBeNull();
  });
});

describe('leistungsdatum', () => {
  it('die DHL-Rechnung vom 30.09., abgebucht am 05.10., gehoert in den September', () => {
    // DER Fall, um den es geht.
    expect(leistungsdatum({ valueDate: '2026-10-05', paymtPurpose: DHL })).toEqual({
      datum: '2026-09-30',
      quelle: 'rechnung',
    });
  });

  it('Deutsche Post vom 30.09., abgebucht am 06.10., ebenso', () => {
    expect(leistungsdatum({ valueDate: '2026-10-06', paymtPurpose: DP })).toEqual({
      datum: '2026-09-30',
      quelle: 'rechnung',
    });
  });

  it('DPD und SendCloud bleiben ehrlich beim Abbuchungstag', () => {
    expect(leistungsdatum({ valueDate: '2026-09-22', paymtPurpose: DPD })).toEqual({
      datum: '2026-09-22',
      quelle: 'abbuchung',
    });
    expect(leistungsdatum({ valueDate: '2026-10-05', paymtPurpose: SENDCLOUD })).toEqual({
      datum: '2026-10-05',
      quelle: 'abbuchung',
    });
  });

  it('ignoriert ein Rechnungsdatum, das NACH der Abbuchung liegt', () => {
    // Ein Datum in der Zukunft ist kein Leistungsdatum, sondern ein Fremdwert.
    const r = leistungsdatum({ valueDate: '2026-09-01', paymtPurpose: 'RG 1/30.09.2026/' });
    expect(r).toEqual({ datum: '2026-09-01', quelle: 'abbuchung' });
  });

  it('ignoriert ein Rechnungsdatum, das unplausibel weit zurueckliegt', () => {
    const r = leistungsdatum({ valueDate: '2026-10-05', paymtPurpose: 'RG 1/01.01.2026/' });
    expect(r).toEqual({ datum: '2026-10-05', quelle: 'abbuchung' });
  });

  it('liefert ohne Abbuchungstag keins', () => {
    expect(leistungsdatum({ paymtPurpose: DHL })).toEqual({ datum: null, quelle: 'keins' });
  });

  it('nimmt den SevDesk-Zeitstempel mit Uhrzeit an', () => {
    expect(leistungsdatum({ valueDate: '2026-10-05T00:00:00+02:00', paymtPurpose: DPD }).datum).toBe('2026-10-05');
  });
});

describe('imFenster / addDays', () => {
  it('Fenster ist an beiden Enden inklusiv', () => {
    expect(imFenster('2026-09-01', '2026-09-01', '2026-09-30')).toBe(true);
    expect(imFenster('2026-09-30', '2026-09-01', '2026-09-30')).toBe(true);
    expect(imFenster('2026-10-01', '2026-09-01', '2026-09-30')).toBe(false);
    expect(imFenster(null, '2026-09-01', '2026-09-30')).toBe(false);
  });

  it('verlaengert das Abfragefenster ueber den Monatswechsel hinaus', () => {
    expect(addDays('2026-09-30', NACHLAUF_FENSTER_TAGE)).toBe('2026-11-04');
    expect(NACHLAUF_FENSTER_TAGE).toBeGreaterThanOrEqual(30);
  });
});
