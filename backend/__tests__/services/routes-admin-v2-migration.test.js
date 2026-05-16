'use strict';

/**
 * D.0c V2-Migration snapshot test for getAllProductsV2 call-sites.
 *
 * Asserts that every legacy `getAllProductsV2()` invocation in our hot routes
 * + services uses the additive D.0c ternary fallback:
 *
 *   const products = tenantId
 *     ? await getAllProductsV2ForTenant(tenantId)
 *     : await getAllProductsV2();
 *
 * The actual V2 call-sites live in:
 *   - backend/routes/marketplace.js (GET /kaufland/listings — 1 occurrence)
 *   - backend/services/kaufland-listings-sync.js (kaufland-sync ops backfill +
 *     drift detection — 2 occurrences. Extracted from routes/marketplace.js
 *     in Plan-D.0d so the safety-net cron in backend/index.js can share the
 *     same code path.)
 *   - backend/services/import-export.js (exportProductsCsv)
 *
 * routes/admin.js currently has NO `getAllProductsV2(` invocations; the file
 * is asserted clean of V2-callers as a regression guard (so future code
 * additions don't bypass the tenant-scoped helper).
 *
 * Lexical-only test (grep-based), per CLAUDE.md test-snapshot convention.
 */

const fs = require('fs');
const path = require('path');

function loadSource(rel) {
  const abs = path.resolve(__dirname, '..', '..', rel);
  return { abs, src: fs.readFileSync(abs, 'utf8') };
}

// Helper: locate every `getAllProductsV2(` invocation that is NOT a destructured
// import (`const { getAllProductsV2 } = require(...)`). Returns line numbers
// (1-based) of actual call-sites.
function findV2CallSiteLines(src) {
  const lines = src.split('\n');
  const callerLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bgetAllProductsV2\s*\(/.test(line)) continue;
    // Skip lines that ONLY mention getAllProductsV2ForTenant.
    if (/\bgetAllProductsV2ForTenant\s*\(/.test(line)
      && !/(?<!ForTenant)\bgetAllProductsV2\s*\(/.test(line)) continue;
    // Skip destructured-import lines: `const { getAllProductsV2, ... } = require(...)`.
    if (/\{\s*[^}]*\bgetAllProductsV2\b[^}]*\}\s*=\s*require\b/.test(line)) continue;
    callerLines.push(i + 1);
  }
  return callerLines;
}

// Helper: given a call-site line, look backwards within a small window for
// the ternary fallback signature.
function hasTernaryFallbackNear(src, lineNumber, windowLines = 4) {
  const lines = src.split('\n');
  const start = Math.max(0, lineNumber - 1 - windowLines);
  const end = Math.min(lines.length, lineNumber - 1 + 1);
  const slice = lines.slice(start, end).join('\n');
  return /\?\s*await\s+getAllProductsV2ForTenant\s*\(/.test(slice)
    && /:\s*await\s+getAllProductsV2\s*\(\s*\)/.test(slice);
}

describe('D.0c — getAllProductsV2 callers wear the ternary fallback', () => {
  it('routes/marketplace.js + services/kaufland-listings-sync.js: every V2 call-site uses the tenant ternary', () => {
    // Plan-D.0d: the two heavy Kaufland sync call-sites moved from the route
    // file into `services/kaufland-listings-sync.js`. routes/marketplace.js
    // still hosts the legacy `GET /kaufland/listings` call-site. We assert
    // a combined floor of 3 ternary-fallbacks (route + service) and verify
    // each is correctly wrapped.
    const route = loadSource('routes/marketplace.js');
    const service = loadSource('services/kaufland-listings-sync.js');

    const routeCallers = findV2CallSiteLines(route.src);
    const serviceCallers = findV2CallSiteLines(service.src);
    const total = routeCallers.length + serviceCallers.length;

    expect(total).toBeGreaterThanOrEqual(3);

    for (const ln of routeCallers) {
      expect(hasTernaryFallbackNear(route.src, ln)).toBe(true);
    }
    for (const ln of serviceCallers) {
      expect(hasTernaryFallbackNear(service.src, ln)).toBe(true);
    }
  });

  it('services/import-export.js: exportProductsCsv uses the tenant ternary', () => {
    const { src } = loadSource('services/import-export.js');
    const callerLines = findV2CallSiteLines(src);

    expect(callerLines.length).toBeGreaterThanOrEqual(1);
    for (const ln of callerLines) {
      expect(hasTernaryFallbackNear(src, ln)).toBe(true);
    }
  });

  it('routes/admin.js: stays clean of bare getAllProductsV2() invocations', () => {
    // Regression guard: routes/admin.js must NOT introduce un-fallbacked V2
    // callers. The file may import the helper for future use, but actual
    // invocations are forbidden unless wrapped in the ternary.
    const { src } = loadSource('routes/admin.js');
    const callerLines = findV2CallSiteLines(src);

    for (const ln of callerLines) {
      expect(hasTernaryFallbackNear(src, ln)).toBe(true);
    }
  });

  it('lib/product-store.js exports both getAllProductsV2 and getAllProductsV2ForTenant', () => {
    const { src } = loadSource('lib/product-store.js');
    expect(src).toMatch(/module\.exports\s*=\s*\{[\s\S]*getAllProductsV2[\s\S]*\}/);
    expect(src).toMatch(/module\.exports\s*=\s*\{[\s\S]*getAllProductsV2ForTenant[\s\S]*\}/);
  });
});
