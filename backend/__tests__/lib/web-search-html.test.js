// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available globally

require('../api/_patchGcp');

// Patch serpapi before loading web-search-html
const serpapi = require('../../lib/serpapi');
vi.spyOn(serpapi, 'callSerpApi').mockResolvedValue({ organic_results: [] });

// Patch web-unlocker to avoid real HTTP
const webUnlocker = require('../../lib/web-unlocker');
vi.spyOn(webUnlocker, 'fetchWithUnlocker').mockResolvedValue({
  success: false, status: 0, body: '', zone: 'unlocker_avy',
});

const { searchWeb } = require('../../lib/web-search-html');

describe('web-search-html searchWeb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default unlocker mock after clearAllMocks
    webUnlocker.fetchWithUnlocker.mockResolvedValue({
      success: false, status: 0, body: '', zone: 'unlocker_avy',
    });
  });

  it('returns serpapi google results as primary source', async () => {
    serpapi.callSerpApi.mockResolvedValueOnce({
      organic_results: [
        { title: 'Test Product', link: 'https://example.com/product', snippet: 'A test product' },
        { title: 'Another', link: 'https://shop.de/item', snippet: 'Another item' },
      ],
    });

    const result = await searchWeb('test query');

    expect(result.ok).toBe(true);
    expect(result.engine).toBe('google');
    expect(result.via).toBe('serpapi');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      title: 'Test Product',
      url: 'https://example.com/product',
    });
    expect(serpapi.callSerpApi).toHaveBeenCalledWith('google', expect.objectContaining({
      q: 'test query',
      gl: 'de',
    }));
  });

  it('filters blocked domains from serpapi results', async () => {
    serpapi.callSerpApi.mockResolvedValueOnce({
      organic_results: [
        { title: 'Blocked', link: 'https://www.ean-suche.de/product', snippet: '' },
        { title: 'Valid', link: 'https://example.com/ok', snippet: 'ok' },
      ],
    });

    const result = await searchWeb('ean query');

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://example.com/ok');
  });

  it('falls back when serpapi fails', async () => {
    serpapi.callSerpApi.mockRejectedValueOnce(new Error('SERPAPI_KEY not configured'));

    const result = await searchWeb('fallback query');

    // With unlocker also mocked to fail, should ultimately fail
    expect(result.ok).toBe(false);
    expect(serpapi.callSerpApi).toHaveBeenCalledTimes(1);
    expect(webUnlocker.fetchWithUnlocker).toHaveBeenCalled();
  });

  it('falls back when serpapi returns empty results', async () => {
    serpapi.callSerpApi.mockResolvedValueOnce({ organic_results: [] });

    const result = await searchWeb('empty query');

    expect(result.ok).toBe(false);
    expect(serpapi.callSerpApi).toHaveBeenCalledTimes(1);
    expect(webUnlocker.fetchWithUnlocker).toHaveBeenCalled();
  });
});
