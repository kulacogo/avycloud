// Regression for SendCloud v2→v3 migration (Incident 2026-07-10): "Creating
// parcels via API v2 is not available for this account. Please use API v3."
// _matchV3OptionCode resolves a chosen v2 shipping method (carrier/name/weight)
// to a v3 shipping_option_code.

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

const OPTIONS = [
  {
    code: 'dhl:small_parcel',
    carrier: { code: 'dhl', name: 'DHL' },
    product: { code: 'small_parcel', name: 'DHL Kleinpaket' },
    weight: { min: { value: '0.01' }, max: { value: '1' } },
    quotes: [{ price: { total: { value: '3.99' } } }],
  },
  {
    code: 'dhl:parcel',
    carrier: { code: 'dhl', name: 'DHL' },
    product: { code: 'parcel', name: 'DHL Paket' },
    weight: { min: { value: '0.01' }, max: { value: '5' } },
    quotes: [{ price: { total: { value: '5.49' } } }],
  },
  {
    code: 'dpd:classic',
    carrier: { code: 'dpd', name: 'DPD' },
    product: { code: 'classic', name: 'DPD Classic' },
    weight: { min: { value: '0.01' }, max: { value: '5' } },
    quotes: [{ price: { total: { value: '4.20' } } }],
  },
];

describe('_matchV3OptionCode', () => {
  it('matches carrier + product name to the right v3 code', () => {
    expect(_matchV3OptionCode(OPTIONS, { carrier: 'dhl', name: 'DHL Kleinpaket 0-1kg' }, 0.4)).toBe('dhl:small_parcel');
    expect(_matchV3OptionCode(OPTIONS, { carrier: 'dpd', name: 'DPD Classic 0-5kg' }, 0.4)).toBe('dpd:classic');
  });

  it('respects the weight range (excludes Kleinpaket above 1kg)', () => {
    // 2kg → DHL Kleinpaket (max 1kg) excluded → DHL Paket
    expect(_matchV3OptionCode(OPTIONS, { carrier: 'dhl', name: 'DHL' }, 2)).toBe('dhl:parcel');
  });

  it('prefers the cheapest option within the matched carrier', () => {
    // carrier dhl, no name → both DHL fit 0.4kg → cheaper (Kleinpaket 3.99) wins
    expect(_matchV3OptionCode(OPTIONS, { carrier: 'dhl' }, 0.4)).toBe('dhl:small_parcel');
  });

  it('returns null when the chosen carrier is not among v3 options (no silent carrier switch)', () => {
    expect(_matchV3OptionCode(OPTIONS, { carrier: 'gls', name: 'GLS Business' }, 0.4)).toBe(null);
  });

  it('returns null for empty options', () => {
    expect(_matchV3OptionCode([], { carrier: 'dhl' }, 0.4)).toBe(null);
    expect(_matchV3OptionCode(null, { carrier: 'dhl' }, 0.4)).toBe(null);
  });

  it('prefers the domestic variant over "international" for domestic shipments (Incident 2026-07-10 log)', () => {
    const dpOptions = [
      { code: 'dp:grossbrief_international/business,mailbox', carrier: { code: 'deutsche_post', name: 'DP' }, product: { name: 'Großbrief International' }, weight: { min: { value: '0.01' }, max: { value: '0.5' } }, quotes: [{ price: { total: { value: '1.60' } } }] },
      { code: 'dp:grossbrief/mailbox', carrier: { code: 'deutsche_post', name: 'DP' }, product: { name: 'Großbrief' }, weight: { min: { value: '0.01' }, max: { value: '0.5' } }, quotes: [{ price: { total: { value: '1.80' } } }] },
    ];
    // domestic → pick the non-international one even though it's pricier
    expect(_matchV3OptionCode(dpOptions, { carrier: 'deutsche_post', name: 'Großbrief' }, 0.4, { domestic: true })).toBe('dp:grossbrief/mailbox');
    // international → pick the international variant
    expect(_matchV3OptionCode(dpOptions, { carrier: 'deutsche_post', name: 'Großbrief' }, 0.4, { domestic: false })).toBe('dp:grossbrief_international/business,mailbox');
  });

  it('deprioritizes GoGreen/eco_delivery + add-on variants, picks the plain product (Incident 2026-07-10 DHL billing-number)', () => {
    // Real codes from the log: GoGreen is cheaper but its billing number is not
    // configured → must NOT be chosen; the plain product must win.
    const dhl = [
      { code: 'dhl_de:warenpost/gogreen', carrier: { code: 'dhl' }, product: { name: 'DHL Kleinpaket' }, weight: { min: { value: '0.01' }, max: { value: '1' } }, quotes: [{ price: { total: { value: '3.50' } } }] },
      { code: 'dhl_de:warenpost', carrier: { code: 'dhl' }, product: { name: 'DHL Kleinpaket' }, weight: { min: { value: '0.01' }, max: { value: '1' } }, quotes: [{ price: { total: { value: '3.99' } } }] },
      { code: 'dhl_de:paket_eco_delivery/home_address_only', carrier: { code: 'dhl' }, product: { name: 'DHL Paket' }, weight: { min: { value: '0.01' }, max: { value: '31.5' } }, quotes: [{ price: { total: { value: '3.20' } } }] },
      { code: 'dhl_de:dhl_paket', carrier: { code: 'dhl' }, product: { name: 'DHL Paket' }, weight: { min: { value: '0.01' }, max: { value: '31.5' } }, quotes: [{ price: { total: { value: '4.49' } } }] },
    ];
    // DHL Kleinpaket → plain warenpost (NOT the cheaper gogreen)
    expect(_matchV3OptionCode(dhl, { carrier: 'dhl', name: 'DHL Kleinpaket 0-1kg' }, 0.4, { domestic: true })).toBe('dhl_de:warenpost');
    // Generic DHL (no product name match) → plain product, never the eco/gogreen one
    const picked = _matchV3OptionCode(dhl, { carrier: 'dhl' }, 0.4, { domestic: true });
    expect(picked === 'dhl_de:warenpost' || picked === 'dhl_de:dhl_paket').toBe(true);
    expect(picked).not.toMatch(/gogreen|eco_delivery/);
  });

  it('falls back to the international variant only if NO domestic option exists', () => {
    const onlyIntl = [
      { code: 'dp:grossbrief_international/mailbox', carrier: { code: 'deutsche_post' }, product: { name: 'Großbrief International' }, weight: { min: { value: '0.01' }, max: { value: '0.5' } }, quotes: [{ price: { total: { value: '1.60' } } }] },
    ];
    expect(_matchV3OptionCode(onlyIntl, { carrier: 'deutsche_post', name: 'Großbrief' }, 0.4, { domestic: true })).toBe('dp:grossbrief_international/mailbox');
  });
});
