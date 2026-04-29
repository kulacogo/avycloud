'use strict';

// Ensure we never hit Secret Manager during tests.
process.env.SERPAPI_KEY = 'test-fake-key';
// Disable rate-limit by default so unit tests don't depend on wall-clock.
process.env.SERPAPI_DISABLE_RATE_LIMIT = 'true';
// Tight breaker for testing.
process.env.SERPAPI_BREAKER_THRESHOLD = '3';
process.env.SERPAPI_BREAKER_OPEN_MS = '1000';
// Aggressive log throttling so tests don't flood stdout.
process.env.SERPAPI_LOG_THROTTLE_MS = '0';

const path = require('path');

function freshRequire() {
  const resolved = require.resolve('../../lib/serpapi');
  delete require.cache[resolved];
  return require('../../lib/serpapi');
}

let serpapi;
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  serpapi = freshRequire();
  serpapi._internal.resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

describe('serpapi.isEmptyResultPayload', () => {
  it('detects "Google hasn\'t returned any results"', () => {
    expect(
      serpapi.isEmptyResultPayload({
        error: "Google hasn't returned any results for this query.",
      })
    ).toBe(true);
  });

  it('detects "couldn\'t find any matching results"', () => {
    expect(
      serpapi.isEmptyResultPayload({
        error: "We couldn't find any matching results for your search.",
      })
    ).toBe(true);
  });

  it('detects search_information.local_results_state = Fully empty', () => {
    expect(
      serpapi.isEmptyResultPayload({
        search_information: { local_results_state: 'Fully empty' },
      })
    ).toBe(true);
  });

  it('does NOT classify "couldn\'t get valid results" as empty (real error)', () => {
    expect(
      serpapi.isEmptyResultPayload({
        error: "We couldn't get valid results for this search. Please try again later.",
      })
    ).toBe(false);
  });

  it('returns false for normal data', () => {
    expect(serpapi.isEmptyResultPayload({ shopping_results: [{ title: 'x' }] })).toBe(false);
    expect(serpapi.isEmptyResultPayload(null)).toBe(false);
  });
});

describe('serpapi.callSerpApi — empty results', () => {
  it('returns { _empty: true } instead of throwing on "no results"', async () => {
    fetchMock.mockReturnValueOnce(
      jsonResponse({ error: "Google hasn't returned any results for this query." })
    );
    const data = await serpapi.callSerpApi('google_shopping', { q: 'doesnotexist' });
    expect(data._empty).toBe(true);
    expect(data.error).toMatch(/hasn'?t returned/i);
  });

  it('caches empty result so a repeat call does not re-hit the network', async () => {
    fetchMock.mockReturnValueOnce(
      jsonResponse({ error: "Google hasn't returned any results for this query." })
    );
    await serpapi.callSerpApi('google_shopping', { q: 'cachetest' });
    await serpapi.callSerpApi('google_shopping', { q: 'cachetest' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not trip circuit breaker on empty results', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ error: "Google hasn't returned any results for this query." })
    );
    // Below threshold of 3 even if every call were treated as error
    await serpapi.callSerpApi('google_shopping', { q: 'a' });
    await serpapi.callSerpApi('google_shopping', { q: 'b' });
    await serpapi.callSerpApi('google_shopping', { q: 'c' });
    await serpapi.callSerpApi('google_shopping', { q: 'd' });
    const stats = serpapi._internal.getStats();
    expect(stats.breaker.state).toBe('closed');
    expect(stats.breaker.consecutiveErrors).toBe(0);
  });
});

describe('serpapi.callSerpApi — positive cache', () => {
  it('caches successful responses by stable key', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ shopping_results: [{ title: 'A' }] }));
    const a = await serpapi.callSerpApi('google_shopping', { q: 'iphone', num: 10 });
    const b = await serpapi.callSerpApi('google_shopping', { num: 10, q: 'iphone' });
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache key is engine-aware', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ shopping_results: [{ title: 'shop' }] }));
    fetchMock.mockReturnValueOnce(jsonResponse({ organic_results: [{ title: 'web' }] }));
    await serpapi.callSerpApi('google_shopping', { q: 'iphone' });
    await serpapi.callSerpApi('google', { q: 'iphone' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('serpapi.callSerpApi — real errors', () => {
  it('throws on real API error (not the empty pattern)', async () => {
    fetchMock.mockReturnValueOnce(
      jsonResponse({ error: "We couldn't get valid results for this search. Please try again later." })
    );
    await expect(
      serpapi.callSerpApi('google_shopping', { q: 'broken' })
    ).rejects.toThrow(/SerpAPI error/);
  });

  it('throws on HTTP non-2xx', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ message: 'forbidden' }, 403));
    await expect(
      serpapi.callSerpApi('google_shopping', { q: 'forbidden' })
    ).rejects.toThrow(/SerpAPI request failed \(403\)/);
  });

  it('opens circuit breaker after consecutive real errors', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ message: 'fail' }, 500));
    // threshold=3 set via env
    for (let i = 0; i < 3; i += 1) {
      await expect(
        serpapi.callSerpApi('google_shopping', { q: `err${i}` })
      ).rejects.toThrow();
    }
    const stats = serpapi._internal.getStats();
    expect(stats.breaker.state).toBe('open');

    // Subsequent call should fail fast with SERPAPI_CIRCUIT_OPEN — no extra fetch
    const fetchCallsBefore = fetchMock.mock.calls.length;
    await expect(
      serpapi.callSerpApi('google_shopping', { q: 'nextone' })
    ).rejects.toThrow(/circuit breaker/);
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallsBefore);
  });

  it('rejects unsupported engine', async () => {
    await expect(
      serpapi.callSerpApi('not-a-real-engine', { q: 'x' })
    ).rejects.toThrow(/Unsupported SerpAPI engine/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('serpapi.fetchSerpApi (object-style alias)', () => {
  it('delegates to callSerpApi with same observable behavior', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ organic_results: [{ title: 'X' }] }));
    const data = await serpapi.fetchSerpApi({
      engine: 'ebay',
      ebay_domain: 'ebay.de',
      _nkw: '1234567890123',
    });
    expect(Array.isArray(data.organic_results)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toMatch(/engine=ebay/);
    expect(calledUrl).toMatch(/_nkw=1234567890123/);
  });

  it('throws when called without options object', async () => {
    await expect(serpapi.fetchSerpApi(null)).rejects.toThrow();
  });

  it('throws when engine is missing', async () => {
    await expect(serpapi.fetchSerpApi({ q: 'no-engine' })).rejects.toThrow(/Unsupported SerpAPI engine/);
  });
});

describe('serpapi cache-key stability', () => {
  it('produces identical keys regardless of param order', () => {
    const a = serpapi._internal.cacheKey('google', { q: 'foo', num: 10, hl: 'de' });
    const b = serpapi._internal.cacheKey('google', { hl: 'de', num: 10, q: 'foo' });
    expect(a).toBe(b);
  });

  it('omits api_key from key', () => {
    const a = serpapi._internal.cacheKey('google', { q: 'x', api_key: 'AAA' });
    const b = serpapi._internal.cacheKey('google', { q: 'x', api_key: 'BBB' });
    expect(a).toBe(b);
  });
});
