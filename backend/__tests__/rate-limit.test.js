// Regression test for Incident 2026-05-25: express-rate-limit v8 rejected the
// raw-`req.ip` keyGenerator (ERR_ERL_KEY_GEN_IPV6), collapsing all clients into
// one bucket and 429'ing the whole app. See lib/rate-limit.js.

describe('lib/rate-limit', () => {
  it('constructs both limiters without throwing under express-rate-limit v8', () => {
    expect(() => require('../lib/rate-limit')).not.toThrow();
    const { identifyLimiter, generalLimiter } = require('../lib/rate-limit');
    expect(typeof identifyLimiter).toBe('function');
    expect(typeof generalLimiter).toBe('function');
  });

  describe('rateLimitKey', () => {
    const { rateLimitKey } = require('../lib/rate-limit');

    it('keys by authenticated user id when present', () => {
      expect(rateLimitKey({ user: { uid: 'user-123' }, ip: '93.231.143.177' })).toBe('user-123');
    });

    it('returns IPv4 unchanged for unauthenticated requests', () => {
      expect(rateLimitKey({ ip: '93.231.143.177' })).toBe('93.231.143.177');
    });

    it('masks IPv6 to a /56 subnet so clients cannot rotate within their block', () => {
      const key = rateLimitKey({ ip: '2003:ce:d74d:1234:abcd::1' });
      expect(key).toBe('2003:ce:d74d:1200::/56');
      // two addresses in the same /56 collapse to one key
      expect(rateLimitKey({ ip: '2003:ce:d74d:12ff:ffff::9' })).toBe(key);
    });
  });

  describe('skipPreflight', () => {
    const { skipPreflight } = require('../lib/rate-limit');

    it('skips CORS preflight so a rate-limited OPTIONS never kills the real request', () => {
      expect(skipPreflight({ method: 'OPTIONS' })).toBe(true);
    });

    it('does not skip normal requests', () => {
      expect(skipPreflight({ method: 'GET' })).toBe(false);
      expect(skipPreflight({ method: 'POST' })).toBe(false);
    });
  });
});
