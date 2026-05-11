'use strict';

/**
 * firestore-indexes.test.js
 *
 * Sanity-Test für `firestore.indexes.json`:
 *   1. Datei ist syntaktisch valides JSON.
 *   2. Top-Level-Shape: { indexes: [...], fieldOverrides: [...] }.
 *   3. Jeder Index hat collectionGroup, queryScope, fields[] mit
 *      fieldPath + (order|arrayConfig).
 *   4. Die Cassini-Backfill-kritischen Composite-Indexes existieren
 *      (tenantId ASC + identifyCheckedAtIso ASC | DESC, dito V3-Variante).
 *
 * Hintergrund: `backend/scripts/cassini-backfill.js` läuft mit
 * `orderBy('identifyCheckedAtIso','asc')` — der ASC-Index ist daher
 * Pflicht, sonst stirbt der Backfill mit "FAILED_PRECONDITION".
 */

const fs = require('fs');
const path = require('path');

const INDEXES_PATH = path.resolve(__dirname, '..', '..', 'firestore.indexes.json');

function loadIndexes() {
  const raw = fs.readFileSync(INDEXES_PATH, 'utf-8');
  return JSON.parse(raw);
}

function findIndex(indexes, { collectionGroup, fields }) {
  return indexes.find((idx) => {
    if (idx.collectionGroup !== collectionGroup) return false;
    if (!Array.isArray(idx.fields) || idx.fields.length !== fields.length) return false;
    return fields.every((expected, i) => {
      const actual = idx.fields[i];
      if (!actual) return false;
      if (actual.fieldPath !== expected.fieldPath) return false;
      if (expected.order && actual.order !== expected.order) return false;
      return true;
    });
  });
}

describe('firestore.indexes.json', () => {
  it('is valid JSON', () => {
    expect(() => loadIndexes()).not.toThrow();
  });

  it('has the expected top-level shape', () => {
    const data = loadIndexes();
    expect(Array.isArray(data.indexes)).toBe(true);
    expect(Array.isArray(data.fieldOverrides)).toBe(true);
  });

  it('every index has collectionGroup, queryScope, and valid fields[]', () => {
    const data = loadIndexes();
    for (const idx of data.indexes) {
      expect(typeof idx.collectionGroup).toBe('string');
      expect(idx.collectionGroup.length).toBeGreaterThan(0);
      expect(typeof idx.queryScope).toBe('string');
      expect(Array.isArray(idx.fields)).toBe(true);
      expect(idx.fields.length).toBeGreaterThan(0);
      for (const f of idx.fields) {
        expect(typeof f.fieldPath).toBe('string');
        expect(f.fieldPath.length).toBeGreaterThan(0);
        // Each field needs either `order` or `arrayConfig`.
        expect(Boolean(f.order) || Boolean(f.arrayConfig)).toBe(true);
      }
    }
  });

  describe('Cassini-Backfill prerequisites', () => {
    it('contains products_v2 (tenantId ASC, identifyCheckedAtIso ASC)', () => {
      const data = loadIndexes();
      const found = findIndex(data.indexes, {
        collectionGroup: 'products_v2',
        fields: [
          { fieldPath: 'tenantId', order: 'ASCENDING' },
          { fieldPath: 'identifyCheckedAtIso', order: 'ASCENDING' },
        ],
      });
      expect(found).toBeDefined();
    });

    it('contains products_v2 (tenantId ASC, identifyCheckedAtIso DESC)', () => {
      const data = loadIndexes();
      const found = findIndex(data.indexes, {
        collectionGroup: 'products_v2',
        fields: [
          { fieldPath: 'tenantId', order: 'ASCENDING' },
          { fieldPath: 'identifyCheckedAtIso', order: 'DESCENDING' },
        ],
      });
      expect(found).toBeDefined();
    });

    it('contains products_v2 (tenantId ASC, identifyV3CheckedAtIso ASC)', () => {
      const data = loadIndexes();
      const found = findIndex(data.indexes, {
        collectionGroup: 'products_v2',
        fields: [
          { fieldPath: 'tenantId', order: 'ASCENDING' },
          { fieldPath: 'identifyV3CheckedAtIso', order: 'ASCENDING' },
        ],
      });
      expect(found).toBeDefined();
    });

    it('contains products_v2 (tenantId ASC, identifyV3CheckedAtIso DESC)', () => {
      const data = loadIndexes();
      const found = findIndex(data.indexes, {
        collectionGroup: 'products_v2',
        fields: [
          { fieldPath: 'tenantId', order: 'ASCENDING' },
          { fieldPath: 'identifyV3CheckedAtIso', order: 'DESCENDING' },
        ],
      });
      expect(found).toBeDefined();
    });
  });
});
