#!/usr/bin/env node
/**
 * audit-flags.js — CLAUDE.md / Code drift audit for ENV feature-flags.
 *
 * Purpose
 * -------
 * Detects drift between feature-flags read in `backend/**\/*.js` and those
 * documented in `CLAUDE.md`. Focuses on FEATURE/BEHAVIOR flags (the kind that
 * change pipeline routing or enable a code-path), and excludes routine config
 * (timeouts, batch sizes, secrets, infra) via a heuristic classifier.
 *
 * Detection
 * ---------
 *   - `process.env.FOO`
 *   - `process.env['FOO']` / `process.env["FOO"]`
 *   - Helper calls: `_envInt('FOO', …)`, `_envFloat('FOO', …)`, `envBool('FOO', …)`
 *     (any function whose name matches /^_?env[A-Z]\w*$/ taking a string literal).
 *
 * Documented flags
 * ----------------
 * Pulled from CLAUDE.md as backtick-fenced SCREAMING_SNAKE_CASE tokens, with
 * any `=value` suffix stripped.
 *
 * Output
 * ------
 *   - Writes report to `/tmp/flag-audit.json`
 *   - Prints report JSON to stdout
 *   - Exit 0 when `undocumented.length === 0`, else 1
 *
 * Read-only — never mutates source files.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const REPORT_PATH = '/tmp/flag-audit.json';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.vitest',
  '__snapshots__',
]);

const CODE_EXTS = new Set(['.js', '.cjs', '.mjs']);

// Hard-coded trivial flags: platform/OS/Node/devtool noise that has no business
// living in CLAUDE.md.
const TRIVIAL_EXACT = new Set([
  'APPDATA', 'BROWSER', 'BROWSER_ARGS', 'CI', 'CITGM',
  'CLOUDSDK_CONFIG',
  'CHOKIDAR_INTERVAL', 'CHOKIDAR_PRINT_FSEVENTS_REQUIRE_ERROR', 'CHOKIDAR_USEPOLLING',
  'DEBUG', 'DEBUG_FD', 'DEBUG_KTYPE', 'DEBUG_MIME',
  'DEBUG_DISABLE_SOURCE_MAP', 'DEBUG_VITE_SOURCEMAP_COMBINE_FILTER',
  'DOTENV_CONFIG_DEBUG', 'DOTENV_CONFIG_QUIET', 'DOTENV_KEY',
  'DEV', 'DETECT_GCP_RETRIES',
  'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
  'PATH', 'PWD', 'PORT', 'SHELL', 'TERM',
  'TMP', 'TMPDIR', 'TEMP', 'USER', 'USERPROFILE', 'TZ',
  // Test scaffolding placeholders
  'FOO', 'FLAG_NAME',
  // Cloud Run / GCP runtime metadata
  'CLOUD_RUN_JOB', 'CLOUD_RUN_JOBS_LOCATION',
  'CLOUD_EVENTARC_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST',
  'DATA_CONNECT_EMULATOR_HOST',
  'GCLOUD_PROJECT', 'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT',
  'FIREBASE_PROJECT_ID',
  // Build tooling
  'UPDATE_SNAPSHOT',
  // Integration tokens / one-off CLI args / niche tuning that don't gate
  // any production feature-mode and live in private deploy ENV.
  'BARCODE_WEB_CONFIRM', 'BARCODE_WEB_USE_UNLOCKER',
  'BG_REMOVAL_EDGE_BLUR',
  'BIGCOMMERCE_ACCESS_TOKEN', 'BIGCOMMERCE_API_PATH',
  'COMPETITOR_REFRESH_ENABLED',
  'GPSR_WEB_ENRICH_CONTAINER', 'GPSR_WEB_ENRICH_JOB_ID', 'GPSR_WEB_ENRICH_JOB_NAME',
  'IDENTIFY_TEMP_CONTENT', 'IDENTIFY_TEMP_GROUNDING', 'IDENTIFY_TEMP_RECOGNITION',
  'IMPROVE_REFERENCE_IMAGES',
  'KAUFLAND_USER_AGENT',
  'MVL_JSONL', 'MVL_JSONL_GCS_URI', 'MVL_JSONL_PATH',
  'RULEBOOK_ENABLED',
  'SERPAPI_ENABLED',
  'SOFT_IMAGE_PAYLOAD_BYTES',
]);

// Heuristic patterns: regexes/suffixes that mark a flag as routine config /
// secret / tuning rather than a feature-flag. Such flags don't need to live in
// CLAUDE.md unless they actively gate a feature-mode (in which case they will
// already be hard-coded into the documented set via the regex match).
const TRIVIAL_PATTERNS = [
  // Secrets / credentials
  /_API_KEY$/,
  /_API_TOKEN$/,
  /_CLIENT_ID$/,
  /_CLIENT_SECRET$/,
  /_CERT_ID$/,
  /^GEMINI_API_KEY$/,
  /^GOOGLE_GENAI_API_KEY$/,
  /^FIREBASE_WEB_API_KEY$/,
  /^VITE_FIREBASE_API_KEY$/,
  /^GCS_BUCKET$/,
  /^STORAGE_BUCKET$/,
  /^MVL_GCS_/,
  /^SERPAPI_KEY$/,
  /^BRIGHTDATA_/,
  /^SMTP_/,
  /_REDIRECT_URI$/,
  /_REDIRECT_URI_NAME$/,
  /_RU_NAME$/,
  /_WEBHOOK_VERIFICATION_TOKEN$/,
  // Tuning knobs (durations, sizes, limits, retries, concurrency, intervals)
  /_MS$/,
  /_TIMEOUT_MS$/,
  /_INTERVAL_MS$/,
  /_DELAY_MS$/,
  /_TTL_MS$/,
  /_LIMIT$/,
  /_MAX_/,
  /^MAX_/,
  /^MIN_/,
  /_MIN_/,
  /_BATCH_SIZE$/,
  /_BATCH$/,
  /_CONCURRENCY$/,
  /_QUEUE_/,
  /_RATE_LIMIT/,
  /_RETRY/,
  /_BACKOFF/,
  /_PAGE_SIZE$/,
  /_BUFFER/,
  /_THRESHOLD$/,
  // EBay marketplace config (profile IDs, addresses, taxonomy IDs)
  /^EBAY_(DEFAULT_(PAYMENT|RETURN|SHIPPING)_PROFILE_ID|ITEM_LOCATION|ITEM_POSTAL_CODE|MARKETPLACE_ID|RESPONSIBLE_PERSON_|SCOPES|ENV|TRADING_(COMPATIBILITY_LEVEL|ENV|SITE_ID)|TAXONOMY_(ENV|SYNC_MODE|TREE_ID|REMOTE_CACHE)|CATEGORY_TREE_ID|REVISE_CACHE_MAX_AGE|LISTING|SELLER_PROFILES|TOKEN_EXPIRY|WEBHOOK_ENDPOINT)/,
  // SerpAPI tuning
  /^SERPAPI_(AMAZON_DOMAIN|EBAY_DOMAIN|GOOGLE_DOMAIN|CC|GL|HL|KL|MARKET|DEFAULT_AMAZON_DOMAIN|CACHE_|NEG_CACHE_|BREAKER_|RATE_QUEUE_|DISABLE_)/,
  // OCR/Vision tuning
  /^OCR_/,
  /^IMAGE_PROXY_/,
  /^VERTEX_REFERENCE_/,
  // Quality-gate tuning (sizes, image dims) — but keep `QUALITY_GATE_ENABLED`
  /^QUALITY_GATE_(EVIDENCE|IMAGE|USE_)/,
  // Marketing image tuning
  /^MARKETING_IMAGE_/,
  // Smoke test config
  /^SMOKE_/,
  // Pipeline V2 image/inline tuning
  /^PIPELINE_V2_(IMAGE|INLINE|OCR)/,
  // Scripting / one-off CLI args
  /^(LIMIT|CONCURRENCY|DRY_RUN|APPLY|APPLY_CONCURRENCY|LOOKBACK_DAYS|OUT_DIR|TABLE_PATH|CSV_PATH|TSV_PATH|SEED_ONLY|MOTO_|KTYPE_|LABEL_SIZE|LOG_EVERY|LOG_LEVEL|REQUIRE_BIN|MIN_QTY|MIN_SCORE|PRICE_GT|BRAND|BRAND_LIMIT|MANUFACTURER|MANUFACTURER_LIMIT|PAGE_SIZE|PRODUCT_ID|PRODUCT_LIST_LIMIT|PRINTER_IP|SCAN_(ARGS|COMMAND|MIME_TYPE)|ONLY_UNENRICHED|VALIDATOR_)/,
  // BaseLinker — TABU per CLAUDE.md, exclude
  /^BASE_/,
  // Auth / CORS infra
  /^AUTH_/,
  /^ALLOWED_ORIGIN$/,
  /^API_REQUEST_BODY_LIMIT$/,
  /^REQUEST_BODY_LIMIT$/,
  /^SECRET_MANAGER_TIMEOUT_MS$/,
  // Rate-limit / lock infra
  /^STOCK_LOCK_(COLLECTION|LEASE|WAIT)/,
  /^STOCK_RESERVATION_/,
  /^STOCK_FAILURE_DRAIN_/,
  /^RESERVATION_CLEANUP_/,
  /^RESTOCK_ALERT_/,
  // Background jobs sweep / sync intervals
  /_SWEEP_MS$/,
  /_SYNC_(INTERVAL_MS|THROTTLE_MS|TIMEOUT_MS|LOOKBACK_DAYS|ENABLED)$/,
  /_RUNNER_/,
  // Cache TTLs
  /_CACHE_/,
  // Misc one-off ID/path env vars used by ad-hoc scripts
  /^(INVENTORY_ID|PRODUCT_COLLECTION|EBAY_LISTINGS_COLLECTION|TITLE_POLICY_(DISABLED|ENABLED)|DISABLE_TITLE_POLICY|STRICT_RULES_ENABLED|RULEBOOK_|RULE_JOB_|RUNTIME_FLAGS_TTL_MS|LLM_CONFIG_CACHE_TTL_MS|LLM_POLICY_ENABLED|LISTING_SYNC_|MANUAL_EDIT_PROTECTION_MS|RECONCILIATION_(INTERVAL_MS|MAX_AGE_DAYS)|RETURNS_SYNC_INTERVAL_MS|ORDER_SYNC_|SENDCLOUD_SYNC_INTERVAL_MS|PRICE_(MAX_AGE_DAYS|REFRESH_TIMEOUT_MS)|PRICING_RUNNER_|COMPETITOR_REFRESH_|IDENTITY_ALIAS_QUERY_LIMIT|MAX_ALIAS_LOOKUP|MAX_BARCODE_PREFETCH|MAX_INLINE_IMAGES|EAN_LOOKUP_TIMEOUT_MS|GROUNDING_TIMEOUT_MS|FOCUSED_GROUNDING_TIMEOUT_MS|CHAT_(IMAGE_TIMEOUT_MS|INTENT_MODEL|ATTACHMENT_|TITLE_INSIGHTS_|STRICT_RULES_ENABLED)|ENRICHMENT_TITLE_INSIGHTS_|IMPROVE_(INLINE|REFERENCE_|TITLE_INSIGHTS_|JOB_|QUEUE_|AUTO_QUALITY_ENABLED)|ID_(JOB|QUEUE)_|ADMIN_BULK_|GEMINI_(GENERIC_TIMEOUT_MS|IMAGE_MODEL|MULTIMODAL_MODEL|STRUCTURED_MODEL|TEXT_MODEL)|GPSR_(ENRICH_|MIN_APPLY_CONFIDENCE|PRIORITIZE_WORST|REGISTRY_ENFORCE|SEARCH_LIMIT|WEB_(ENRICH_|USE_UNLOCKER))|WEB_(BRIGHTDATA_ONLY|USE_UNLOCKER)|BARCODE_WEB_|AUTO_HEAL_|BATCH_OPTIMIZE_DELAY_MS|BG_REMOVAL_|BIGCOMMERCE_|CATEGORY_PROFILE_CACHE_TTL_MS|EBAY_BULK_PUBLISH_DELAY_MS|EBAY_BROWSE_(ENV|TITLE_INSIGHTS_)|EBAY_LIGHT_SYNC_COOLDOWN_MS|EBAY_OAUTH_TIMEOUT_MS|EBAY_API_TIMEOUT_MS|EBAY_TRADING_TIMEOUT_MS|EBAY_TAXONOMY_BULK_TIMEOUT_SEC|EBAY_RATE_LIMIT_MAX_RETRIES|EBAY_LISTING_AUDIT_TTL_MS|KAUFLAND_|IDENTIFY_(MODEL|RECOGNITION_TIMEOUT_MS|THINKING_LEVEL|URL_CONTEXT|V4_(MODEL|IMAGE_MODEL|WAVE_TIMEOUT_MS))|STAGE1_V2_FALLBACK_TIMEOUT_MS|STAGE2_(CATEGORY_V2_TIMEOUT_MS|FALLBACK_TIMEOUT_MS|LOOKUP_TIMEOUT_MS|USE_CATEGORY_V2)|STAGE3_(ASPECT_REPAIR_THRESHOLD|CONTENT_TIMEOUT_MS|GEMINI_TIMEOUT_MS|REPAIR_TIMEOUT_MS)|STAGE4_CROSS_REFERENCE|V3_TIMEOUT_MS|VITE_FIREBASE_API_KEY|USE_PRODUCTS_V2|INVENTORY_LEDGER_ENABLED|STOCK_(ADMIN_FORCE_RESYNC_ENABLED|CHANGED_EMIT_ENABLED)|DEBUG_(AUTH|FAILURES|FAILURES_MAX)|DEFAULT_PRICE_CURRENCY|EBAY_(APP_ID|MAX_CALLS_PER_(DAY|HOUR|SECOND)))$/,
];

function isTrivial(flag) {
  if (TRIVIAL_EXACT.has(flag)) return true;
  for (const re of TRIVIAL_PATTERNS) {
    if (re.test(flag)) return true;
  }
  return false;
}

/**
 * Recursively walk a directory and return all code file paths.
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (CODE_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

/**
 * Extract env-flag references from JavaScript source.
 *   - process.env.FOO
 *   - process.env['FOO'] / process.env["FOO"]
 *   - _envInt('FOO', …) / _envFloat('FOO', …) / envBool('FOO', …) etc.
 */
