'use strict';

const {
  EBAY_ASPECT_HARD_CAP,
  PRIORITY_RANK,
  enforceAspectCap,
  prioritizeAspects,
  aspectsToRecord,
  _internal,
} = require('../../lib/aspect-cap-enforcer');

describe('aspect-cap-enforcer', () => {
  describe('constants', () => {
    it('exposes the eBay 45-aspect hard cap', () => {
      expect(EBAY_ASPECT_HARD_CAP).toBe(45);
    });

    it('ranks required < recommended < optional < unknown', () => {
      expect(PRIORITY_RANK.required).toBeLessThan(PRIORITY_RANK.recommended);
      expect(PRIORITY_RANK.recommended).toBeLessThan(PRIORITY_RANK.optional);
      expect(PRIORITY_RANK.optional).toBeLessThan(PRIORITY_RANK.unknown);
    });
  });

  describe('_internal.normalizeKey', () => {
    it('lowercases + trims + strips diacritics', () => {
      expect(_internal.normalizeKey('  Größe  ')).toBe('grosse');
      expect(_internal.normalizeKey('Marke')).toBe('marke');
    });

    it('returns empty string for non-strings', () => {
      expect(_internal.normalizeKey(null)).toBe('');
      expect(_internal.normalizeKey(42)).toBe('');
    });
  });

  describe('_internal.coerceAspectArray', () => {
    it('coerces a { key: value } record into a flat array', () => {
      const arr = _internal.coerceAspectArray({ Marke: 'Sony', Farbe: 'Schwarz' });
      expect(arr).toHaveLength(2);
      expect(arr[0]).toMatchObject({ key: 'Marke', value: 'Sony' });
    });

    it('coerces an array of {key,value,confidence} items', () => {
      const arr = _internal.coerceAspectArray([
        { key: 'Marke', value: 'Sony', confidence: 0.9 },
        { key: 'Farbe', value: 'Schwarz' },
      ]);
      expect(arr[0]).toEqual({ key: 'Marke', value: 'Sony', confidence: 0.9 });
      expect(arr[1].confidence).toBeNull();
    });

    it('drops entries without a key', () => {
      const arr = _internal.coerceAspectArray([{ value: 'Sony' }, { key: '', value: 'x' }]);
      expect(arr).toHaveLength(0);
    });

    it('handles nested { value: {value, confidence} } records', () => {
      const arr = _internal.coerceAspectArray({
        Marke: { value: 'Sony', confidence: 0.8 },
      });
      expect(arr[0]).toEqual({ key: 'Marke', value: 'Sony', confidence: 0.8 });
    });
  });

  describe('_internal.classifyPriority', () => {
    it('matches case-insensitively against required + recommended sets', () => {
      const req = new Set([_internal.normalizeKey('Marke')]);
      const rec = new Set([_internal.normalizeKey('Farbe')]);
      expect(_internal.classifyPriority('MARKE', req, rec)).toBe('required');
      expect(_internal.classifyPriority('Farbe', req, rec)).toBe('recommended');
      expect(_internal.classifyPriority('Gewicht', req, rec)).toBe('optional');
    });

    it('returns unknown when key is empty', () => {
      expect(_internal.classifyPriority('', new Set(), new Set())).toBe('unknown');
    });
  });

  describe('_internal.dedupeByKey', () => {
    it('keeps the entry with the highest confidence when key collides', () => {
      const out = _internal.dedupeByKey([
        { key: 'Marke', value: 'A', confidence: 0.6 },
        { key: 'Marke', value: 'B', confidence: 0.9 },
        { key: 'Farbe', value: 'Schwarz', confidence: null },
      ]);
      expect(out).toHaveLength(2);
      const marke = out.find((o) => _internal.normalizeKey(o.key) === 'marke');
      expect(marke.value).toBe('B');
    });

    it('treats "Marke" and "marke" as the same key', () => {
      const out = _internal.dedupeByKey([
        { key: 'Marke', value: 'A', confidence: 0.6 },
        { key: 'marke', value: 'B', confidence: 0.9 },
      ]);
      expect(out).toHaveLength(1);
    });
  });

  describe('prioritizeAspects', () => {
    it('sorts required before recommended before optional', () => {
      const out = prioritizeAspects(
        [
          { key: 'Gewicht', value: '300g' },
          { key: 'Farbe', value: 'Schwarz' },
          { key: 'Marke', value: 'Sony' },
        ],
        ['Marke'],
        ['Farbe']
      );
      expect(out.map((a) => a.priority)).toEqual(['required', 'recommended', 'optional']);
    });

    it('breaks ties by confidence desc', () => {
      const out = prioritizeAspects(
        [
          { key: 'A', value: 'x', confidence: 0.4 },
          { key: 'B', value: 'x', confidence: 0.9 },
        ],
        [],
        []
      );
      expect(out[0].key).toBe('B');
    });

    it('omits sort-internal fields from output', () => {
      const out = prioritizeAspects([{ key: 'Marke', value: 'Sony' }], ['Marke'], []);
      expect(out[0]).not.toHaveProperty('_sortKey');
      expect(out[0]).not.toHaveProperty('_originalIndex');
    });
  });

  describe('enforceAspectCap', () => {
    it('trims to the default cap of 45', () => {
      const manyAspects = Array.from({ length: 60 }, (_, i) => ({
        key: `Aspect${i}`,
        value: `Value${i}`,
        confidence: Math.random(),
      }));
      const { trimmed, removed, meta } = enforceAspectCap(manyAspects);
      expect(trimmed).toHaveLength(45);
      expect(removed).toHaveLength(15);
      expect(meta.inputCount).toBe(60);
      expect(meta.outputCount).toBe(45);
      expect(meta.cap).toBe(45);
    });

    it('respects a custom maxCap', () => {
      const aspects = Array.from({ length: 10 }, (_, i) => ({ key: `K${i}`, value: 'v' }));
      const { trimmed } = enforceAspectCap(aspects, { maxCap: 3 });
      expect(trimmed).toHaveLength(3);
    });

    it('keeps all required aspects even when input > cap', () => {
      const required = Array.from({ length: 5 }, (_, i) => `Required${i}`);
      const optionals = Array.from({ length: 50 }, (_, i) => ({
        key: `Optional${i}`,
        value: 'x',
        confidence: 0.5,
      }));
      const requireds = required.map((k) => ({ key: k, value: 'v', confidence: 0.7 }));

      // Input hat 5 required + 50 optional = 55 total
      const { trimmed, meta } = enforceAspectCap([...optionals, ...requireds], {
        requiredAspects: required,
        maxCap: 10,
      });

      const requiredKeys = trimmed
        .filter((a) => a.priority === 'required')
        .map((a) => a.key.toLowerCase());
      expect(requiredKeys).toHaveLength(5);
      expect(meta.requiredCount).toBe(5);
      expect(meta.optionalCount).toBe(5); // 10 cap - 5 required = 5 optional slots
    });

    it('flags required aspects that were missing in the input', () => {
      const { meta } = enforceAspectCap([{ key: 'Marke', value: 'Sony' }], {
        requiredAspects: ['Marke', 'Modell', 'Farbe'],
      });
      expect(meta.requiredMissing).toEqual(
        expect.arrayContaining(['modell', 'farbe'])
      );
      expect(meta.requiredMissing).not.toContain('marke');
    });

    it('deduplicates colliding keys before capping', () => {
      const { trimmed } = enforceAspectCap([
        { key: 'Marke', value: 'A', confidence: 0.5 },
        { key: 'MARKE', value: 'B', confidence: 0.9 },
        { key: 'Farbe', value: 'Schwarz', confidence: 0.7 },
      ]);
      expect(trimmed).toHaveLength(2);
      const marke = trimmed.find((a) => a.key.toLowerCase() === 'marke');
      expect(marke.value).toBe('B');
    });

    it('accepts a record input in addition to arrays', () => {
      const { trimmed } = enforceAspectCap({
        Marke: 'Sony',
        Farbe: 'Schwarz',
      }, { requiredAspects: ['Marke'] });
      expect(trimmed).toHaveLength(2);
      expect(trimmed[0].priority).toBe('required');
    });

    it('handles empty input without crashing', () => {
      const { trimmed, removed, meta } = enforceAspectCap([]);
      expect(trimmed).toEqual([]);
      expect(removed).toEqual([]);
      expect(meta.inputCount).toBe(0);
    });

    it('keeps higher-confidence optionals over lower-confidence ones', () => {
      const { trimmed } = enforceAspectCap(
        [
          { key: 'Low', value: 'x', confidence: 0.2 },
          { key: 'High', value: 'x', confidence: 0.9 },
          { key: 'Mid', value: 'x', confidence: 0.5 },
        ],
        { maxCap: 2 }
      );
      expect(trimmed.map((a) => a.key)).toEqual(['High', 'Mid']);
    });

    it('treats cap of 0 or negative as coerced to at least 1', () => {
      const { trimmed } = enforceAspectCap([{ key: 'A', value: 'x' }], { maxCap: 0 });
      expect(trimmed).toHaveLength(1);
    });
  });

  describe('aspectsToRecord', () => {
    it('converts a trimmed aspect array into a simple {key: value} record', () => {
      const rec = aspectsToRecord([
        { key: 'Marke', value: 'Sony' },
        { key: 'Farbe', value: 'Schwarz' },
      ]);
      expect(rec).toEqual({ Marke: 'Sony', Farbe: 'Schwarz' });
    });

    it('drops entries with empty key or empty value', () => {
      const rec = aspectsToRecord([
        { key: 'Marke', value: 'Sony' },
        { key: '', value: 'x' },
        { key: 'Farbe', value: '' },
      ]);
      expect(rec).toEqual({ Marke: 'Sony' });
    });

    it('returns {} for non-array input', () => {
      expect(aspectsToRecord(null)).toEqual({});
      expect(aspectsToRecord('x')).toEqual({});
    });
  });
});
