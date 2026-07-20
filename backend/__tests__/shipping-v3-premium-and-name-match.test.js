// REGRESSION GUARD — Versandlabel-Richtigkeit (2026-07-20):
//
// 1) PREMIUM-VERBOT FÜR WARENSENDUNGEN: Eine Nicht-Premium-Wahl (Regel oder
//    Operator) darf NIE still auf eine "+Premium"-Variante upgraden. Premium
//    wird nur gewählt, wenn der Methodenname es explizit sagt — analog zum
//    GoGreen-Guard (separate Abrechnungsnummer, Incident 2026-07-10).
//
// 2) GEWICHTS-SUFFIX IM NAMEN: v2-Methodennamen tragen Gewichtsbereiche
//    ("DHL Kleinpaket 0-1kg", "DPD Classic 0-5kg"). Der alte Digit-Strip
//    (/[0-9]+/g) ließ das "kg" stehen → "dhlkleinpaketkg" matchte NIE das
//    v3-Produkt "DHL Kleinpaket" → Name-Filter griff nicht → Addon-Sortierung
//    entschied bei Preis-Gleichstand (v3 liefert oft keine Quotes) per
//    API-Reihenfolge. Betroffen: ALLE vier DEFAULT_CARRIER_RULES.
//
// Fixtures = reale v3 shipping-options Responses (Live-Probe 2026-07-20,
// DE->DE und DE->AT, 0.63 kg).

require('./api/_patchGcp');

const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null), listSenderAddresses: vi.fn() },
  children: [], paths: [],
};

const { _matchV3OptionCode } = require('../services/shipping-engine');

const opt = (code, carrierCode, productName, min, max) => ({
  code,
  carrier: { code: carrierCode, name: carrierCode },
  product: { code: code.split(':')[1]?.split('/')[0] || '', name: productName },
  weight: { min: { value: String(min) }, max: { value: String(max) } },
  quotes: [], // real: v3 liefert im Announce-Flow keine Quotes → Preis-Tiebreak ist Infinity
});

// DE->AT (international), Auszug der echten 34 Optionen. weltpaket ABSICHTLICH
// zuerst: vor dem Fix entschied bei leerem Name-Filter die API-Reihenfolge.
const AT_OPTIONS = [
  opt('dhl_de:weltpaket', 'dhl_de', 'DHL Paket International', 0.01, 31.501),
  opt('dhl_de:weltpaket/premium', 'dhl_de', 'DHL Paket International', 0.01, 31.501),
  opt('dhl_de:warenpostinternational/premium', 'dhl_de', 'DHL Warenpost International Premium', 0.01, 1.001),
  opt('dhl_de:warenpostinternational/premium,eco_delivery', 'dhl_de', 'DHL Warenpost International Premium', 0.01, 1.001),
  opt('dhl_de:warenpostinternational', 'dhl_de', 'DHL Warenpost International', 0.01, 1.001),
  opt('dhl_de:warenpostinternational/eco_delivery', 'dhl_de', 'DHL Warenpost International', 0.01, 1.001),
  opt('dhl_de:europaket', 'dhl_de', 'DHL Europaket', 0.01, 31.501),
  opt('dpd:classic', 'dpd', 'DPD Classic', 0.001, 31.501),
  opt('dp:global_mail/tracked', 'dp', 'Deutsche Post International Tracked', 0.001, 2.001),
];

// DE->DE (domestic), Auszug der echten 65 Optionen. dhl_paket ABSICHTLICH vor
// warenpost, parcelletter vor classic.
const DE_OPTIONS = [
  opt('dhl_de:dhl_paket', 'dhl_de', 'DHL Paket', 0.01, 31.501),
  opt('dhl_de:dhl_paket/flex_delivery', 'dhl_de', 'DHL Paket', 0.01, 31.501),
  opt('dhl_de:warenpost,service_point', 'dhl_de', 'DHL Kleinpaket to Locker', 0.01, 1.001),
  opt('dhl_de:warenpost/gogreen', 'dhl_de', 'DHL Kleinpaket', 0.01, 1.001),
  opt('dhl_de:warenpost', 'dhl_de', 'DHL Kleinpaket', 0.01, 1.001),
  opt('dhl_de:warenpost/filial_routing', 'dhl_de', 'DHL Kleinpaket + Filial Routing', 0.01, 1.001),
  opt('dpd:parcelletter', 'dpd', 'DPD Parcelletter', 0.001, 1.001),
  opt('dpd:express/delivery=12', 'dpd', 'DPD Express', 0.001, 31.501),
  opt('dpd:classic', 'dpd', 'DPD Classic', 0.001, 31.501),
  opt('dpd:classic/kp', 'dpd', 'DPD Classic', 0.001, 3.001),
  opt('dp:maxibrief/mailbox', 'dp', 'Brief (kompakt/groß/maxi)', 0.001, 1.001),
  opt('dp:bucherwarensendung/mailbox', 'dp', 'Warensendung', 0.001, 1.001),
  opt('dp:global_mail/tracked', 'dp', 'Deutsche Post International Tracked', 0.001, 2.001),
];

