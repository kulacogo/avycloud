'use strict';
// globals: true in vitest.config.js — describe/it/expect sind global
//
// REGRESSION — Auftrag 07-14991-66886 (2026-08-04, belgischer Käufer):
// eBay lieferte in GetOrders nachweislich
//     ShippingAddress.CityName   = 2000
//     ShippingAddress.PostalCode = "Antwerpen"
// Der Käufer hatte die Felder auf eBay vertauscht eingetippt; eBay validiert
// internationale Adressfelder nicht und reicht sie roh durch. Unser Intake
// mappte KORREKT (city←CityName, zip←PostalCode) — und speicherte damit eine
// Adresse, aus der niemals ein Label werden konnte. Erst SendCloud meldete
// "Enter a valid zip code.", 40 Minuten nach dem Auftragseingang.
//
// Der Intake korrigiert den Tausch jetzt an der QUELLE, damit Rechnung,
// Lieferschein, Adresslabel und Versandlabel dieselbe — richtige — Adresse
// sehen. Nur bei Beweis: PLZ nachweislich ungültig fürs Land UND Stadt ist
// eine gültige PLZ desselben Landes.

const { mapEbayOrder } = require('../services/order-intake-ebay');

function ebayOrderWith(shippingAddress) {
  return {
    OrderID: '07-14991-66886',
    CreatedTime: '2026-08-04T12:03:00.000Z',
    Total: { '#text': '25.46', '@_currencyID': 'EUR' },
    ShippingAddress: shippingAddress,
    TransactionArray: { Transaction: [] },
  };
}

describe('mapEbayOrder — vertauschte PLZ/Stadt von eBay', () => {
  it('dreht den echten Vorfall zurück (BE: PostalCode="Antwerpen", CityName=2000)', () => {
    const mapped = mapEbayOrder(ebayOrderWith({
      Name: 'Buseyne Eric',
      Street1: 'Generaal Belliardstraat 9',
      CityName: 2000,
      PostalCode: 'Antwerpen',
      Country: 'BE',
    }));

    expect(mapped.customer.zip).toBe('2000');
    expect(mapped.customer.city).toBe('Antwerpen');
  });

  it('lässt eine korrekte niederländische Adresse unverändert', () => {
    // 9645CW/Veendam ist gültig — darf NIE "korrigiert" werden.
    const mapped = mapEbayOrder(ebayOrderWith({
      Name: 'Jan Jansen',
      Street1: 'Kerkstraat 12',
      CityName: 'Veendam',
      PostalCode: '9645CW',
      Country: 'NL',
    }));

    expect(mapped.customer.zip).toBe('9645CW');
    expect(mapped.customer.city).toBe('Veendam');
  });

  it('lässt eine korrekte deutsche Adresse unverändert', () => {
    const mapped = mapEbayOrder(ebayOrderWith({
      Name: 'Max Mustermann',
      Street1: 'Musterstr 5',
      CityName: 'Schleiden',
      PostalCode: '53937',
      Country: 'DE',
    }));

    expect(mapped.customer.zip).toBe('53937');
    expect(mapped.customer.city).toBe('Schleiden');
  });

  it('rät nicht, wenn nur die PLZ kaputt ist', () => {
    const mapped = mapEbayOrder(ebayOrderWith({
      Name: 'Test', Street1: 'Teststr 1',
      CityName: 'Antwerpen', PostalCode: 'ABC', Country: 'BE',
    }));

    expect(mapped.customer.zip).toBe('ABC');
    expect(mapped.customer.city).toBe('Antwerpen');
  });
});
