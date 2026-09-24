'use strict';

// Read-only fan-out for listing joins. Bounded both in document count and RPCs;
// projections avoid downloading complete product histories for a stock column.
async function readDocumentBatches(firestore, refs, fieldMask) {
  const chunks = [];
  for (let i = 0; i < refs.length; i += 500) chunks.push(refs.slice(i, i + 500));
  const results = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (next < chunks.length) {
      const index = next++;
      results[index] = await firestore.getAll(...chunks[index], { fieldMask });
    }
  }));
  return results.flat();
}

module.exports = { readDocumentBatches };
