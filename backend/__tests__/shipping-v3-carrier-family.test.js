// REGRESSION GUARD — Incident 2026-07-11 (Order 01-14899-17819):
//
// Deutsche-Post-Versandart gewählt (methodMeta.carrier='dp'), erzeugt wurde
// ein DPD-Label ("dpd:parcelletter"). Root-Cause: der Carrier-Filter in
// _matchV3OptionCode matchte beidseitig per Substring —
// 'dpd'.includes('dp') === true, also überlebten DPD-Optionen den
// dp-Filter. Anschließend gewann die Addon-Sortierung (möglichst wenige
// Zusatzdienste) QUER über die Carrier: dpd:parcelletter (0 Addons) schlug
// dp:maxibrief_integral/extra_fee,mailbox,signature (3 Addons).
//
// Erwartung seit Fix: Carrier-Match ist EXAKT auf Carrier-Familien-Ebene
// (Alias-Tabelle für echte Synonyme wie dhl↔dhl_de, dp↔deutsche_post) —
// nie Substring. Ein Carrier-Wechsel passiert NIE stillschweigend (null →
// Cross-Carrier-Fallback mit Warnung beim Aufrufer).

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

// Nachbau der echten v3-Optionsliste aus den Incident-Logs (11:34:54 UTC,
// "[v3] shipping-options: 72 für DE/0.4kg").
const INCIDENT_OPTIONS = [
  {
    code: 'dpd:parcelletter',
    carrier: { code: 'dpd', name: 'DPD' },
    product: { code: 'parcelletter', name: 'DPD Parcelletter' },
    weight: { min: { value: '0.01' }, max: { value: '1' } },
    quotes: [{ price: { total: { value: '3.10' } } }],
  },
  {
    code: 'dpd:classic/kp',
    carrier: { code: 'dpd', name: 'DPD' },
    product: { code: 'classic', name: 'DPD Classic Kleinpaket' },
    weight: { min: { value: '0.01' }, max: { value: '5' } },
    quotes: [{ price: { total: { value: '4.20' } } }],
  },
  {
    code: 'dp:maxibrief_integral/extra_fee,mailbox,signature',
    carrier: { code: 'dp', name: 'Deutsche Post' },
    product: { code: 'maxibrief_integral', name: 'Deutsche Post Maxibrief Integral' },
    weight: { min: { value: '0.01' }, max: { value: '1' } },
    quotes: [{ price: { total: { value: '2.75' } } }],
  },
  {
    code: 'dp:global_mail/tracked',
    carrier: { code: 'dp', name: 'Deutsche Post' },
    product: { code: 'global_mail', name: 'Deutsche Post Global Mail Tracked' },
    weight: { min: { value: '0.01' }, max: { value: '1' } },
    quotes: [{ price: { total: { value: '5.80' } } }],
  },
  {
    code: 'dhl_de:dhl_paket/home_only',
    carrier: { code: 'dhl_de', name: 'DHL' },
    product: { code: 'dhl_paket', name: 'DHL Paket' },
    weight: { min: { value: '0.01' }, max: { value: '31.5' } },
    quotes: [{ price: { total: { value: '5.49' } } }],
  },
];

describe('_matchV3OptionCode — Carrier-Familien statt Substring (Incident 01-14899-17819)', () => {
  it('Deutsche Post (dp) gewählt → NIE eine dpd:*-Option (auch wenn der Methodenname nicht substring-matcht)', () => {
    // Realer Incident-Shape: der v2-Methodenname ("Maxibrief bis 1 kg") matcht
    // KEINEN v3-Produktnamen als Substring → der Name-Filter greift nicht und
    // vor dem Fix entschied die Addon-Sortierung QUER über die Carrier
    // (dpd:parcelletter hat 0 Addons und gewann gegen dp:maxibrief mit 3).
    const code = _matchV3OptionCode(
      INCIDENT_OPTIONS,
      { carrier: 'dp', name: 'Maxibrief bis 1 kg' },
      0.4,
      { domestic: true }
    );
    expect(code).toBeTruthy();
    expect(code.startsWith('dp:')).toBe(true);
    expect(code.startsWith('dpd')).toBe(false);
  });

  it('dpd gewählt → dpd-Option (Familie dpd bleibt für dpd erreichbar)', () => {
    const code = _matchV3OptionCode(
      INCIDENT_OPTIONS,
      { carrier: 'dpd', name: 'DPD Classic 0-5 kg' },
      0.4,
      { domestic: true }
    );
    expect(code).toBeTruthy();
    expect(code.startsWith('dpd:')).toBe(true);
  });

  it('Alias-Familie: interner Code deutsche_post matcht SendCloud-Carrier dp', () => {
    const code = _matchV3OptionCode(
      INCIDENT_OPTIONS,
      { carrier: 'deutsche_post', name: 'Maxibrief' },
      0.4,
      { domestic: true }
    );
    expect(code).toBeTruthy();
    expect(code.startsWith('dp:')).toBe(true);
  });

  it('Alias-Familie: interner Code dhl matcht SendCloud-Carrier dhl_de (und nie dhl_express)', () => {
    const withExpress = [
      ...INCIDENT_OPTIONS,
      {
        code: 'dhl_express:express_worldwide',
        carrier: { code: 'dhl_express', name: 'DHL Express' },
        product: { code: 'express_worldwide', name: 'DHL Express Worldwide' },
        weight: { min: { value: '0.01' }, max: { value: '31.5' } },
        quotes: [{ price: { total: { value: '1.99' } } }],
      },
    ];
    const code = _matchV3OptionCode(withExpress, { carrier: 'dhl', name: 'DHL Paket' }, 0.4, { domestic: true });
    expect(code).toBe('dhl_de:dhl_paket/home_only');
  });

  it('gewählter Carrier existiert nicht in den Optionen → null (kein stiller Wechsel)', () => {
    const code = _matchV3OptionCode(
      INCIDENT_OPTIONS,
      { carrier: 'gls', name: 'GLS Paket' },
      0.4,
      { domestic: true }
    );
    expect(code).toBe(null);
  });
});
