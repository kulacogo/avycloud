'use strict';

const {
  runAttributesWorker,
  DOMAIN,
  FINALIZE_ATTRIBUTES_DECLARATION,
  _testables,
} = require('../../../lib/identify-workers/attributes-worker');

describe('attributes-worker', () => {
  it('exposes correct DOMAIN constant', () => {
    expect(DOMAIN).toBe('attributes');
  });

  it('exports FINALIZE_ATTRIBUTES_DECLARATION with correct name', () => {
    expect(FINALIZE_ATTRIBUTES_DECLARATION).toBeDefined();
    expect(FINALIZE_ATTRIBUTES_DECLARATION.name).toBe('finalize_attributes');
  });

  it('returns ok:false when context.product is missing', async () => {
    const result = await runAttributesWorker({});
    expect(result.ok).toBe(false);
    expect(result.domain).toBe('attributes');
    expect(result.meta.error).toBeDefined();
  });

  it('returns empty item_specifics when no required aspects in context', async () => {
    const result = await runAttributesWorker({
      product: { identification: { name: 'Test Product' } },
      workerResults: {
        category: { resolved: { requiredAspects: [], recommendedAspects: [] } },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.resolved.item_specifics).toEqual([]);
  });

  it('returns unified shape { ok, domain, resolved, confidence, sources, meta }', async () => {
    const result = await runAttributesWorker({
      product: { identification: { name: 'Test' } },
      workerResults: { category: { resolved: { requiredAspects: [] } } },
    });
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('domain', 'attributes');
    expect(result).toHaveProperty('resolved');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('sources');
    expect(result).toHaveProperty('meta');
    expect(typeof result.meta.durationMs).toBe('number');
  });

  it('_testables.toAspectNameList handles arrays of strings and objects', () => {
    expect(_testables.toAspectNameList(['Marke', 'Farbe'])).toEqual(['Marke', 'Farbe']);
    expect(
      _testables.toAspectNameList([{ name: 'Marke' }, { localizedName: 'Farbe' }])
    ).toEqual(['Marke', 'Farbe']);
  });

  it('_testables.buildAspectMatcher resolves canonical names case-insensitively', () => {
    const matcher = _testables.buildAspectMatcher(['Marke'], ['Farbe']);
    expect(matcher('marke')).toBe('Marke');
    expect(matcher('MARKE')).toBe('Marke');
    expect(matcher('unknown')).toBeNull();
  });

  it('_testables.fillMissingRequired fills missing aspects with Unbekannt', () => {
    const filled = _testables.fillMissingRequired(
      [{ key: 'Marke', value: 'Sony' }],
      ['Marke', 'Farbe', 'Modell']
    );
    expect(filled.length).toBe(3);
    const farbe = filled.find((a) => a.key === 'Farbe');
    expect(farbe.value).toBe('Unbekannt');
    expect(farbe.confidence).toBe(0);
  });

  it('_testables.computeRequiredCoverage returns ratio 0..1', () => {
    const coverage = _testables.computeRequiredCoverage(
      [
        { key: 'Marke', value: 'Sony', confidence: 0.9 },
        { key: 'Farbe', value: 'Unbekannt', confidence: 0 },
      ],
      ['Marke', 'Farbe']
    );
    expect(coverage).toBeCloseTo(0.5, 2);
  });
});
