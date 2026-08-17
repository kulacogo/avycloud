'use strict';

/**
 * Versandbuchungen im Kontoauszug richtig einordnen.
 *
 * Gemessen 2026-08-17 an den echten Buchungen:
 *  - Die Erkennung liest NUR `payeePayerName`. 23 von 67 Buchungen haben dort
 *    null (Kartenzahlungen) — damit wurden **341,81 € (10,1 %)** uebersehen:
 *    304,91 € "SNDCLD SendCloud Munchen" und 36,90 € "DHL WSI SHIPMENT BONN".
 *  - Eine Portokassen-Aufladung ueber 200,00 € (DHL GROUP - DEUTSCHE POST AG)
 *    ist eine VORAUSZAHLUNG, kein Verbrauch. Ungefiltert landet ein halbes Jahr
 *    Briefporto in einem Monat.
 *
 * Der Zweck-Text wird bewusst NUR gelesen, wenn kein Name da ist — sonst
 * greift die urspruengliche Absicht nicht mehr ("keine Fehltreffer aus
 * Kundennotizen, die 'sendcloud' erwaehnen").
 */

const { kategorisiereVersandbuchung } = require('../lib/shipping-payment-categorize');

const b = (payeePayerName, paymtPurpose = '') => ({ payeePayerName, paymtPurpose });

describe('Fracht — die eigentlichen Versandkosten', () => {
  it('erkennt die echten Namen aus dem Kontoauszug', () => {
    expect(kategorisiereVersandbuchung(b('DHL PAKET GMBH'))).toBe('fracht');
    expect(kategorisiereVersandbuchung(b('DPD DEUTSCHLAND GMBH Wailandstrasse 1, 63641 Aschaffenburg'))).toBe('fracht');
    expect(kategorisiereVersandbuchung(b('Deutsche Post AG'))).toBe('fracht');
  });

  it('findet Kartenzahlungen ohne Namen ueber den Zweck — die uebersehenen 36,90 €', () => {
    expect(kategorisiereVersandbuchung(b(null, 'DHL WSI SHIPMENT BONN'))).toBe('fracht');
    expect(kategorisiereVersandbuchung(b('', 'DHL WSI SHIPMENT BONN'))).toBe('fracht');
  });
});

describe('Plattform — SendCloud-Rechnungen', () => {
  it('erkennt SendCloud am Namen', () => {
    expect(kategorisiereVersandbuchung(b('SendCloud GMBH Simon Carmiggeltstraat 1011 DJ AMSTERDAM 6-50'))).toBe('plattform');
  });

  it('findet die Kartenzahlung ueber den Zweck — die uebersehenen 304,91 €', () => {
    expect(kategorisiereVersandbuchung(b(null, 'SNDCLD SendCloud Munchen'))).toBe('plattform');
  });
});

describe('Vorauszahlung — Portokasse', () => {
  it('erkennt die Portokassen-Aufladung und trennt sie ab', () => {
    // 200,00 € Aufladung: das Geld ist weg, die Leistung noch nicht bezogen.
    expect(kategorisiereVersandbuchung(b('DHL GROUP - DEUTSCHE POST AG', 'Portokasse Aufladung'))).toBe('vorauszahlung');
    expect(kategorisiereVersandbuchung(b('Deutsche Post AG', 'PORTOKASSE 12345'))).toBe('vorauszahlung');
  });
});

describe('Was NICHT als Versand zaehlt', () => {
  it('ignoriert fremde Buchungen', () => {
    expect(kategorisiereVersandbuchung(b('Stadtwerke Musterstadt'))).toBe(null);
    expect(kategorisiereVersandbuchung(b('eBay S.a.r.l.'))).toBe(null);
    expect(kategorisiereVersandbuchung(b('cflox GmbH'))).toBe(null);
  });

  it('liest den Zweck NICHT, wenn ein Name da ist', () => {
    // Sonst faengt eine Kundennotiz "Ruecksendung via DHL" die Buchung ein.
    expect(kategorisiereVersandbuchung(b('Max Mustermann', 'Ruecksendung via DHL'))).toBe(null);
    expect(kategorisiereVersandbuchung(b('Amazon EU', 'sendcloud test'))).toBe(null);
  });

  it('vertraegt leere Buchungen', () => {
    expect(kategorisiereVersandbuchung(null)).toBe(null);
    expect(kategorisiereVersandbuchung({})).toBe(null);
    expect(kategorisiereVersandbuchung(b(null, null))).toBe(null);
  });
});
