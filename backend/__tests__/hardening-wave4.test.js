/**
 * Hardening Wave 4 — LLM-Observability activated
 *
 * Source-contract test: gemini3-client integrates logLlmCall around the two
 * hot generate-functions. Macht /api/admin/llm-parity endlich nutzbar.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HARDEN Wave 4: gemini3-client telemetry integration', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'lib', 'gemini3-client.js'),
    'utf8'
  );

  it('defines _trackLlmCallSafely fire-and-forget wrapper', () => {
    expect(source).toMatch(/function _trackLlmCallSafely/);
    // Must lazy-require to avoid breaking the LLM path if telemetry module fails.
    expect(source).toMatch(/require\(['"]\.\/llm-telemetry['"]\)/);
    // Must NEVER await/throw on telemetry.
    expect(source).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\/\*\s*swallow\s*\*\/\s*\}\)/);
  });

  it('gemini3GenerateJSON tracks latency + token usage + schemaValid', () => {
    const fnBody = source.match(/async function gemini3GenerateJSON[\s\S]+?\n\}\n/)?.[0] || '';
    expect(fnBody).toMatch(/_trackLlmCallSafely/);
    expect(fnBody).toMatch(/_startMs\s*=\s*Date\.now/);
    expect(fnBody).toMatch(/latencyMs:\s*Date\.now\(\)\s*-\s*_startMs/);
    expect(fnBody).toMatch(/promptTokens:\s*response\?\.usageMetadata\?\.promptTokenCount/);
    expect(fnBody).toMatch(/completionTokens:\s*response\?\.usageMetadata\?\.candidatesTokenCount/);
    expect(fnBody).toMatch(/schemaValid:\s*_telemetrySchemaValid/);
  });

  it('gemini3GenerateText tracks latency + token usage', () => {
    const fnBody = source.match(/async function gemini3GenerateText[\s\S]+?\n\}\n/)?.[0] || '';
    expect(fnBody).toMatch(/_trackLlmCallSafely/);
    expect(fnBody).toMatch(/latencyMs:\s*Date\.now\(\)\s*-\s*_startMs/);
    expect(fnBody).toMatch(/promptTokens:\s*response\?\.usageMetadata\?\.promptTokenCount/);
  });

  it('telemetry tracks both error and success paths', () => {
    const jsonBody = source.match(/async function gemini3GenerateJSON[\s\S]+?\n\}\n/)?.[0] || '';
    // Catch-error path
    expect(jsonBody).toMatch(/catch\s*\(err\)\s*\{[\s\S]+?_trackLlmCallSafely/);
    // Empty-response path
    expect(jsonBody).toMatch(/returned empty response/);
    // Success path tracks schemaValid: true
    expect(jsonBody).toMatch(/_telemetrySchemaValid\s*=\s*true/);
  });
});
