'use strict';

const { deriveCostModel, estimatedUnitCost, DEFAULT_COST_CONFIG } = require('../../lib/cost-model');

describe('deriveCostModel — pallet economics', () => {
  it('derives netto unit cost and a sell-proportional ratio from pallet price + units', () => {
    // 400€ brutto / 1.19 = 336.13€ netto per pallet ; / 18 = 18.67€ netto per unit.
    // avg sell price (brutto) 30€ → ratio = 18.67 / 30 = 0.6224
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);
    expect(m.avgUnitCostNetto).toBeCloseTo(18.66, 1);
    expect(m.ratio).toBeCloseTo(0.622, 2);
    expect(m.usable).toBe(true);
    expect(m.source).toBe('pallet');
  });

  it('uses the full brutto price as cost when vatMode = brutto', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'brutto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);
    expect(m.avgUnitCostNetto).toBeCloseTo(22.22, 1); // 400/18, no VAT removed
  });

  it('honours a manual ratio override regardless of pallet inputs', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto', manualRatio: 0.4 }, 30);
    expect(m.ratio).toBe(0.4);
    expect(m.source).toBe('manual');
    expect(m.usable).toBe(true);
  });

  it('is not usable when pallet inputs are missing and no manual ratio', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto' }, 30);
    expect(m.usable).toBe(false);
    expect(m.ratio).toBeNull();
  });

  it('is not usable for proportional mode without an average sell price', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 0);
    expect(m.usable).toBe(false); // can't form a ratio
    expect(m.avgUnitCostNetto).toBeCloseTo(18.66, 1); // unit cost still known
  });

  it('flat mode is usable without an average sell price (constant per-unit cost)', () => {
    const m = deriveCostModel({ mode: 'flat', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 0);
    expect(m.usable).toBe(true);
    expect(m.mode).toBe('flat');
  });
});

describe('estimatedUnitCost', () => {
  it('proportional: cost = sell price × ratio', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);
    // a 50€ item costs more than a 10€ item — proportional to value
    expect(estimatedUnitCost(50, m)).toBeCloseTo(50 * m.ratio, 1);
    expect(estimatedUnitCost(10, m)).toBeCloseTo(10 * m.ratio, 1);
    expect(estimatedUnitCost(50, m)).toBeGreaterThan(estimatedUnitCost(10, m));
  });

  it('flat: every unit gets the same average cost regardless of price', () => {
    const m = deriveCostModel({ mode: 'flat', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);
    expect(estimatedUnitCost(50, m)).toBeCloseTo(m.avgUnitCostNetto, 2);
    expect(estimatedUnitCost(10, m)).toBeCloseTo(m.avgUnitCostNetto, 2);
  });

  it('returns 0 when the model is not usable', () => {
    const m = deriveCostModel({ mode: 'proportional', vatMode: 'netto' }, 30);
    expect(estimatedUnitCost(50, m)).toBe(0);
  });
});

describe('DEFAULT_COST_CONFIG', () => {
  it('is disabled by default (no pallet inputs → no estimated COGS until configured)', () => {
    const m = deriveCostModel(DEFAULT_COST_CONFIG, 30);
    expect(m.usable).toBe(false);
  });
});