describe('_matchV3OptionCode — Gewichts-Suffix im Methodennamen (Default-Versandregeln)', () => {
  it('DHL Kleinpaket 0-1kg (Default-Regel cr-1) → dhl_de:warenpost, NIE dhl_paket oder Locker', () => {
    const code = _matchV3OptionCode(
      DE_OPTIONS,
      { carrier: 'dhl', name: 'DHL Kleinpaket 0-1kg' },
      0.63,
      { domestic: true }
    );
    expect(code).toBe('dhl_de:warenpost');
  });

  it('DPD Classic 0-5kg (Default-Regel cr-2) → dpd:classic, NIE parcelletter', () => {
    const code = _matchV3OptionCode(
      DE_OPTIONS,
      { carrier: 'dpd', name: 'DPD Classic 0-5kg' },
      0.63,
      { domestic: true }
    );
    expect(code).toBe('dpd:classic');
  });

  it('DHL Warenpost International 0.6-0.7kg (gestaffelte Live-Methode) → plain, NIE /premium', () => {
    const code = _matchV3OptionCode(
      AT_OPTIONS,
      { carrier: 'dhl_de', name: 'DHL Warenpost International 0.6-0.7kg' },
      0.63,
      { domestic: false }
    );
    expect(code).toBe('dhl_de:warenpostinternational');
  });
});

describe('_matchV3OptionCode — Warensendungen nie still Premium', () => {
  it('DHL Warenpost International (plain gewählt) → plain, nicht /premium und nicht /eco_delivery', () => {
    const code = _matchV3OptionCode(
      AT_OPTIONS,
      { carrier: 'dhl_de', name: 'DHL Warenpost International' },
      0.63,
      { domestic: false }
    );
    expect(code).toBe('dhl_de:warenpostinternational');
  });

  it('explizit "DHL Warenpost International Premium" gewählt → Premium bleibt (kein Overcorrect)', () => {
    const code = _matchV3OptionCode(
      AT_OPTIONS,
      { carrier: 'dhl_de', name: 'DHL Warenpost International Premium' },
      0.63,
      { domestic: false }
    );
    expect(code).toBe('dhl_de:warenpostinternational/premium');
  });

  it('nur Premium-Warenpost fürs Ziel verfügbar → Premium ist ok (kein Ausweichen auf falsches Produkt)', () => {
    const onlyPremium = AT_OPTIONS.filter((o) => o.code !== 'dhl_de:warenpostinternational' && o.code !== 'dhl_de:warenpostinternational/eco_delivery');
    const code = _matchV3OptionCode(
      onlyPremium,
      { carrier: 'dhl_de', name: 'DHL Warenpost International' },
      0.63,
      { domestic: false }
    );
    expect(code).toBe('dhl_de:warenpostinternational/premium');
  });

  it('Tie-Fall [eco_delivery, premium] ohne plain → Premium gewinnt DETERMINISTISCH (eco scheitert am Announce)', () => {
    // Review-Finding 2026-07-20: Premium-Penalty muss KLEINER als die
    // GoGreen/eco-Penalty sein, sonst entscheidet die API-Reihenfolge.
    const ecoFirst = [
      opt('dhl_de:warenpostinternational/eco_delivery', 'dhl_de', 'DHL Warenpost International', 0.01, 1.001),
      opt('dhl_de:warenpostinternational/premium', 'dhl_de', 'DHL Warenpost International Premium', 0.01, 1.001),
    ];
    const code = _matchV3OptionCode(
      ecoFirst,
      { carrier: 'dhl_de', name: 'DHL Warenpost International' },
      0.63,
      { domestic: false }
    );
    expect(code).toBe('dhl_de:warenpostinternational/premium');
  });

  it('Deutsche Post Warensendung → dp:bucherwarensendung/mailbox (nationales Nicht-Premium-Produkt)', () => {
    const code = _matchV3OptionCode(
      DE_OPTIONS,
      { carrier: 'dp', name: 'Warensendung' },
      0.63,
      { domestic: true }
    );
    expect(code).toBe('dp:bucherwarensendung/mailbox');
  });
});
