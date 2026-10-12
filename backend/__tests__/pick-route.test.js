'use strict';
const { rankPickCandidates, compareBins, parseBin, lastPickBin, planOrderBins } = require('../services/pick-route');
const o = (id, bins, createdAt = '2026-10-12T07:00:00Z') => ({ id, createdAt, routeBins: bins });
const ids = (orders, anchor) => rankPickCandidates(orders, anchor).map(x => x.id);

describe('warehouse route across orders', () => {
  it('groups zones instead of following interleaved order arrival', () => {
    expect(ids([o('l1', ['LEG0101A']), o('x1', ['XEG0101A']), o('s1', ['SEG0101A']),
      o('x2', ['XEG0201A']), o('l2', ['LEG0201A'])])).toEqual(['x2', 'x1', 's1', 'l2', 'l1']);
  });
  it('continues in the last confirmed zone and aisle, including work behind the cursor', () => {
    expect(ids([o('x', ['XEG0101A']), o('s-back', ['SEG0403A']), o('s-forward', ['SEG0401A']),
      o('s-other-aisle', ['SEG0201A'])], 'SEG0402A')).toEqual(['s-forward', 's-back', 's-other-aisle', 'x']);
  });
  it('does not interrupt the warehouse round at order-day boundaries; FIFO breaks location ties', () => {
    expect(ids([o('new', ['SEG0402A']), o('old', ['LEG0101A'], '2026-10-11T12:00:00Z')], 'SEG0402A')).toEqual(['new', 'old']);
    expect(ids([o('b', ['SEG0101A'], '2026-10-12T08:00:00Z'), o('a', ['SEG0101A'])])).toEqual(['a', 'b']);
  });
  it('ranks at the first actual stop of the whole order, not an attractive later stop', () => {
    expect(ids([o('detour', ['LEG0101A', 'XEG0101A']), o('local', ['LEG0201A'])], 'LEG0202A')).toEqual(['local', 'detour']);
  });
  it('continues forward across zones before wrapping to new work behind the picker', () => {
    expect(ids([o('behind', ['XEG0101A']), o('ahead', ['LEG0101A'])], 'SEG0101A')).toEqual(['ahead', 'behind']);
  });
  it('has deterministic fallback for unknown locations and supports timestamp dates', () => {
    expect(ids([o('unknown', []), o('known', ['LEG0101A'])])).toEqual(['known', 'unknown']);
    expect(ids([o('b', []), o('a', [])])).toEqual(['a', 'b']);
    expect(ids([o('new', ['LEG0101A']), { ...o('old', ['LEG0101A']), createdAt: { toDate: () => new Date('2026-10-11T00:00:00Z') } }])).toEqual(['old', 'new']);
  });
  it('supports real child BINs and rejects malformed partial numbers', () => {
    expect(parseBin('SEG0102G02')).toMatchObject({ zone: 'S', gang: 1, regal: 2, child: '02' });
    expect(compareBins('SEG0102G02', 'SEG0102G10')).toBeLessThan(0);
    expect(parseBin('SEG1X02G')).toBeNull();
    expect(parseBin('PGA0101A')).toMatchObject({ zone: 'P' });
  });
  it('only uses a confirmed position, never a hint or guessed ordering of historical receipts', () => {
    expect(lastPickBin({ pickWork: { lastBinCode: 'SEG0201A' } })).toBe('SEG0201A');
    expect(lastPickBin({ pickWork: { receipts: { a: { binCode: 'SEG0201A' }, b: { binCode: 'SEG0201A' } } } })).toBe('SEG0201A');
    expect(lastPickBin({ pickWork: { receipts: { a: { binCode: 'SEG0201A' }, b: { binCode: 'LEG0201A' } } } })).toBeNull();
  });
  it('mirrors quantity-first BIN selection and accounts for repeated item demand without mutating inputs', () => {
    const product = { id: 'p', storageBins: [{ code: 'SEG0201A', quantity: 1 }, { code: 'LEG0201A', quantity: 2 }] };
    const order = { items: [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1 }] };
    expect(planOrderBins(order, () => product)).toEqual(['SEG0201A', 'LEG0201A']);
    expect(product.storageBins[1].quantity).toBe(2);
    expect(planOrderBins({ items: [{ quantity: 3 }] }, () => product)).toEqual(['LEG0201A']);
    expect(planOrderBins({ items: [{ quantity: 1 }] }, () => ({ id: 'empty', storageBins: [{ code: 'SEG0101A', quantity: 0 }] }))).toEqual([]);
  });
});
