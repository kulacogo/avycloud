const {
  getNestedField,
  setNestedField,
  evaluateCondition,
  evaluateConditions,
  applyAction,
  applyActions,
} = require('../services/rule-engine');

/* ─── getNestedField ─── */

describe('getNestedField', () => {
  const obj = { a: { b: { c: 42 } }, name: 'Test', tags: ['foo', 'bar'] };

  it('returns top-level field', () => {
    expect(getNestedField(obj, 'name')).toBe('Test');
  });

  it('returns deeply nested field', () => {
    expect(getNestedField(obj, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing path', () => {
    expect(getNestedField(obj, 'a.b.missing')).toBeUndefined();
  });

  it('returns undefined for null object', () => {
    expect(getNestedField(null, 'a')).toBeUndefined();
  });

  it('handles array fields', () => {
    expect(getNestedField(obj, 'tags')).toEqual(['foo', 'bar']);
  });
});

/* ─── setNestedField ─── */

describe('setNestedField', () => {
  it('sets top-level field', () => {
    const obj = {};
    setNestedField(obj, 'name', 'Test');
    expect(obj.name).toBe('Test');
  });

  it('sets deeply nested field, creating intermediates', () => {
    const obj = {};
    setNestedField(obj, 'a.b.c', 99);
    expect(obj.a.b.c).toBe(99);
  });

  it('overwrites existing nested field', () => {
    const obj = { a: { b: 1 } };
    setNestedField(obj, 'a.b', 2);
    expect(obj.a.b).toBe(2);
  });
});

/* ─── evaluateCondition — 10 Operators ─── */

describe('evaluateCondition', () => {
  const product = {
    name: 'Samsung Galaxy S24',
    price: 799.99,
    description: 'Premium Smartphone with AI features',
    brand: '',
    tags: [],
    details: { pricing: { sellPrice: 699 } },
  };

  // String operators
  it('equals — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'equals', value: 'samsung galaxy s24' })).toBe(true);
  });
  it('equals — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'equals', value: 'iPhone' })).toBe(false);
  });

  it('not_equals — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'not_equals', value: 'iPhone' })).toBe(true);
  });
  it('not_equals — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'not_equals', value: 'samsung galaxy s24' })).toBe(false);
  });

  it('contains — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'contains', value: 'Galaxy' })).toBe(true);
  });
  it('contains — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'contains', value: 'Pixel' })).toBe(false);
  });

  it('not_contains — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'not_contains', value: 'Pixel' })).toBe(true);
  });
  it('not_contains — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'not_contains', value: 'Galaxy' })).toBe(false);
  });

  it('starts_with — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'starts_with', value: 'Samsung' })).toBe(true);
  });
  it('starts_with — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'starts_with', value: 'Apple' })).toBe(false);
  });

  it('ends_with — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'ends_with', value: 'S24' })).toBe(true);
  });
  it('ends_with — false', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'ends_with', value: 'S23' })).toBe(false);
  });

  // Numeric operators
  it('greater_than — true', () => {
    expect(evaluateCondition(product, { field: 'price', operator: 'greater_than', value: 500 })).toBe(true);
  });
  it('greater_than — false', () => {
    expect(evaluateCondition(product, { field: 'price', operator: 'greater_than', value: 1000 })).toBe(false);
  });

  it('less_than — true', () => {
    expect(evaluateCondition(product, { field: 'price', operator: 'less_than', value: 1000 })).toBe(true);
  });
  it('less_than — false', () => {
    expect(evaluateCondition(product, { field: 'price', operator: 'less_than', value: 500 })).toBe(false);
  });

  // Existence operators
  it('is_empty — true for empty string', () => {
    expect(evaluateCondition(product, { field: 'brand', operator: 'is_empty' })).toBe(true);
  });
  it('is_empty — true for null/missing', () => {
    expect(evaluateCondition(product, { field: 'missing_field', operator: 'is_empty' })).toBe(true);
  });
  it('is_empty — true for empty array', () => {
    expect(evaluateCondition(product, { field: 'tags', operator: 'is_empty' })).toBe(true);
  });
  it('is_empty — false for non-empty', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'is_empty' })).toBe(false);
  });

  it('is_not_empty — true', () => {
    expect(evaluateCondition(product, { field: 'name', operator: 'is_not_empty' })).toBe(true);
  });
  it('is_not_empty — false', () => {
    expect(evaluateCondition(product, { field: 'brand', operator: 'is_not_empty' })).toBe(false);
  });

  // Nested field
  it('works with nested fields', () => {
    expect(evaluateCondition(product, { field: 'details.pricing.sellPrice', operator: 'greater_than', value: 500 })).toBe(true);
  });
});

