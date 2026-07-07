// backend/__tests__/shipping-rule-matching.test.js
//
// Covers `matchCarrierRule` (single, used by shipOrder) and
// `matchAllCarrierRules` (preview, returns every rule that fits the weight)
// from backend/services/shipping-engine.js.
//
// Two regressions we explicitly guard against:
//   1. Existing tenants without `order` on rules must keep getting the
//      smallest-maxWeight match (legacy behaviour).
//   2. Once `order` is set via the OrderSettingsView drag-and-drop UI,
//      it MUST take precedence over `maxWeight`.

require('./api/_patchGcp');

// Stub external deps so requiring shipping-engine never opens a SendCloud session.
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null) },
  children: [], paths: [],
};

const {
  matchCarrierRule,
  matchAllCarrierRules,
  DEFAULT_CARRIER_RULES,
} = require('../services/shipping-engine');

describe('matchCarrierRule (single, legacy behaviour)', () => {
  it('returns the smallest-maxWeight match when no `order` is set', () => {
    // Mirrors DEFAULT_CARRIER_RULES — non-overlapping, no `order`.
    const result = matchCarrierRule({ weight: 0.8, rules: DEFAULT_CARRIER_RULES });
    expect(result).toMatchObject({ shippingMethodId: 2830, carrier: 'dhl' });
  });

  it('returns the largest rule when weight overflows every range', () => {
    const result = matchCarrierRule({ weight: 50, rules: DEFAULT_CARRIER_RULES });
    expect(result).toMatchObject({ shippingMethodId: 113, carrier: 'dpd' });
  });

  it('rundet Untergewicht auf die kleinste tragfähige Regel auf (statt null → Versand-Blocker)', () => {
    // 0,5 kg unter minWeight 1: die Regel kann das Paket physisch tragen
    // (maxWeight 5), also wird darüber versendet statt der Auto-Versand mit
    // "Keine passende Versandregel" zu scheitern.
    const rules = [{ minWeight: 1, maxWeight: 5, shippingMethodId: 111, carrier: 'dpd', label: 'DPD' }];
    expect(matchCarrierRule({ weight: 0.5, rules })).toMatchObject({ shippingMethodId: 111 });
  });

  it('deckt Lücken zwischen Regeln ab (nächstgrößere Regel gewinnt)', () => {
    // 4,995 kg liegt in der Lücke zwischen 4,99 und 5 der Standardregeln.
    // Vorher: null → shipOrder wirft. Jetzt: nächste Regel, die es trägt (5-9,99).
    const result = matchCarrierRule({ weight: 4.995, rules: DEFAULT_CARRIER_RULES });
    expect(result).toMatchObject({ shippingMethodId: 112, carrier: 'dpd' });
  });

  it('leichte Bestellung unter der kleinsten Standard-Regel bekommt die kleinste Regel', () => {
    // 0,3 kg: Standardregeln beginnen erst bei 0,5 kg. Vorher null → Blocker.
    const result = matchCarrierRule({ weight: 0.3, rules: DEFAULT_CARRIER_RULES });
    expect(result).toMatchObject({ shippingMethodId: 2830, carrier: 'dhl' });
  });

  it('returns null only when there are no rules at all', () => {
    expect(matchCarrierRule({ weight: 0.5, rules: [] })).toBeNull();
  });

  it('honours `order` (drag-and-drop priority) over maxWeight', () => {
    // Two overlapping rules at 1 kg. Without `order`, the smaller-max rule (DHL)
    // would win. With `order`, DP Maxibrief (lower number = higher priority) wins.
    const rules = [
      { id: 'a', minWeight: 0.01, maxWeight: 1, shippingMethodId: 2830, carrier: 'dhl', label: 'DHL Kleinpaket', order: 5 },
      { id: 'b', minWeight: 0.01, maxWeight: 1, shippingMethodId: 1224, carrier: 'dp', label: 'DP Maxibrief',    order: 0 },
    ];
    const result = matchCarrierRule({ weight: 1, rules });
    expect(result).toMatchObject({ shippingMethodId: 1224, carrier: 'dp' });
  });

  it('falls back to legacy sort when only some rules carry `order`', () => {
    // Mixed: rule with `order` first, others (no order) by maxWeight.
    const rules = [
      { id: 'a', minWeight: 0.01, maxWeight: 1, shippingMethodId: 2830, carrier: 'dhl', label: 'DHL Kleinpaket' },
      { id: 'b', minWeight: 0.01, maxWeight: 1, shippingMethodId: 1224, carrier: 'dp', label: 'DP Maxibrief', order: 0 },
    ];
    const result = matchCarrierRule({ weight: 1, rules });
    // Rule b has explicit order=0 → wins over rule a (no order).
    expect(result).toMatchObject({ shippingMethodId: 1224 });
  });
});

describe('matchAllCarrierRules (preview)', () => {
  it('returns every rule containing the weight, sorted by `order`', () => {
    const rules = [
      { id: 'a', minWeight: 0.01, maxWeight: 1, shippingMethodId: 2830, carrier: 'dhl', label: 'DHL Kleinpaket', order: 0 },
      { id: 'b', minWeight: 0.01, maxWeight: 1, shippingMethodId: 1224, carrier: 'dp',  label: 'DP Maxibrief',    order: 1 },
      { id: 'c', minWeight: 0.01, maxWeight: 0.5, shippingMethodId: 1269, carrier: 'dp', label: 'DP Großbrief', order: 2 },
      { id: 'd', minWeight: 1,    maxWeight: 2.1, shippingMethodId: 341,  carrier: 'dhl', label: 'DHL Paket 0-2kg', order: 3 },
    ];

    const matches = matchAllCarrierRules({ weight: 1, rules });
    // 1 kg matches a, b, d (boundary inclusive on both ends), not c (0.5 < 1).
    expect(matches.map((m) => m.id)).toEqual(['a', 'b', 'd']);
    expect(matches[0]).toMatchObject({
      shippingMethodId: 2830,
      minWeight: 0.01,
      maxWeight: 1,
      order: 0,
    });
  });

  it('returns 2 matches for the 2-kg user-story example', () => {
    // Reproduces the user's stated business case:
    //   2 kg → DHL Paket 0-2 kg + DPD Classic 0-5 kg.
    const rules = [
      { id: 'd', minWeight: 1, maxWeight: 2.1, shippingMethodId: 341, carrier: 'dhl', label: 'DHL Paket 0-2kg' },
      { id: 'e', minWeight: 1, maxWeight: 5,   shippingMethodId: 111, carrier: 'dpd', label: 'DPD Classic 0-5 kg' },
      { id: 'f', minWeight: 5, maxWeight: 10,  shippingMethodId: 112, carrier: 'dpd', label: 'DPD Classic 5-10 kg' },
    ];
    const matches = matchAllCarrierRules({ weight: 2, rules });
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.id).sort()).toEqual(['d', 'e']);
  });

  it('returns [] when weight is null/NaN', () => {
    expect(matchAllCarrierRules({ weight: null, rules: DEFAULT_CARRIER_RULES })).toEqual([]);
    expect(matchAllCarrierRules({ weight: NaN, rules: DEFAULT_CARRIER_RULES })).toEqual([]);
  });

  it('returns [] when no rules are configured', () => {
    expect(matchAllCarrierRules({ weight: 1, rules: [] })).toEqual([]);
    expect(matchAllCarrierRules({ weight: 1, rules: null })).toEqual([]);
  });
});