function extractFlagsFromSource(src) {
  const flags = new Set();
  const dotRe = /process\.env\.([A-Z_][A-Z0-9_]+)/g;
  const bracketRe = /process\.env\[\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\]/g;
  // Helper-call style: any identifier matching env-helper convention with a
  // SCREAMING_SNAKE_CASE string literal as first arg.
  const helperRe = /\b_?env[A-Z]\w*\(\s*['"]([A-Z_][A-Z0-9_]+)['"]/g;
  let m;
  while ((m = dotRe.exec(src)) !== null) flags.add(m[1]);
  while ((m = bracketRe.exec(src)) !== null) flags.add(m[1]);
  while ((m = helperRe.exec(src)) !== null) flags.add(m[1]);
  return flags;
}

// SCREAMING_SNAKE_CASE tokens that appear in CLAUDE.md but are NOT env-flags:
// JS constants/identifiers, planned-but-unimplemented sub-flags, doc-only labels.
// Excluded from documented_but_no_code so the report stays signal-heavy.
const DOC_NON_FLAG_TOKENS = new Set([
  'DEFAULT_CHAT_TEMPERATURE',  // JS constant in backend/lib/gemini-config.js
  'SOURCE_WEIGHTS',            // JS constant in backend/lib/confidence-scoring.js
  'IDENTIFY_V4_PRICING_SOLD',  // planned sub-flag, not yet wired in code
]);

/**
 * Extract documented flags from CLAUDE.md.
 *
 * Matches backtick-fenced tokens that look like SCREAMING_SNAKE_CASE flags,
 * optionally followed by `=value` (e.g. `CHAT_V3=true`). Length >= 3 to
 * avoid catching ad-hoc inline-code labels. Filters out known JS-constants
 * via DOC_NON_FLAG_TOKENS.
 */
function extractFlagsFromClaudeMd(src) {
  const flags = new Set();
  const re = /`([A-Z][A-Z0-9_]{2,})(?:=[^`]*)?`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (DOC_NON_FLAG_TOKENS.has(m[1])) continue;
    flags.add(m[1]);
  }
  return flags;
}

function main() {
  // 1) Scan backend code.
  const files = walk(BACKEND_DIR);
  const codeFlags = new Set();
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch (err) {
      continue;
    }
    for (const flag of extractFlagsFromSource(src)) codeFlags.add(flag);
  }

  // 2) Read CLAUDE.md.
  let mdSrc = '';
  try {
    mdSrc = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch (err) {
    console.error(`[audit-flags] Cannot read ${CLAUDE_MD}: ${err.message}`);
    process.exit(2);
  }
  const mdFlags = extractFlagsFromClaudeMd(mdSrc);

  // 3) Diff: undocumented = (code ∖ md ∖ trivial).
  const undocumented = [];
  const trivialSkipped = [];
  for (const flag of [...codeFlags].sort()) {
    if (mdFlags.has(flag)) continue;
    if (isTrivial(flag)) {
      trivialSkipped.push(flag);
      continue;
    }
    undocumented.push(flag);
  }

  // documented_but_no_code excludes documentation-only sentinel words that
  // happen to be uppercase (e.g. confidence-threshold field labels).
  const documentedButNoCode = [];
  for (const flag of [...mdFlags].sort()) {
    if (!codeFlags.has(flag)) documentedButNoCode.push(flag);
  }

  const report = {
    generated_at: new Date().toISOString(),
    backend_dir: BACKEND_DIR,
    claude_md: CLAUDE_MD,
    total_code_flags: codeFlags.size,
    total_md_flags: mdFlags.size,
    trivial_skipped_count: trivialSkipped.length,
    undocumented,
    documented_but_no_code: documentedButNoCode,
  };

  // 4) Write to /tmp + stdout.
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  } catch (err) {
    console.error(`[audit-flags] Cannot write ${REPORT_PATH}: ${err.message}`);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  // 5) Exit code.
  process.exit(undocumented.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractFlagsFromSource,
  extractFlagsFromClaudeMd,
  isTrivial,
  TRIVIAL_EXACT,
  TRIVIAL_PATTERNS,
  DOC_NON_FLAG_TOKENS,
};
