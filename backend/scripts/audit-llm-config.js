#!/usr/bin/env node
// CommonJS. 2 Spaces. Single Quotes.
//
// audit-llm-config.js — Phase F.0 LLM-Konsumenten-Inventur
//
// Scans backend/**/*.js for Gemini / LLM call sites and produces:
//   1. A Markdown table per caller (file:line | configKey | currentValue | source)
//   2. A drift score per caller file (0–3):
//        0 = uses central config helpers (gemini-config.js or llm-config.js scope)
//        1 = mixed (central + hardcoded)
//        2 = fully hardcoded LLM-config literals
//        3 = inconsistent / suspicious literals (e.g. low-temp chat, missing thinking)
//   3. A JSON dump at /tmp/llm-config-audit.json with the structured findings.
//
// READ-ONLY. Touches no caller code, performs no Firestore I/O.
// Standalone — only Node stdlib.
//
// Exit codes:
//   0 = scan succeeded (drift findings printed, but the script itself ran fine)
//   1 = scan failed (I/O error, parse error, etc.)

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const JSON_OUT = '/tmp/llm-config-audit.json';

// ---------------------------------------------------------------------------
// Caller registry — derived from the F.0 plan (≥27 callers). Each entry maps
// a logical caller name to one or more file paths (relative to backend/). The
// scanner inspects every file mentioned here AND every additional `*.js` file
// in backend/ that imports a Gemini SDK or references generationConfig — those
// extras are reported as "auto-discovered" callers.
// ---------------------------------------------------------------------------

const KNOWN_CALLERS = [
  { id: 1,  name: 'V3 Stage 3',              file: 'lib/identify-v3-stage3.js',              role: 'Content-Generation' },
  { id: 2,  name: 'V3 Stage 3 Agentic',      file: 'lib/identify-v3-stage3-agentic.js',      role: 'Multi-Turn-Tool-Calling' },
  { id: 3,  name: 'V4 Identity Worker',      file: 'lib/identify-workers/identity-worker.js',role: 'Identity (brand/model/MPN)' },
  { id: 4,  name: 'V4 Category Worker',      file: 'lib/identify-workers/category-worker.js',role: 'Category resolution' },
  { id: 5,  name: 'V4 Attributes Worker',    file: 'lib/identify-workers/attributes-worker.js',role: 'Required aspects' },
  { id: 6,  name: 'V4 SEO Worker',           file: 'lib/identify-workers/seo-worker.js',     role: 'Title/Description' },
  { id: 7,  name: 'V4 Pricing Worker',       file: 'lib/identify-workers/pricing-worker.js', role: 'Sweet-spot price' },
  { id: 8,  name: 'V4 Image Worker',         file: 'lib/identify-workers/image-worker.js',   role: 'Image enhance/classify' },
  { id: 9,  name: 'V4 GPSR Worker',          file: 'lib/identify-workers/gpsr-worker.js',    role: 'Manufacturer GPSR' },
  { id: 10, name: 'V4 Critic Worker',        file: 'lib/identify-workers/critic-worker.js',  role: 'Critic / quality scoring' },
  { id: 11, name: 'Chat V3',                 file: 'services/product-chat-v3.js',            role: 'Customtools pipeline' },
  { id: 12, name: 'Chat V2',                 file: 'services/product-chat-v2.js',            role: 'Grounding pipeline' },
  { id: 13, name: 'Chat Legacy',             file: 'services/product-chat.js',               role: 'BrightData/SerpAPI + Gemini' },
  { id: 14, name: 'Atomic Tools',            file: 'services/atomic-tools.js',               role: 'Tool executors (LLM-orchestrated)' },
  { id: 15, name: 'Category Resolver',       file: 'services/category-resolver.js',          role: 'Gemini fallback (Strategy 4)' },
  { id: 16, name: 'Weight Web-Lookup',       file: 'lib/weight-web-lookup.js',               role: 'Web snippet weight parsing' },
  { id: 17, name: 'GPSR Web Fallback',       file: 'lib/gpsr-web-fallback.js',               role: 'Impressum extraction' },
  { id: 18, name: 'Image Enhance',           file: 'lib/image-enhance.js',                   role: 'BG removal + upscale' },
  { id: 19, name: 'Image Grouping',          file: 'services/image-grouping.js',             role: 'Vision classification' },
  { id: 20, name: 'Image Grouping Fallback', file: 'lib/image-grouping-fallback.js',         role: 'Vision classification fallback' },
  { id: 21, name: 'Image Search',            file: 'lib/image-search.js',                    role: 'Web image relevance' },
  { id: 22, name: 'Marketing Images',        file: 'lib/marketing-images.js',                role: 'Image title scoring' },
  { id: 23, name: 'Quality Gate',            file: 'services/quality-gate.js',               role: 'Optional Gemini plausibility' },
  { id: 24, name: 'eBay Auto-Fix',           file: 'services/ebay-auto-fix.js',              role: 'Aspect generation on publish-error' },
  { id: 25, name: 'Enrichment Pipeline',     file: 'services/enrichment.js',                 role: 'Active enrichment' },
  { id: 26, name: 'Improve Pipeline',        file: 'services/improve.js',                    role: 'Product datasheet improvement' },
  { id: 27, name: 'Admin Bulk Actions',      file: 'services/admin-bulk-actions.js',         role: 'recategorize_v2 / bulk LLM ops' },
  { id: 28, name: 'Rulebook Runner',         file: 'services/rulebook-runner.js',            role: 'Cron LLM calls' },
  { id: 29, name: 'Generative Identify (legacy)', file: 'services/generative-identify.js',   role: 'Legacy fallback (deprecated)' },
  { id: 30, name: 'Enrichment-V2 (legacy)',  file: 'services/enrichment-v2.js',              role: 'Legacy enrichment (deprecated)' },
  { id: 31, name: 'Identify-V4 Orchestrator',file: 'services/identify-v4.js',                role: 'Wave/refinement orchestrator' },
  { id: 32, name: 'Listing Pipeline',        file: 'services/listing-pipeline.js',           role: 'Listing post-process LLM' },
  { id: 33, name: 'Product Validator',       file: 'services/product-validator.js',          role: 'Product validation LLM' },
  // Shared helpers (callers themselves rely on these — listed for transparency).
  { id: 34, name: 'gemini-structured (helper)', file: 'lib/gemini-structured.js',            role: 'Shared structured-output wrapper' },
  { id: 35, name: 'gemini-client (helper)',  file: 'lib/gemini-client.js',                   role: 'Shared Gemini client' },
  { id: 36, name: 'gemini.js (helper)',      file: 'lib/gemini.js',                          role: 'Legacy Gemini wrapper' },
  { id: 37, name: 'gemini3-client (helper)', file: 'lib/gemini3-client.js',                  role: 'Gemini 3 grounding client' },
];

