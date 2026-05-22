/**
 * Hardening Wave 3 — Firestore + Performance
 *
 * Verifies:
 *  - firestore.indexes.json contains the new composite indexes
 *  - GET /products supports optional ?limit/?offset pagination (additive)
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HARDEN Wave 3: composite indexes for hot queries', () => {
  it('firestore.indexes.json declares the new indexes', () => {
    const indexes = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'firestore.indexes.json'), 'utf8')
    );
    expect(Array.isArray(indexes.indexes)).toBe(true);

    function hasIndex(collectionGroup, fields) {
      return indexes.indexes.some((idx) => {
        if (idx.collectionGroup !== collectionGroup) return false;
        if (!Array.isArray(idx.fields) || idx.fields.length !== fields.length) return false;
        return fields.every((f, i) => idx.fields[i].fieldPath === f.fieldPath && idx.fields[i].order === f.order);
      });
    }

    expect(hasIndex('stock_operation_failures', [
      { fieldPath: 'tenantId', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'ASCENDING' },
    ])).toBe(true);

    expect(hasIndex('identificationJobs', [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'completedAt', order: 'ASCENDING' },
    ])).toBe(true);

    expect(hasIndex('improveJobs', [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'completedAt', order: 'ASCENDING' },
    ])).toBe(true);

    expect(hasIndex('stock_failure_alerts', [
      { fieldPath: 'tenantId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ])).toBe(true);
  });
});

describe('HARDEN Wave 3: GET /products pagination', () => {
  it('source code parses ?limit/?offset and returns pagination meta', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'routes', 'products.js'),
      'utf8'
    );

    // Locate the GET /products route body (first occurrence).
    const routeIdx = source.indexOf("router.get('/products'");
    expect(routeIdx).toBeGreaterThan(-1);
    const body = source.slice(routeIdx, routeIdx + 4000);

    expect(body).toMatch(/req\.query\?\.limit/);
    expect(body).toMatch(/req\.query\?\.offset/);
    expect(body).toMatch(/pagination\s*=\s*\{/);
    expect(body).toMatch(/hasMore/);
    expect(body).toMatch(/nextOffset/);
    // Cap to a sane upper bound (no unbounded page-size).
    expect(body).toMatch(/limitRaw\s*<=\s*5000/);
  });
});
