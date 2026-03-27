# Consolidate SERP to serpapi.com Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BrightData SERP zone (`serp_avy`) with serpapi.com `google` engine in `searchWeb()`, then delete the now-unused `brightdata-serp.js` module.

**Architecture:** `web-search-html.js` currently calls `fetchSerpHtml()` (BrightData SERP) to get raw Google HTML, then regex-parses links. We replace this with `callSerpApi('google', ...)` which returns structured JSON with titles + URLs directly. BrightData Web Unlocker (`web-unlocker.js`) stays untouched — it's still needed for `fetchPageText()`.

**Tech Stack:** Node.js, CommonJS, serpapi.com REST API, Vitest

---

### Task 1: Replace `searchGoogleViaBrightDataSerp` with serpapi.com in `web-search-html.js`

**Files:**
- Modify: `backend/lib/web-search-html.js`

This is the core change. The function `searchGoogleViaBrightDataSerp()` (lines 230-288) fetches raw HTML from BrightData SERP zone and regex-parses it. We replace it with a function that calls `callSerpApi('google', ...)` and maps the structured JSON response.

- [ ] **Step 1: Add serpapi import to web-search-html.js**

At the top of `backend/lib/web-search-html.js`, add the serpapi import and remove the brightdata-serp import:

```js
// REMOVE this line:
const { fetchSerpHtml } = require('./brightdata-serp');

// ADD this line:
const { callSerpApi, summarizeSerpEntries } = require('./serpapi');
```

- [ ] **Step 2: Replace `searchGoogleViaBrightDataSerp` with `searchGoogleViaSerpApi`**

Replace the entire function `searchGoogleViaBrightDataSerp` (lines 230-288) with:

```js
async function searchGoogleViaSerpApi(query, { limit = 6, locale = 'de-DE' } = {}) {
  const trimmedQuery = safeString(query).slice(0, 140);
  if (!trimmedQuery) {
    return { query: '', ok: false, url: '', via: 'serpapi', status: 0, results: [] };
  }
  const hl = locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  try {
    const data = await callSerpApi('google', {
      q: trimmedQuery,
      gl: 'de',
      hl,
      google_domain: 'google.de',
      num: Math.min(limit + 4, 20),
    });
    const entries = (data?.organic_results || []).slice(0, limit);
    const results = [];
    for (const entry of entries) {
      const outUrl = entry?.link || entry?.url;
      if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
      if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
      try {
        const host = new URL(outUrl).host.toLowerCase();
        if (DOMAIN_BLOCKLIST.has(host)) continue;
      } catch {
        continue;
      }
      results.push({
        title: entry.title || '',
        url: outUrl,
        snippet: entry.snippet || '',
      });
    }
    return { query: trimmedQuery, ok: results.length > 0, url: '', via: 'serpapi', status: 200, results };
  } catch (e) {
    return { query: trimmedQuery, ok: false, url: '', via: 'serpapi', status: 0, results: [], error: e.message };
  }
}
```

Key differences from the old function:
- Returns structured data (title + snippet) instead of URL-only results from HTML parsing
- No more regex HTML parsing — uses serpapi.com JSON `organic_results`
- Requests `num: limit + 4` to account for filtered results (blocklist, pdfs)
- `via` field changes from `'brightdata_serp'` to `'serpapi'`

- [ ] **Step 3: Update `searchWeb()` to call the new function**

In `searchWeb()` (line 290-306), replace the call:

```js
// REPLACE this:
const serp = await searchGoogleViaBrightDataSerp(query, { limit, locale });

// WITH this:
const serp = await searchGoogleViaSerpApi(query, { limit, locale });
```

Also update the fallback chain comment:

```js
async function searchWeb(query, { limit = 6, locale = 'de-DE' } = {}) {
  // Prefer Google via SerpAPI (structured JSON, most reliable),
  // otherwise Google via unlocker. In BrightData-only mode we do NOT fallback to DDG/direct scraping.
  const serp = await searchGoogleViaSerpApi(query, { limit, locale });
```

- [ ] **Step 4: Remove `BRIGHTDATA_ONLY` constant and simplify fallback**

The `BRIGHTDATA_ONLY` flag (line 12-13) controlled whether to fall back to DDG when BrightData SERP failed. With serpapi.com as primary, the flag no longer makes sense for search. However, it's also used in `fetchText()` (line 84, 106) to control page fetching. So we keep `BRIGHTDATA_ONLY` as-is for `fetchText()` but simplify the `searchWeb` fallback:

```js
async function searchWeb(query, { limit = 6, locale = 'de-DE' } = {}) {
  // Prefer Google via SerpAPI (structured JSON, most reliable),
  // then Google via BrightData web unlocker, then DuckDuckGo as last resort.
  const serp = await searchGoogleViaSerpApi(query, { limit, locale });
  if (serp.ok && Array.isArray(serp.results) && serp.results.length) {
    return { engine: 'google', ...serp };
  }
  const google = await searchGoogle(query, { limit, locale });
  if (google.ok && Array.isArray(google.results) && google.results.length) {
    return { engine: 'google', ...google };
  }
  if (BRIGHTDATA_ONLY) {
    return { engine: 'google', query, ok: false, url: '', via: 'brightdata_only_no_results', status: 0, results: [] };
  }
  const ddg = await searchDuckDuckGo(query, { limit });
  return { engine: 'duckduckgo', ...ddg };
}
```