// Regexes for config keys we care about. Order matters when multiple match the
// same line — first hit wins, the remaining are still recorded.
const CONFIG_PATTERNS = [
  { key: 'temperature',     re: /\btemperature\s*[:=]\s*([^,\}\n]+)/g },
  { key: 'topK',            re: /\btopK\s*[:=]\s*([^,\}\n]+)/g },
  { key: 'topP',            re: /\btopP\s*[:=]\s*([^,\}\n]+)/g },
  { key: 'maxOutputTokens', re: /\bmaxOutputTokens\s*[:=]\s*([^,\}\n]+)/g },
  { key: 'thinkingConfig',  re: /\bthinkingConfig\s*[:=]\s*([^\n]+)/g },
  { key: 'mediaResolution', re: /\bmediaResolution\s*[:=]\s*([^,\}\n]+)/g },
  { key: 'modelLiteral',    re: /\bmodel\s*[:=]\s*['"]([^'"]+)['"]/g },
  { key: 'generationConfig',re: /\bgenerationConfig\s*[:=]\s*\{/g },
];

const CENTRAL_HELPER_RE = /require\(['"][^'"]*\/?(gemini-config|llm-config|model-select)['"]\)/;
const HELPER_USE_RE = /\b(buildGenerationConfig|defaultThinkingConfig|defaultSafetySettings|resolveChatModel|resolveIdentifyModel|resolveIntentModel|resolveIdentifyV4Model|resolveImageEnhanceModel|getActiveLlmConfig|DEFAULT_CHAT_TEMPERATURE|DEFAULT_STRUCTURED_TEMPERATURE|FLASH_MODEL|DEFAULT_MODEL|IMAGE_MODEL|MEDIA_RESOLUTION)\b/;

