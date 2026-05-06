'use strict';

// Local fallback for /api/v2/group-images when the Gemini-backed
// `groupImagesStructured` throws. Uses perceptual aHash (computed by
// lib/image-quality.js via sharp) to greedily cluster visually similar
// images. Last-resort 1-image-per-group with confidence 0.3 still kicks
// in if this fallback also fails (e.g. sharp not installed).

const { analyzeImage } = require('./image-quality');

const HASH_BITS = 64;
const HASH_HEX_CHARS = HASH_BITS / 4; // 16
const DEFAULT_MAX_DISTANCE = 10;
const HEX_REGEX = /^[0-9a-f]+$/i;

/**
 * Hamming distance between two hex-encoded 64-bit perceptual hashes.
 * Returns Infinity if either hash is missing or not a valid 16-char hex string.
 *
 * @param {string} hashA
 * @param {string} hashB
 * @returns {number}
 */
function hammingDistance(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return Infinity;
  if (hashA.length !== HASH_HEX_CHARS || hashB.length !== HASH_HEX_CHARS) return Infinity;
  if (!HEX_REGEX.test(hashA) || !HEX_REGEX.test(hashB)) return Infinity;

  let a;
  let b;
  try {
    a = BigInt('0x' + hashA);
    b = BigInt('0x' + hashB);
  } catch (_e) {
    return Infinity;
  }

  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    if (xor & 1n) distance += 1;
    xor >>= 1n;
  }
  return distance;
}

/**
 * Compute the bitwise majority "average" hash across a set of 16-char hex hashes.
 * Used as a representative descriptor for a cluster. Falls back to the first
 * valid hash when only one is present, or '' if none of the inputs are valid.
 *
 * @param {string[]} hashes
 * @returns {string}
 */
function averageHashes(hashes) {
  const valid = hashes.filter(
    (h) => typeof h === 'string' && h.length === HASH_HEX_CHARS && HEX_REGEX.test(h),
  );
  if (valid.length === 0) return '';
  if (valid.length === 1) return valid[0].toLowerCase();

  const counts = new Array(HASH_BITS).fill(0);
  for (const h of valid) {
    let big;
    try {
      big = BigInt('0x' + h);
    } catch (_e) {
      continue;
    }
    for (let i = 0; i < HASH_BITS; i++) {
      if ((big >> BigInt(i)) & 1n) counts[i] += 1;
    }
  }
  const threshold = valid.length / 2;
  let result = 0n;
  for (let i = 0; i < HASH_BITS; i++) {
    if (counts[i] > threshold) result |= 1n << BigInt(i);
  }
  return result.toString(16).padStart(HASH_HEX_CHARS, '0');
}

/**
 * Cluster images by perceptual hash similarity (greedy single-linkage; cluster
 * representative is the first member's hash). Images whose hash cannot be
 * computed (sharp missing, decode error, etc.) get their own singleton cluster.
 *
 * Output indices map to the position in the input `imageBuffers` array; clusters
 * are returned in the order in which they were created (deterministic for a
 * given input order).
 *
 * @param {Array<{buffer: Buffer, mimeType?: string}>} imageBuffers
 * @param {{ maxDistance?: number }} [opts]
 * @returns {Promise<Array<{ indices: number[], averageHash: string }>>}
 */
async function clusterImagesByPerceptualHash(imageBuffers, opts = {}) {
  if (!Array.isArray(imageBuffers) || imageBuffers.length === 0) return [];
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : DEFAULT_MAX_DISTANCE;

  const analyses = await Promise.all(
    imageBuffers.map(async (img, idx) => {
      const buffer = img && img.buffer;
      if (!buffer) return { idx, hash: '' };
      try {
        const result = await analyzeImage(buffer, { computeHash: true });
        const hash = result && typeof result.hash === 'string' ? result.hash : '';
        return { idx, hash };
      } catch (_e) {
        return { idx, hash: '' };
      }
    }),
  );

  /** @type {Array<{ representative: string, indices: number[], hashes: string[] }>} */
  const clusters = [];

  for (const { idx, hash } of analyses) {
    const isValid =
      typeof hash === 'string' && hash.length === HASH_HEX_CHARS && HEX_REGEX.test(hash);

    if (!isValid) {
      // Hash unavailable → singleton; cannot be merged with anything.
      clusters.push({ representative: '', indices: [idx], hashes: [] });
      continue;
    }

    let assigned = false;
    for (const cluster of clusters) {
      if (!cluster.representative) continue;
      const dist = hammingDistance(cluster.representative, hash);
      if (dist <= maxDistance) {
        cluster.indices.push(idx);
        cluster.hashes.push(hash);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({ representative: hash, indices: [idx], hashes: [hash] });
    }
  }

  return clusters.map((c) => ({
    indices: c.indices.slice(),
    averageHash: averageHashes(c.hashes),
  }));
}

/**
 * Build pseudo-Gemini-grouping output from a clustering result. Confidence is
 * 0.6 when the cluster has 2+ members (visual buddies → likely same product)
 * and 0.45 for singletons (no buddies → uncertain). German strings to match
 * the existing UX in the frontend.
 *
 * @param {Array<{ indices: number[], averageHash?: string }>} clusters
 */
function clustersToGroups(clusters) {
  if (!Array.isArray(clusters)) return [];
  return clusters.map((cluster, idx) => {
    const indices = Array.isArray(cluster && cluster.indices) ? cluster.indices.slice() : [];
    const isMulti = indices.length >= 2;
    return {
      id: `group_${idx}`,
      label: `Produkt ${idx + 1}`,
      image_indices: indices,
      confidence: isMulti ? 0.6 : 0.45,
      reason: isMulti
        ? 'Lokal gruppiert nach visueller Ähnlichkeit (KI nicht verfügbar)'
        : 'Lokal nicht eindeutig — bitte manuell prüfen',
      detected_barcode: null,
    };
  });
}

module.exports = {
  hammingDistance,
  clusterImagesByPerceptualHash,
  clustersToGroups,
};