Note: The fallback chain stays the same (serpapi → unlocker google → DDG), only the primary source changes.

- [ ] **Step 5: Run existing tests**

Run: `cd /Users/oguz/Dev/avycloud/backend && npm test`
Expected: All 119 tests pass (no tests directly cover web-search-html.js, but ensure no breakage via transitive requires)

- [ ] **Step 6: Commit**

```bash
git add backend/lib/web-search-html.js
git commit -m "refactor: replace BrightData SERP with serpapi.com in searchWeb()"
```

---

### Task 2: Write integration test for `searchGoogleViaSerpApi`

**Files:**
- Create: `backend/__tests__/lib/web-search-html.test.js`

We need at least one test to verify the new serpapi-backed search path works correctly with mocked serpapi responses.

- [ ] **Step 1: Write the test file**

```js
require('../api/_patchGcp');

const { vi, describe, it, expect, beforeEach, afterEach } = require('vitest');

// Patch serpapi before loading web-search-html
const serpapi = require('../../lib/serpapi');
vi.spyOn(serpapi, 'callSerpApi');
vi.spyOn(serpapi, 'summarizeSerpEntries');

// Patch web-unlocker to avoid real HTTP
const webUnlocker = require('../../lib/web-unlocker');
vi.spyOn(webUnlocker, 'fetchWithUnlocker').mockResolvedValue({
  success: false, status: 0, body: '', zone: 'unlocker_avy',
});

const { searchWeb } = require('../../lib/web-search-html');

describe('web-search-html searchWeb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('falls back to google unlocker when serpapi fails', async () => {
    serpapi.callSerpApi.mockRejectedValueOnce(new Error('SERPAPI_KEY not configured'));

    const result = await searchWeb('fallback query');

    // With unlocker also mocked to fail, should ultimately fail
    expect(result.ok).toBe(false);
    expect(serpapi.callSerpApi).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the new test**

Run: `cd /Users/oguz/Dev/avycloud/backend && npx vitest run __tests__/lib/web-search-html.test.js`
Expected: 3 tests pass

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/oguz/Dev/avycloud/backend && npm test`
Expected: All tests pass (119 + 3 new)

- [ ] **Step 4: Commit**

```bash
git add backend/__tests__/lib/web-search-html.test.js
git commit -m "test: add searchWeb tests for serpapi.com integration"
```

---

### Task 3: Delete `brightdata-serp.js` and clean up env references

**Files:**
- Delete: `backend/lib/brightdata-serp.js`
- Modify: `backend/lib/web-search-html.js` (already done — import removed in Task 1)

- [ ] **Step 1: Verify no remaining imports of brightdata-serp**

Run: `grep -r "brightdata-serp\|fetchSerpHtml" backend/lib/ backend/services/ backend/routes/ backend/scripts/`
Expected: No matches (only in the deleted file itself and the already-removed import)

- [ ] **Step 2: Delete `backend/lib/brightdata-serp.js`**

```bash
rm backend/lib/brightdata-serp.js
```

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/oguz/Dev/avycloud/backend && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git rm backend/lib/brightdata-serp.js
git commit -m "chore: remove brightdata-serp.js (replaced by serpapi.com)"
```

---

### Task 4: Clean up env vars and documentation

**Files:**
- Modify: Any `.env.example`, `cloudbuild.yaml`, or docs that reference `BRIGHTDATA_SERP_ZONE`

- [ ] **Step 1: Search for BRIGHTDATA_SERP_ZONE references outside deleted file**

Run: `grep -r "BRIGHTDATA_SERP_ZONE" backend/ --include="*.{js,yaml,yml,json,md,env*}" | grep -v node_modules`
Expected: Only `web-search-html.js:232` (the old `searchGoogleViaBrightDataSerp` — should be gone after Task 1). If any remain in env files or docs, remove them.

- [ ] **Step 2: Search for `serp_avy` references**

Run: `grep -r "serp_avy" backend/ --include="*.{js,yaml,yml,json,md,env*}" | grep -v node_modules`
Expected: No matches

- [ ] **Step 3: Run full test suite one final time**

Run: `cd /Users/oguz/Dev/avycloud/backend && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove BRIGHTDATA_SERP_ZONE env var references"
```

---

## Summary of changes

| What | Action |
|---|---|
| `backend/lib/brightdata-serp.js` | DELETE |
| `backend/lib/web-search-html.js` | Replace `searchGoogleViaBrightDataSerp` → `searchGoogleViaSerpApi` using `callSerpApi('google')` |
| `backend/__tests__/lib/web-search-html.test.js` | CREATE — 3 tests |
| BrightData Web Unlocker (`web-unlocker.js`) | UNCHANGED |
| `lib/serpapi.js` | UNCHANGED |
| All other consumers (`evidence-provider.js`, `quality-gate.js`, etc.) | UNCHANGED — they call `searchWeb()` which keeps the same interface |
| Env: `BRIGHTDATA_SERP_ZONE` | Can be removed from Cloud Run / Secret Manager |
| Env: `SERPAPI_KEY` / `SERPAPI_ENABLED` | Already required, no change |
