const { readDocumentBatches } = require('../../lib/firestore-read-batches');

describe('readDocumentBatches', () => {
  it('projects all refs, keeps missing docs and input order, and bounds concurrency', async () => {
    let active = 0, peak = 0;
    const db = { getAll: vi.fn(async (...args) => {
      expect(args.pop()).toEqual({ fieldMask: ['tenantId', 'storageBins'] });
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, args[0] === 0 ? 12 : 1));
      active--;
      return args.map(id => ({ id, exists: id !== 8 }));
    }) };
    const refs = Array.from({ length: 2101 }, (_, i) => i);
    const docs = await readDocumentBatches(db, refs, ['tenantId', 'storageBins']);
    expect(docs.map(d => d.id)).toEqual(refs);
    expect(docs[8].exists).toBe(false);
    expect(db.getAll).toHaveBeenCalledTimes(5);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
  it('does no IO for empty refs and propagates failures instead of returning partial rows', async () => {
    const db = { getAll: vi.fn().mockRejectedValue(new Error('offline')) };
    expect(await readDocumentBatches(db, [], ['x'])).toEqual([]);
    expect(db.getAll).not.toHaveBeenCalled();
    await expect(readDocumentBatches(db, ['p'], ['x'])).rejects.toThrow('offline');
  });
});