const SDK_IMPORT_RE = /require\(['"]@google\/(genai|generative-ai)['"]\)/;

function readFileSafe(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return null;
  }
}

function classifyValueLiteral(rawValue) {
  // Returns 'literal' (numeric / string-literal / true/false), 'reference'
  // (identifier or function call), or 'helper' if the value clearly refers to
  // a central helper constant.
  const trimmed = String(rawValue || '').trim().replace(/[,\}]+$/, '').trim();
  if (!trimmed) return { kind: 'unknown', value: trimmed };
  if (HELPER_USE_RE.test(trimmed)) return { kind: 'helper', value: trimmed };
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return { kind: 'literal', value: trimmed };
  if (/^['"`].+['"`]$/.test(trimmed)) return { kind: 'literal', value: trimmed };
  if (/^(true|false|null|undefined)$/.test(trimmed)) return { kind: 'literal', value: trimmed };
  // Function call or identifier.
  return { kind: 'reference', value: trimmed };
}

function scanFile(absPath, relPath) {
  const content = readFileSafe(absPath);
  if (content === null) {
    return { file: relPath, missing: true, hits: [], usesCentralHelper: false, importsSdk: false };
  }
  const lines = content.split(/\r?\n/);
  const usesCentralHelper = CENTRAL_HELPER_RE.test(content);
  const importsSdk = SDK_IMPORT_RE.test(content);

  const hits = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    // Skip pure-comment lines (do not treat values inside JSDoc comments as live config).
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) continue;

    for (const pattern of CONFIG_PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(line)) !== null) {
        const value = m[1] !== undefined ? m[1] : '<inline>';
        const classification = classifyValueLiteral(value);
        hits.push({
          line: lineIdx + 1,
          configKey: pattern.key,
          rawValue: classification.value,
          valueKind: classification.kind, // literal | helper | reference | unknown
          context: line.trim().slice(0, 160),
        });
      }
    }
  }
  return { file: relPath, missing: false, hits, usesCentralHelper, importsSdk };
}

function computeDriftScore(scan) {
  if (scan.missing) return { score: null, reason: 'file_missing' };
  if (scan.hits.length === 0 && !scan.importsSdk && !scan.usesCentralHelper) {
    return { score: null, reason: 'no_llm_call_detected' };
  }
  const literalHits = scan.hits.filter((h) => h.valueKind === 'literal' && h.configKey !== 'modelLiteral');
  const helperHits = scan.hits.filter((h) => h.valueKind === 'helper');
  const modelLiterals = scan.hits.filter((h) => h.configKey === 'modelLiteral');

  // Score 0: file uses central helper AND no hardcoded numeric literals for
  // temperature/topK/topP/maxOutputTokens/mediaResolution/thinkingConfig.
  if (scan.usesCentralHelper && literalHits.length === 0) {
    return { score: 0, reason: 'central_helper_only' };
  }
  // Score 1: mixed — central helper present, but at least one numeric literal still present.
  if (scan.usesCentralHelper && literalHits.length > 0) {
    return { score: 1, reason: 'mixed_helper_and_literal' };
  }
  // Score 2: fully hardcoded — no helper require, but literals present.
  if (!scan.usesCentralHelper && literalHits.length > 0) {
    // Score 3 if values look inconsistent with documented defaults:
    //   - chat-style file (path contains 'chat') with temperature < 0.5
    //   - identify-style with temperature > 0.6 and no thinking
    const file = scan.file.toLowerCase();
    const tempHits = scan.hits.filter((h) => h.configKey === 'temperature' && h.valueKind === 'literal');
    const tempVals = tempHits.map((h) => Number(h.rawValue)).filter((v) => Number.isFinite(v));
    const hasThinking = scan.hits.some((h) => h.configKey === 'thinkingConfig');

    let inconsistent = false;
    if (file.includes('chat') && tempVals.some((v) => v < 0.5)) inconsistent = true;
    if (file.includes('identify') && !hasThinking && tempVals.some((v) => v > 0.6)) inconsistent = true;
    if (modelLiterals.length > 1) inconsistent = true; // multiple hardcoded model strings is a smell

    return { score: inconsistent ? 3 : 2, reason: inconsistent ? 'hardcoded_inconsistent' : 'hardcoded_only' };
  }
  // No literals, no helper require, but SDK imported — likely delegates to a sub-helper.
  return { score: 0, reason: 'no_literals_delegates_to_helper' };
}

function autoDiscover(extraDirs = ['lib', 'services', 'lib/identify-workers']) {
  const found = new Set();
  for (const dir of extraDirs) {
    const abs = path.join(BACKEND_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      if (entry.name.endsWith('.test.js')) continue;
      const rel = path.relative(BACKEND_ROOT, path.join(abs, entry.name));
      const content = readFileSafe(path.join(abs, entry.name));
      if (!content) continue;
      const hasGenConfig = /generationConfig|@google\/genai|@google\/generative-ai/.test(content);
      if (hasGenConfig) found.add(rel);
    }
  }
  return Array.from(found);
}

function buildMarkdownTable(rows) {
  const out = [];
  out.push('| # | Caller | File | Role | Drift | Reason | Hits |');
  out.push('|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const driftText = row.drift.score === null ? '–' : String(row.drift.score);
    const hitsCount = row.scan.hits.length;
    out.push(`| ${row.id} | ${row.name} | \`${row.file}\` | ${row.role} | ${driftText} | ${row.drift.reason} | ${hitsCount} |`);
  }
  return out.join('\n');
}