/* ─── evaluateConditions — AND Logic ─── */

describe('evaluateConditions', () => {
  const product = { name: 'Test', price: 100 };

  it('returns true when ALL conditions match', () => {
    expect(evaluateConditions(product, [
      { field: 'name', operator: 'equals', value: 'test' },
      { field: 'price', operator: 'greater_than', value: 50 },
    ])).toBe(true);
  });

  it('returns false when ONE condition fails', () => {
    expect(evaluateConditions(product, [
      { field: 'name', operator: 'equals', value: 'test' },
      { field: 'price', operator: 'greater_than', value: 200 },
    ])).toBe(false);
  });

  it('returns false for empty conditions array', () => {
    expect(evaluateConditions(product, [])).toBe(false);
  });
});

/* ─── applyAction — 5 Action Types ─── */

describe('applyAction', () => {
  it('set_field', () => {
    const product = { name: 'Old' };
    const change = applyAction(product, { type: 'set_field', field: 'name', value: 'New' });
    expect(change).toEqual({ field: 'name', oldValue: 'Old', newValue: 'New' });
    expect(product.name).toBe('New');
  });

  it('adjust_price — absolute', () => {
    const product = { price: 100 };
    const change = applyAction(product, { type: 'adjust_price', field: 'price', value: -10, params: { mode: 'absolute' } });
    expect(change.newValue).toBe(90);
  });

  it('adjust_price — percent', () => {
    const product = { price: 100 };
    const change = applyAction(product, { type: 'adjust_price', field: 'price', value: 10, params: { mode: 'percent' } });
    expect(change.newValue).toBe(110);
  });

  it('prepend_text', () => {
    const product = { name: 'Widget' };
    const change = applyAction(product, { type: 'prepend_text', field: 'name', value: '[NEU] ' });
    expect(change.newValue).toBe('[NEU] Widget');
  });

  it('append_text', () => {
    const product = { name: 'Widget' };
    const change = applyAction(product, { type: 'append_text', field: 'name', value: ' (Neu)' });
    expect(change.newValue).toBe('Widget (Neu)');
  });

  it('replace_text', () => {
    const product = { name: 'Hello World' };
    const change = applyAction(product, { type: 'replace_text', field: 'name', value: null, params: { search: 'World', replace: 'Earth' } });
    expect(change.newValue).toBe('Hello Earth');
  });

  it('returns null when value unchanged', () => {
    const product = { name: 'Same' };
    const change = applyAction(product, { type: 'set_field', field: 'name', value: 'Same' });
    expect(change).toBeNull();
  });

  it('set_field on nested path', () => {
    const product = { details: { pricing: { sellPrice: 100 } } };
    const change = applyAction(product, { type: 'set_field', field: 'details.pricing.sellPrice', value: 200 });
    expect(change.newValue).toBe(200);
    expect(product.details.pricing.sellPrice).toBe(200);
  });
});

/* ─── applyActions — Sequential ─── */

describe('applyActions', () => {
  it('applies multiple actions sequentially', () => {
    const product = { name: 'Old', price: 100 };
    const changes = applyActions(product, [
      { type: 'set_field', field: 'name', value: 'New' },
      { type: 'adjust_price', field: 'price', value: 50, params: { mode: 'absolute' } },
    ]);
    expect(changes).toHaveLength(2);
    expect(product.name).toBe('New');
    expect(product.price).toBe(150);
  });

  it('skips no-op changes', () => {
    const product = { name: 'Same' };
    const changes = applyActions(product, [
      { type: 'set_field', field: 'name', value: 'Same' },
    ]);
    expect(changes).toHaveLength(0);
  });
});
