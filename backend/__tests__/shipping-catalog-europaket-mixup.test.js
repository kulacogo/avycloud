'use strict';
// REGRESSION — Auftrag 10-14999-44761 (2026-08-07, IT/2kg) und ~10 Tage davor:
//   SendCloud create parcel 400 "Please add the billing number for this product
//   in the DHL contract." pointer=non_field_errors
//
// Ursache: der Katalog-Eintrag „DHL Paket International" matchte ZWEI
// verschiedene DHL-Produkte. SendCloud selbst unterscheidet sie sauber:
//   dhl_de:weltpaket  → product.name „DHL Paket International"   (Vertrag OK)
//   dhl_de:europaket  → product.name „DHL Europaket"             (KEINE Abrechnungsnummer)
// Beide haben modifierCount 0 → der Sortier-Vergleich war ein Gleichstand und
// die stabile Sortierung übernahm die Reihenfolge der SendCloud-Antwort. Die
// ist aber NICHT deterministisch (an der Live-API gemessen: 4 identische
// Aufrufe, Reihenfolge kippte beim vierten). Damit war die Produktwahl ein
// Münzwurf.
//
// Belegt an 17 Prod-Läufen über 21 Tage, ohne eine einzige Ausnahme:
//   europaket gewählt (11×) → IMMER Billing-Fehler
//   weltpaket gewählt  (6×) → IMMER Erfolg
//
// Europaket ist zusätzlich gar nicht auf dem TrendOcean-Plakat — es darf nie
// als „DHL Paket International" verkauft werden (anderes Produkt, andere Preise).

const { resolveCuratedOptions } = require('../lib/shipping-catalog-resolver');

const opt = (code, min = 0.01, max = 31.501) => ({ code, weight: { min: { value: min }, max: { value: max } } });

// Beide Reihenfolgen, die die Live-API nachweislich liefert.
const EUROPAKET_ZUERST = [
  opt('dhl_de:europaket'),
  opt('dhl_de:weltpaket'),
  opt('dhl_de:weltpaket,flex_delivery'),
  opt('dpd:classic'),
];
const WELTPAKET_ZUERST = [
  opt('dhl_de:weltpaket'),
  opt('dhl_de:europaket'),
  opt('dhl_de:weltpaket,flex_delivery'),
  opt('dpd:classic'),
];

function dhlInt(liveOptions) {
  const { products } = resolveCuratedOptions(liveOptions, { country: 'IT', weightKg: 2 });
  return products.find((p) => p.key === 'dhl_paket_int') || null;
}

describe('DHL Paket International vs. DHL Europaket', () => {
  it('wählt weltpaket, wenn europaket in der Antwort ZUERST steht', () => {
    expect(dhlInt(EUROPAKET_ZUERST).shippingOptionCode).toBe('dhl_de:weltpaket');
  });

  it('wählt weltpaket auch, wenn weltpaket zuerst steht', () => {
    expect(dhlInt(WELTPAKET_ZUERST).shippingOptionCode).toBe('dhl_de:weltpaket');
  });

  it('ist unabhängig von der Reihenfolge der SendCloud-Antwort', () => {
    // Der eigentliche Kern: die Wahl darf NIE von der API-Reihenfolge abhängen.
    expect(dhlInt(EUROPAKET_ZUERST).shippingOptionCode)
      .toBe(dhlInt(WELTPAKET_ZUERST).shippingOptionCode);
  });

  it('bietet Europaket nie als kuratiertes Produkt an', () => {
    const { products } = resolveCuratedOptions([opt('dhl_de:europaket'), opt('dpd:classic')], { country: 'IT', weightKg: 2 });
    const codes = products.map((p) => p.shippingOptionCode);
    expect(codes).not.toContain('dhl_de:europaket');
  });

  it('lässt den DHL-Slot lieber ganz weg, als Europaket unterzuschieben', () => {
    // Wenn SendCloud für eine Lane NUR europaket liefert, ist kein DHL-Angebot
    // ehrlicher als ein Produkt, das am Vertrag scheitert. DPD bleibt wählbar.
    const { products } = resolveCuratedOptions([opt('dhl_de:europaket'), opt('dpd:classic')], { country: 'IT', weightKg: 2 });
    expect(products.find((p) => p.key === 'dhl_paket_int')).toBeUndefined();
    expect(products.find((p) => p.key === 'dpd_classic_europa')).toBeTruthy();
  });

  it('akzeptiert weiterhin die anderen Schreibweisen des echten Produkts', () => {
    for (const code of ['dhl_de:paket_international', 'dhl_de:dhl_paket_international']) {
      expect(dhlInt([opt(code), opt('dpd:classic')]).shippingOptionCode).toBe(code);
    }
  });
});
