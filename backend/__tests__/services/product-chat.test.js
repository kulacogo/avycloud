'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// Unit tests for the legacy product-chat.js hardening:
//   - extractAsin() — ASIN (B0 + 8 alphanum) detection
//   - chatLegacyEnhanced() — CHAT_LEGACY_ENHANCED feature flag
//   - scoreEvidenceUrl() — Amazon/eBay/brand context boosts
//   - pickBestUrl() — propagation of context into scoring
//   - MAX_CHAT_ITERATIONS and resolved model names
//
// We load the module under test fresh (clearing require.cache) so env-var
// changes take effect on a re-require. No live Gemini calls are made.

const path = require('path');

const modPath = path.resolve(__dirname, '../../services/product-chat.js');

function freshRequire(env = {}) {
  const before = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[modPath];
  const mod = require(modPath);
  // restore env (tests mutate CHAT_LEGACY_ENHANCED in-place where needed)
  Object.keys(env).forEach((k) => {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  });
  return mod;
}

describe('product-chat legacy hardening', () => {
  describe('module exports', () => {
    it('exports runProductChat as an async function', () => {
      const mod = require(modPath);
      expect(mod).toHaveProperty('runProductChat');
      expect(typeof mod.runProductChat).toBe('function');
      expect(mod.runProductChat.constructor.name).toBe('AsyncFunction');
    });

    it('exposes _testables with legacy hardening helpers', () => {
      const { _testables } = require(modPath);
      expect(_testables).toBeDefined();
      expect(typeof _testables.extractAsin).toBe('function');
      expect(typeof _testables.chatLegacyEnhanced).toBe('function');
      expect(typeof _testables.scoreEvidenceUrl).toBe('function');
      expect(typeof _testables.pickBestUrl).toBe('function');
    });

    it('MAX_CHAT_ITERATIONS is hoisted to 10 (from legacy 5)', () => {
      const { _testables } = require(modPath);
      expect(_testables.MAX_CHAT_ITERATIONS).toBe(10);
    });

    it('CHAT_MODEL resolves to a valid 3.x model', () => {
      const { _testables } = require(modPath);
      expect(typeof _testables.CHAT_MODEL).toBe('string');
      expect(_testables.CHAT_MODEL).toMatch(/^gemini-3/);
    });

    it('INTENT_MODEL resolves to a flash model', () => {
      const { _testables } = require(modPath);
      expect(typeof _testables.INTENT_MODEL).toBe('string');
      expect(_testables.INTENT_MODEL).toMatch(/flash/);
    });
  });

  describe('extractAsin()', () => {
    it('returns the ASIN when present (uppercase B0 + 8 alphanum)', () => {
      const { _testables } = require(modPath);
      expect(_testables.extractAsin('Check this product B01N5IB20Q now')).toBe('B01N5IB20Q');
      expect(_testables.extractAsin('ASIN: B08N5WRWNW ist ein Echo Dot')).toBe('B08N5WRWNW');
    });

    it('returns null when no ASIN is present', () => {
      const { _testables } = require(modPath);
      expect(_testables.extractAsin('nothing here, just text')).toBeNull();
      expect(_testables.extractAsin('')).toBeNull();
      expect(_testables.extractAsin(null)).toBeNull();
      expect(_testables.extractAsin(undefined)).toBeNull();
    });

    it('rejects malformed ASIN-like tokens', () => {
      const { _testables } = require(modPath);
      // Missing leading B
      expect(_testables.extractAsin('01N5IB20Q')).toBeNull();
      // Too short (9 chars total)
      expect(_testables.extractAsin('B01N5IB2')).toBeNull();
      // Lowercase — ASINs are uppercase
      expect(_testables.extractAsin('b01n5ib20q')).toBeNull();
    });
  });

  describe('chatLegacyEnhanced()', () => {
    let originalFlag;
    beforeEach(() => {
      originalFlag = process.env.CHAT_LEGACY_ENHANCED;
    });
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.CHAT_LEGACY_ENHANCED;
      else process.env.CHAT_LEGACY_ENHANCED = originalFlag;
    });

    it('defaults to true when unset', () => {
      delete process.env.CHAT_LEGACY_ENHANCED;
      const { _testables } = require(modPath);
      expect(_testables.chatLegacyEnhanced()).toBe(true);
    });

    it('returns false only for explicit "false"/"0"/"no"', () => {
      const { _testables } = require(modPath);
      process.env.CHAT_LEGACY_ENHANCED = 'false';
      expect(_testables.chatLegacyEnhanced()).toBe(false);
      process.env.CHAT_LEGACY_ENHANCED = '0';
      expect(_testables.chatLegacyEnhanced()).toBe(false);
      process.env.CHAT_LEGACY_ENHANCED = 'no';
      expect(_testables.chatLegacyEnhanced()).toBe(false);
    });

    it('returns true for any other value', () => {
      const { _testables } = require(modPath);
      process.env.CHAT_LEGACY_ENHANCED = 'true';
      expect(_testables.chatLegacyEnhanced()).toBe(true);
      process.env.CHAT_LEGACY_ENHANCED = '1';
      expect(_testables.chatLegacyEnhanced()).toBe(true);
      process.env.CHAT_LEGACY_ENHANCED = '';
      // empty string is not one of the falsy sentinels, so default (true) wins
      expect(_testables.chatLegacyEnhanced()).toBe(true);
    });
  });

  describe('scoreEvidenceUrl() context boosts', () => {
    it('boosts amazon URLs when asinContext is set', () => {
      const { _testables } = require(modPath);
      const withCtx = _testables.scoreEvidenceUrl({
        url: 'https://www.amazon.de/dp/B01N5IB20Q',
        title: 'Product',
        snippet: 'x',
        context: { asinContext: true, ebayContext: false, brand: '' },
      });
      const withoutCtx = _testables.scoreEvidenceUrl({
        url: 'https://www.amazon.de/dp/B01N5IB20Q',
        title: 'Product',
        snippet: 'x',
      });
      expect(withCtx).toBeGreaterThan(withoutCtx);
    });

    it('boosts ebay URLs when ebayContext is set', () => {
      const { _testables } = require(modPath);
      const withCtx = _testables.scoreEvidenceUrl({
        url: 'https://www.ebay.de/itm/1234567890',
        title: 'Auction',
        snippet: 'item',
        context: { asinContext: false, ebayContext: true, brand: '' },
      });
      const withoutCtx = _testables.scoreEvidenceUrl({
        url: 'https://www.ebay.de/itm/1234567890',
        title: 'Auction',
        snippet: 'item',
      });
      expect(withCtx).toBeGreaterThan(withoutCtx);
    });

    it('boosts manufacturer domain when brand matches', () => {
      const { _testables } = require(modPath);
      const withBrand = _testables.scoreEvidenceUrl({
        url: 'https://www.bosch.de/produkte/handwerkzeug',
        title: 'Bosch',
        snippet: 'manufacturer page',
        context: { asinContext: false, ebayContext: false, brand: 'Bosch' },
      });
      const noBrand = _testables.scoreEvidenceUrl({
        url: 'https://www.bosch.de/produkte/handwerkzeug',
        title: 'Bosch',
        snippet: 'manufacturer page',
      });
      expect(withBrand).toBeGreaterThan(noBrand);
    });

    it('does not apply boosts when CHAT_LEGACY_ENHANCED=false', () => {
      const original = process.env.CHAT_LEGACY_ENHANCED;
      try {
        process.env.CHAT_LEGACY_ENHANCED = 'false';
        const { _testables } = require(modPath);
        const withCtx = _testables.scoreEvidenceUrl({
          url: 'https://www.amazon.de/dp/B01N5IB20Q',
          title: 'Product',
          snippet: 'x',
          context: { asinContext: true, brand: 'Amazon' },
        });
        const withoutCtx = _testables.scoreEvidenceUrl({
          url: 'https://www.amazon.de/dp/B01N5IB20Q',
          title: 'Product',
          snippet: 'x',
        });
        expect(withCtx).toBe(withoutCtx);
      } finally {
        if (original === undefined) delete process.env.CHAT_LEGACY_ENHANCED;
        else process.env.CHAT_LEGACY_ENHANCED = original;
      }
    });
  });

  describe('pickBestUrl() with context', () => {
    it('prefers amazon URLs when asinContext is set (even with later index)', () => {
      const { _testables } = require(modPath);
      const results = [
        { url: 'https://some-random-site.example/item', title: 'random', snippet: 'x'.repeat(200) },
        { url: 'https://www.amazon.de/dp/B0ABCDE123', title: 'amazon', snippet: 'prod' },
      ];
      const best = _testables.pickBestUrl(results, { asinContext: true });
      expect(best).not.toBeNull();
      expect(best.url).toMatch(/amazon\.de/);
    });

    it('falls back to first valid URL when no context', () => {
      const { _testables } = require(modPath);
      const results = [
        { url: 'https://example.com/a', title: 'a', snippet: 's' },
        { url: 'https://example.com/b', title: 'b', snippet: 's' },
      ];
      const best = _testables.pickBestUrl(results);
      expect(best).not.toBeNull();
      expect(best.url).toBe('https://example.com/a');
    });

    it('returns null when no valid URLs', () => {
      const { _testables } = require(modPath);
      expect(_testables.pickBestUrl([])).toBeNull();
      expect(_testables.pickBestUrl([{ url: 'not-http' }])).toBeNull();
    });
  });
});
