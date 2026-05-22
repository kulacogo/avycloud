/**
 * Tests for the id_category injection feature added 2026-05-22.
 *
 * Background: Kaufland's product-data validator silently rejects all
 * attributes when an EAN auto-resolves to category 46001 "Sonstiges-
 * Sonstiges". Passing ?id_category=<X> as query param forces validation
 * against the named category instead. Verified live against EAN
 * 4060413606127 (stub product 559526566) where with idCategory=52671 the
 * validator started accepting manufacturer + product_safety_contact instead
 * of returning attribute_values=[].
 *
 * What we lock down here:
 *  - putProductData honours the optional idCategory param as query
 *  - patchProductData honours it too
 *  - omitted idCategory does NOT add the query param (back-compat)
 *  - decideCategory builds the correct POST /categories/decide call and
 *    surfaces the response.data as { id_category, title_singular, ... }
 */

// ─── 1. Stub secret-values so signing works ──────────────────────────────────
const secretValuesPath = require.resolve('../../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath,
  filename: secretValuesPath,
  loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('test-secret') },
  children: [],
  paths: [],
};

// ─── 2. Stub node-fetch with a recording queue ───────────────────────────────
const nodeFetchPath = require.resolve('node-fetch');
const fetchCalls = [];
const responseQueue = [];
const fetchStub = vi.fn(async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!responseQueue.length) {
    throw new Error(`fetch stub queue exhausted (url=${url})`);
  }
  return responseQueue.shift();
});
require.cache[nodeFetchPath] = {
  id: nodeFetchPath,
  filename: nodeFetchPath,
  loaded: true,
  exports: fetchStub,
  children: [],
  paths: [],
};

// Force-reload kaufland-api so it picks up the stubs
const kauflandApiPath = require.resolve('../../lib/kaufland-api');
delete require.cache[kauflandApiPath];
const { putProductData, patchProductData, decideCategory } = require('../../lib/kaufland-api');

function mockOk(json) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  };
}

beforeEach(() => {
  fetchCalls.length = 0;
  responseQueue.length = 0;
});

describe('putProductData id_category query injection', () => {
  it('adds ?id_category=N when idCategory is provided', async () => {
    responseQueue.push(mockOk({ data: 'Content created or replaced' }));
    await putProductData({
      ean: '4060413606127',
      attributes: { title: ['Test'] },
      idCategory: 52671,
    });
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url;
    expect(url).toMatch(/\/product-data\?/);
    expect(url).toContain('locale=de-DE');
    expect(url).toContain('id_category=52671');
  });

  it('omits id_category when none provided (back-compat)', async () => {
    responseQueue.push(mockOk({ data: 'Content created or replaced' }));
    await putProductData({
      ean: '4060413606127',
      attributes: { title: ['Test'] },
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).not.toContain('id_category');
  });

  it('ignores non-positive or non-numeric idCategory', async () => {
    responseQueue.push(mockOk({ data: 'ok' }));
    await putProductData({
      ean: '4060413606127',
      attributes: { title: ['Test'] },
      idCategory: 0,
    });
    expect(fetchCalls[0].url).not.toContain('id_category');

    fetchCalls.length = 0;
    responseQueue.push(mockOk({ data: 'ok' }));
    await putProductData({
      ean: '4060413606127',
      attributes: { title: ['Test'] },
      idCategory: 'not-a-number',
    });
    expect(fetchCalls[0].url).not.toContain('id_category');
  });
});

describe('patchProductData id_category query injection', () => {
  it('adds ?id_category=N when idCategory is provided', async () => {
    responseQueue.push(mockOk({ data: 'ok' }));
    await patchProductData({
      ean: '4060413606127',
      attributes: { title: ['Test'] },
      idCategory: 52671,
    });
    expect(fetchCalls[0].opts.method).toBe('PATCH');
    expect(fetchCalls[0].url).toContain('id_category=52671');
  });
});

describe('decideCategory', () => {
  it('builds POST /categories/decide with correct body + storefront query', async () => {
    responseQueue.push(mockOk({
      data: [
        { id_category: 52671, name: 'trainingsanzuege', title_singular: 'Trainingsanzug', title_plural: 'Trainingsanzüge', level: 4, is_leaf: true, id_parent_category: 52621, shipping_category: 'D', variable_fee: 13, fixed_fee: 0, vat: 19, url: '' },
        { id_category: 69054, name: 'sonstige-shirts', title_singular: 'Sonstiges Shirt', title_plural: 'Sonstige Shirts', level: 4, is_leaf: true, id_parent_category: 21171, shipping_category: 'D', variable_fee: 14, fixed_fee: 0, vat: 19, url: '' },
      ],
    }));

    const result = await decideCategory({
      title: 'Adidas Performance T-Shirt',
      description: 'Performance shirt 100% polyester',
      manufacturer: 'Adidas',
      priceCents: 2999,
      storefront: 'de',
    });

    expect(fetchCalls).toHaveLength(1);
    const { url, opts } = fetchCalls[0];
    expect(opts.method).toBe('POST');
    expect(url).toContain('/categories/decide');
    expect(url).toContain('storefront=de');
    const body = JSON.parse(opts.body);
    expect(body.item.title).toBe('Adidas Performance T-Shirt');
    expect(body.item.manufacturer).toBe('Adidas');
    expect(body.price).toBe(2999);
    expect(result).toHaveLength(2);
    expect(result[0].id_category).toBe(52671);
    expect(result[0].title_singular).toBe('Trainingsanzug');
    expect(result[0].is_leaf).toBe(true);
  });

  it('throws when required fields missing', async () => {
    await expect(decideCategory({ title: '', description: 'x', manufacturer: 'y', priceCents: 100 }))
      .rejects.toThrow(/non-empty title/);
    await expect(decideCategory({ title: 'x', description: '', manufacturer: 'y', priceCents: 100 }))
      .rejects.toThrow(/non-empty title/);
    await expect(decideCategory({ title: 'x', description: 'y', manufacturer: '', priceCents: 100 }))
      .rejects.toThrow(/non-empty title/);
  });

  it('throws when priceCents is invalid', async () => {
    await expect(decideCategory({ title: 'x', description: 'y', manufacturer: 'z', priceCents: 0 }))
      .rejects.toThrow(/priceCents/);
    await expect(decideCategory({ title: 'x', description: 'y', manufacturer: 'z', priceCents: -5 }))
      .rejects.toThrow(/priceCents/);
  });

  it('returns [] when API responds with no suggestions', async () => {
    responseQueue.push(mockOk({ data: [] }));
    const result = await decideCategory({
      title: 'x', description: 'y', manufacturer: 'z', priceCents: 100,
    });
    expect(result).toEqual([]);
  });
});
