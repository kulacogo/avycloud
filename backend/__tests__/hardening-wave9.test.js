/**
 * Hardening Wave 9 — Operator-Visibility-Layer (backend endpoints)
 *
 * Source-contract tests: the two new endpoints exist in admin.js, use the
 * right collection names, are tenant-scoped + permission-gated.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HARDEN Wave 9: admin endpoints for system health', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'routes', 'admin.js'),
    'utf8'
  );

  it('defines GET /alerts/recent with permission gate + tenant scope', () => {
    expect(source).toMatch(/router\.get\(\s*['"]\/alerts\/recent['"][\s\S]{0,200}requirePermission\(['"]admin['"],\s*['"]read['"]\)/);
    const fnIdx = source.indexOf("'/alerts/recent'");
    const body = source.slice(fnIdx, fnIdx + 2500);
    expect(body).toMatch(/stock_failure_alerts/);
    expect(body).toMatch(/req\.user\?\.tenantId/);
    // Hard-cap on days (1..90)
    expect(body).toMatch(/Math\.min\(90,/);
    // Graceful fallback when composite index is missing
    expect(body).toMatch(/FAILED_PRECONDITION|requires an index/i);
  });

  it('defines GET /system-health that aggregates drain + llm + externalApis + meta', () => {
    expect(source).toMatch(/router\.get\(\s*['"]\/system-health['"][\s\S]{0,200}requirePermission\(['"]admin['"],\s*['"]read['"]\)/);
    const fnIdx = source.indexOf("'/system-health'");
    const body = source.slice(fnIdx, fnIdx + 6500);
    // Wires all three data sources
    expect(body).toMatch(/stock_failure_alerts/);
    expect(body).toMatch(/listLlmParity/);
    expect(body).toMatch(/getExternalApiStats/);
    // Tenant-scoped
    expect(body).toMatch(/req\.user\?\.tenantId/);
    // Never-fail composition (each section in its own try/catch)
    const catches = body.match(/catch \(err\)/g) || [];
    expect(catches.length).toBeGreaterThanOrEqual(3);
    // Headline LLM rollup fields
    expect(body).toMatch(/totalCostUsd_24h/);
    expect(body).toMatch(/schemaValidRate/);
    expect(body).toMatch(/byPipeline/);
    // Config snapshot reports Slack-Wiring
    expect(body).toMatch(/slackAlertsConfigured/);
  });
});
