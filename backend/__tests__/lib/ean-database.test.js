'use strict';

// Vitest globals: describe, it, expect, vi, beforeEach, afterEach are injected automatically
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

function makeFetchResponse(body, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  });
}

describe('ean-database', () => {
  let lookupEan;

  beforeEach(() => {
    vi.resetModules();
    const mod = require('../../lib/ean-database');
    lookupEan = mod.lookupEan;
  });

  it('returns product data for valid EAN from Open EAN DB', async () => {
    fetchMock.mockImplementationOnce(() =>
      makeFetchResponse({
        name: 'Sony WH-1000XM5',
        brand: 'Sony',
        maincat: 'Elektronik',
        descr: 'Premium-Kopfhoerer',
        img: 'https://example.com/img.jpg',
      })
    );

    const result = await lookupEan('4548736132610');
    expect(result.found).toBe(true);
    expect(result.source).toBe('open_ean_db');
    expect(result.productName).toBe('Sony WH-1000XM5');
    expect(result.brand).toBe('Sony');
    expect(result.category).toBe('Elektronik');
    expect(result.imageUrl).toBe('https://example.com/img.jpg');
  });

  it('returns null fields for unknown EAN', async () => {
    // Open EAN DB returns empty
    fetchMock.mockImplementationOnce(() => makeFetchResponse({}));
    // UPCItemDB returns empty
    fetchMock.mockImplementationOnce(() => makeFetchResponse({ items: [] }));

    const result = await lookupEan('4006381333931');
    expect(result.found).toBe(false);
    expect(result.source).toBeNull();
    expect(result.productName).toBeNull();
  });

  it('falls back to UPCItemDB when Open EAN DB fails', async () => {
    // Open EAN DB throws
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('Network error')));
    // UPCItemDB returns data
    fetchMock.mockImplementationOnce(() =>
      makeFetchResponse({
        items: [{
          title: 'Test Product',
          brand: 'TestBrand',
          category: 'Home',
          description: 'A test product',
          images: ['https://example.com/upc.jpg'],
        }],
      })
    );

    const result = await lookupEan('4548736132610');
    expect(result.found).toBe(true);
    expect(result.source).toBe('upcitemdb');
    expect(result.productName).toBe('Test Product');
    expect(result.brand).toBe('TestBrand');
    expect(result.imageUrl).toBe('https://example.com/upc.jpg');
  });

  it('handles timeout gracefully (returns empty result)', async () => {
    // Both sources abort
    fetchMock.mockImplementation(() => {
      const controller = new AbortController();
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });

    const result = await lookupEan('4548736132610');
    expect(result.found).toBe(false);
    expect(result.source).toBeNull();
  });

  it('validates EAN format before lookup', async () => {
    const result = await lookupEan('INVALID');
    expect(result.found).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty result for null/undefined input', async () => {
    const result1 = await lookupEan(null);
    expect(result1.found).toBe(false);
    const result2 = await lookupEan(undefined);
    expect(result2.found).toBe(false);
    const result3 = await lookupEan('');
    expect(result3.found).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips non-digit characters from EAN input', async () => {
    fetchMock.mockImplementationOnce(() =>
      makeFetchResponse({ name: 'Found Product', brand: 'X' })
    );

    await lookupEan('4548-7361-3261-0');
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('4548736132610');
  });

  it('uses vendor as brand fallback in Open EAN DB', async () => {
    fetchMock.mockImplementationOnce(() =>
      makeFetchResponse({ name: 'Product', vendor: 'VendorBrand' })
    );

    const result = await lookupEan('4548736132610');
    expect(result.brand).toBe('VendorBrand');
  });

  it('uses subcat when maincat is missing', async () => {
    fetchMock.mockImplementationOnce(() =>
      makeFetchResponse({ name: 'Product', subcat: 'Kopfhoerer' })
    );

    const result = await lookupEan('4548736132610');
    expect(result.category).toBe('Kopfhoerer');
  });
});
