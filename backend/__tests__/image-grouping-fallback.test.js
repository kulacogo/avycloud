'use strict';

// Tests for backend/lib/image-grouping-fallback.js
//
// Mocking strategy: require.cache patching. vi.mock() does not reliably
// intercept CJS require() in Vitest 4.x for local modules (see
// __tests__/api/_patchLocalModules.js + __tests__/services/atomic-tools.test.js
// for the established pattern in this repo).

function patchLocalModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return resolved;
}

const analyzeImageMock = vi.fn();
patchLocalModule('../lib/image-quality', { analyzeImage: analyzeImageMock });

const {
  hammingDistance,
  clusterImagesByPerceptualHash,
  clustersToGroups,
} = require('../lib/image-grouping-fallback');

beforeEach(() => {
  analyzeImageMock.mockReset();
});

// ---------------------------------------------------------------------------
// hammingDistance
// ---------------------------------------------------------------------------

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance('abcdef0123456789', 'abcdef0123456789')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });

  it('returns 64 for fully inverted hashes', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });

  it('returns Infinity when either hash is empty', () => {
    expect(hammingDistance('', 'abcdef0123456789')).toBe(Infinity);
    expect(hammingDistance('abcdef0123456789', '')).toBe(Infinity);
    expect(hammingDistance('', '')).toBe(Infinity);
  });

  it('returns Infinity for null/undefined/non-string inputs', () => {
    expect(hammingDistance(null, 'abcdef0123456789')).toBe(Infinity);
    expect(hammingDistance(undefined, 'abcdef0123456789')).toBe(Infinity);
    expect(hammingDistance(123, 'abcdef0123456789')).toBe(Infinity);
    expect(hammingDistance('abcdef0123456789', null)).toBe(Infinity);
  });

  it('returns Infinity for hashes of wrong length', () => {
    expect(hammingDistance('abc', 'def')).toBe(Infinity);
    expect(hammingDistance('abcdef0123456789ff', 'abcdef0123456789')).toBe(Infinity);
  });

  it('returns Infinity for non-hex strings', () => {
    expect(hammingDistance('zzzzzzzzzzzzzzzz', 'abcdef0123456789')).toBe(Infinity);
  });

  it('counts bit differences correctly for known values', () => {
    // 0x...0001 vs 0x...0000 → 1 bit different
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1);
    // 0x...0003 vs 0x...0000 → 2 bits different
    expect(hammingDistance('0000000000000003', '0000000000000000')).toBe(2);
    // 0x...000F vs 0x...0000 → 4 bits different
    expect(hammingDistance('000000000000000f', '0000000000000000')).toBe(4);
    // 0x...00FF vs 0x...0000 → 8 bits different
    expect(hammingDistance('00000000000000ff', '0000000000000000')).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// clusterImagesByPerceptualHash
// ---------------------------------------------------------------------------

function bufferOf(label) {
  return Buffer.from(label);
}

describe('clusterImagesByPerceptualHash', () => {
  it('returns [] for empty input', async () => {
    const out = await clusterImagesByPerceptualHash([]);
    expect(out).toEqual([]);
    expect(analyzeImageMock).not.toHaveBeenCalled();
  });

  it('returns [] for null/undefined input', async () => {
    expect(await clusterImagesByPerceptualHash(null)).toEqual([]);
    expect(await clusterImagesByPerceptualHash(undefined)).toEqual([]);
  });

  it('groups 5 near-identical images (distance 0-3) into a single cluster', async () => {
    // Hashes differ only in the last hex nibble (≤4 bits flipped).
    const hashes = [
      '0000000000000000',
      '0000000000000001',
      '0000000000000003',
      '0000000000000002',
      '0000000000000007',
    ];
    analyzeImageMock.mockImplementation(async (buf) => {
      const idx = Number(buf.toString());
      return { hash: hashes[idx] };
    });

    const buffers = hashes.map((_, i) => ({ buffer: bufferOf(String(i)) }));
    const clusters = await clusterImagesByPerceptualHash(buffers, { maxDistance: 10 });

    expect(clusters).toHaveLength(1);
    expect(clusters[0].indices).toEqual([0, 1, 2, 3, 4]);
    expect(typeof clusters[0].averageHash).toBe('string');
    expect(clusters[0].averageHash).toHaveLength(16);
  });

  it('produces exactly 2 clusters when there are 3 + 2 visually similar images', async () => {
    // First 3 images cluster around 0x0...0; last 2 cluster around 0xffff_ffff_ffff_ff00.
    const hashes = [
      '0000000000000000',
      '0000000000000001',
      '0000000000000003',
      'ffffffffffffff00',
      'ffffffffffffff03',
    ];
    analyzeImageMock.mockImplementation(async (buf) => {
      const idx = Number(buf.toString());
      return { hash: hashes[idx] };
    });

    const buffers = hashes.map((_, i) => ({ buffer: bufferOf(String(i)) }));
    const clusters = await clusterImagesByPerceptualHash(buffers, { maxDistance: 10 });

    expect(clusters).toHaveLength(2);
    expect(clusters[0].indices).toEqual([0, 1, 2]);
    expect(clusters[1].indices).toEqual([3, 4]);
  });

  it('puts images with empty hash into their own singleton cluster', async () => {
    // Image 0 + 2 cluster, image 1 has no hash (sharp failed) → singleton.
    const hashes = ['0000000000000000', '', '0000000000000003'];
    analyzeImageMock.mockImplementation(async (buf) => {
      const idx = Number(buf.toString());
      return { hash: hashes[idx] };
    });

    const buffers = hashes.map((_, i) => ({ buffer: bufferOf(String(i)) }));
    const clusters = await clusterImagesByPerceptualHash(buffers, { maxDistance: 10 });

    expect(clusters).toHaveLength(2);
    // Cluster created in input order: idx 0 starts cluster A, idx 1 is singleton (created
    // when seen, before idx 2), idx 2 joins cluster A. So order is [A, singleton].
    expect(clusters[0].indices).toEqual([0, 2]);
    expect(clusters[1].indices).toEqual([1]);
    expect(clusters[1].averageHash).toBe('');
  });

  it('respects custom maxDistance threshold', async () => {
    // 8 bits apart → would cluster at default 10 but not at 4.
    const hashes = ['0000000000000000', '00000000000000ff'];
    analyzeImageMock.mockImplementation(async (buf) => {
      const idx = Number(buf.toString());
      return { hash: hashes[idx] };
    });

    const buffers = hashes.map((_, i) => ({ buffer: bufferOf(String(i)) }));

    const tight = await clusterImagesByPerceptualHash(buffers, { maxDistance: 4 });
    expect(tight).toHaveLength(2);

    analyzeImageMock.mockReset();
    analyzeImageMock.mockImplementation(async (buf) => {
      const idx = Number(buf.toString());
      return { hash: hashes[idx] };
    });

    const loose = await clusterImagesByPerceptualHash(buffers, { maxDistance: 10 });
    expect(loose).toHaveLength(1);
  });

  it('treats analyzeImage exceptions as missing hash (singleton)', async () => {
    analyzeImageMock.mockImplementation(async (buf) => {
      if (buf.toString() === '1') throw new Error('boom');
      return { hash: '0000000000000000' };
    });

    const buffers = [
      { buffer: bufferOf('0') },
      { buffer: bufferOf('1') },
      { buffer: bufferOf('2') },
    ];
    const clusters = await clusterImagesByPerceptualHash(buffers, { maxDistance: 10 });

    expect(clusters).toHaveLength(2);
    expect(clusters[0].indices).toEqual([0, 2]);
    expect(clusters[1].indices).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// clustersToGroups
// ---------------------------------------------------------------------------

describe('clustersToGroups', () => {
  it('singleton cluster → confidence 0.45 + "manuell prüfen" reason', () => {
    const groups = clustersToGroups([{ indices: [3], averageHash: '0000000000000000' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe(0.45);
    expect(groups[0].image_indices).toEqual([3]);
    expect(groups[0].reason).toBe('Lokal nicht eindeutig — bitte manuell prüfen');
    expect(groups[0].detected_barcode).toBeNull();
    expect(groups[0].id).toBe('group_0');
    expect(groups[0].label).toBe('Produkt 1');
  });

  it('multi-image cluster → confidence 0.6 + "visueller Ähnlichkeit" reason', () => {
    const groups = clustersToGroups([{ indices: [0, 1, 2], averageHash: '0000000000000000' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe(0.6);
    expect(groups[0].image_indices).toEqual([0, 1, 2]);
    expect(groups[0].reason).toBe('Lokal gruppiert nach visueller Ähnlichkeit (KI nicht verfügbar)');
  });

  it('handles mix of singleton + multi clusters with correct ids/labels', () => {
    const groups = clustersToGroups([
      { indices: [0, 1], averageHash: '0000000000000000' },
      { indices: [2], averageHash: 'ffffffffffffffff' },
      { indices: [3, 4, 5], averageHash: '00ff00ff00ff00ff' },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.id)).toEqual(['group_0', 'group_1', 'group_2']);
    expect(groups.map((g) => g.label)).toEqual(['Produkt 1', 'Produkt 2', 'Produkt 3']);
    expect(groups.map((g) => g.confidence)).toEqual([0.6, 0.45, 0.6]);
  });

  it('returns [] for invalid input', () => {
    expect(clustersToGroups(null)).toEqual([]);
    expect(clustersToGroups(undefined)).toEqual([]);
    expect(clustersToGroups('nope')).toEqual([]);
  });

  it('does not mutate input cluster.indices array', () => {
    const original = [0, 1, 2];
    const clusters = [{ indices: original, averageHash: '0000000000000000' }];
    const groups = clustersToGroups(clusters);
    groups[0].image_indices.push(99);
    expect(original).toEqual([0, 1, 2]);
  });
});