function buildHitsDetail(rows) {
  const out = [];
  for (const row of rows) {
    if (row.scan.missing || row.scan.hits.length === 0) continue;
    out.push('');
    out.push(`### ${row.id}. ${row.name}  (\`${row.file}\`)`);
    out.push('');
    out.push('| Line | configKey | currentValue | source |');
    out.push('|---|---|---|---|');
    for (const h of row.scan.hits) {
      const source =
        h.valueKind === 'helper' ? 'central helper'
        : h.valueKind === 'literal' ? 'hardcoded'
        : h.valueKind === 'reference' ? 'identifier/expr'
        : 'unknown';
      const safeVal = h.rawValue.replace(/\|/g, '\\|').slice(0, 80);
      out.push(`| ${h.line} | \`${h.configKey}\` | \`${safeVal}\` | ${source} |`);
    }
  }
  return out.join('\n');
}

function summarize(rows) {
  const buckets = { 0: 0, 1: 0, 2: 0, 3: 0, n_a: 0 };
  for (const row of rows) {
    if (row.drift.score === null) buckets.n_a++;
    else buckets[row.drift.score]++;
  }
  return buckets;
}

function topMigrationCandidates(rows, n = 10) {
  const scored = rows.filter((r) => r.drift.score !== null);
  scored.sort((a, b) => {
    if (b.drift.score !== a.drift.score) return b.drift.score - a.drift.score;
    return b.scan.hits.length - a.scan.hits.length;
  });
  return scored.slice(0, n);
}

function main() {
  try {
    const knownPaths = new Set(KNOWN_CALLERS.map((c) => c.file));
    const discovered = autoDiscover();
    const extra = discovered.filter((p) => !knownPaths.has(p));

    const rows = [];

    for (const caller of KNOWN_CALLERS) {
      const abs = path.join(BACKEND_ROOT, caller.file);
      const scan = scanFile(abs, caller.file);
      const drift = computeDriftScore(scan);
      rows.push({ ...caller, scan, drift });
    }

    let nextId = KNOWN_CALLERS.length + 1;
    for (const relPath of extra) {
      const abs = path.join(BACKEND_ROOT, relPath);
      const scan = scanFile(abs, relPath);
      const drift = computeDriftScore(scan);
      rows.push({
        id: nextId++,
        name: `(auto) ${path.basename(relPath, '.js')}`,
        file: relPath,
        role: 'auto-discovered LLM touchpoint',
        scan,
        drift,
      });
    }

    const summary = summarize(rows);
    const top10 = topMigrationCandidates(rows, 10);

    // Console / stdout output.
    process.stdout.write('\n# LLM-Konsumenten-Inventar (audit-llm-config.js)\n\n');
    process.stdout.write(`Backend root: ${BACKEND_ROOT}\n`);
    process.stdout.write(`Known callers: ${KNOWN_CALLERS.length}\n`);
    process.stdout.write(`Auto-discovered extras: ${extra.length}\n`);
    process.stdout.write(`Total rows: ${rows.length}\n\n`);

    process.stdout.write('## Drift summary\n\n');
    process.stdout.write(`- Score 0 (central helper only): ${summary[0]}\n`);
    process.stdout.write(`- Score 1 (mixed):               ${summary[1]}\n`);
    process.stdout.write(`- Score 2 (hardcoded):           ${summary[2]}\n`);
    process.stdout.write(`- Score 3 (inconsistent):        ${summary[3]}\n`);
    process.stdout.write(`- N/A (no LLM call detected):    ${summary.n_a}\n\n`);

    process.stdout.write('## Top-10 migration priorities (highest drift)\n\n');
    for (const row of top10) {
      process.stdout.write(` - [${row.drift.score}] ${row.name}  ${row.file}  (${row.scan.hits.length} hits, ${row.drift.reason})\n`);
    }
    process.stdout.write('\n');

    process.stdout.write('## Caller inventory\n\n');
    process.stdout.write(buildMarkdownTable(rows));
    process.stdout.write('\n\n');

    process.stdout.write('## Per-caller hit detail\n');
    process.stdout.write(buildHitsDetail(rows));
    process.stdout.write('\n');

    // JSON dump.
    const jsonPayload = {
      generatedAt: new Date().toISOString(),
      backendRoot: BACKEND_ROOT,
      knownCallerCount: KNOWN_CALLERS.length,
      autoDiscoveredCount: extra.length,
      summary,
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        file: r.file,
        role: r.role,
        drift: r.drift,
        usesCentralHelper: r.scan.usesCentralHelper,
        importsSdk: r.scan.importsSdk,
        missing: r.scan.missing,
        hitCount: r.scan.hits.length,
        hits: r.scan.hits,
      })),
      top10,
    };
    fs.writeFileSync(JSON_OUT, JSON.stringify(jsonPayload, null, 2));
    process.stdout.write(`\nJSON dump: ${JSON_OUT}\n`);

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[audit-llm-config] FATAL: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFile, computeDriftScore, KNOWN_CALLERS, autoDiscover };
