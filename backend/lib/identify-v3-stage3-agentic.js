'use strict';

/**
 * identify-v3-stage3-agentic.js — Agentic content generation for Stage 3.
 *
 * Drop-in replacement for `generateProductContent()` (`gemini3-client.js`).
 * Same input signature, same CONTENT_SCHEMA-shaped output. Internally uses the
 * Chat-V3 pattern that empirically works well: a multi-turn `ai.chats.create`
 * session with `googleSearch + urlContext + atomic-tools + write_product_datasheet`
 * tools, capped at 5 iterations with forced finalization via
 * `mode: 'ANY' + allowedFunctionNames`.
 *
 * The agentic path is gated by `STAGE3_AGENTIC` (default `false`). When the
 * flag is on, callers in `identify-v3-stage3.js` route through this module;
 * on any failure the caller falls back to the existing single-shot
 * `generateProductContent`. That gives a 3-tier defense:
 *
 *   1. Agentic (this module)         — full Chat-V3-grade tooling
 *   2. Single-shot generateProductContent — Phase-1 upgrade w/ thinking + urlContext
 *   3. V2 fallback record / minimal  — already present in stage3.js
 *
 * Output shape mirrors `CONTENT_SCHEMA`:
 *   {
 *     title_ebay, title_kaufland,
 *     description_ebay, description_kaufland,
 *     key_features: string[],
 *     item_specifics: [{key, value}],
 *     mobile_snippet,
 *     gpsr_manufacturer_name|address|email|phone|country,
 *     _agentic: { iterations, toolCalls, sawWriteCall, durationMs }
 *   }
 */

const atomicTools = require('../services/atomic-tools');
const { resolveModel } = require('./model-select');
const { getGeminiApiKey } = require('./gemini-client');
const {
  defaultThinkingConfig,
  defaultSafetySettings,
  DEFAULT_CHAT_TEMPERATURE,
} = require('./gemini-config');

// FunctionCallingConfigMode is exported by the SDK; fall back to a literal map
// if the SDK ever trims the enum (defensive).
let FunctionCallingConfigMode;
try {
  ({ FunctionCallingConfigMode } = require('@google/genai'));
} catch {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}
if (!FunctionCallingConfigMode || !FunctionCallingConfigMode.ANY) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}

const DEFAULT_MODEL = 'gemini-3-pro-preview';
const WRITE_TOOL = 'write_product_datasheet';

const _envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const _envFloat = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : fallback;
};

let _clientPromise = null;
function _getClient() {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const apiKey = await getGeminiApiKey();
      const { GoogleGenAI } = await import('@google/genai');
      return new GoogleGenAI({ apiKey });
    })();
  }
  return _clientPromise;
}

// ---------------------------------------------------------------------------
// Write-tool declaration — parameters mirror CONTENT_SCHEMA from gemini3-client.
// We intentionally do NOT re-import CONTENT_SCHEMA to avoid coupling: the
// agentic write-tool is allowed to evolve its own schema.
// ---------------------------------------------------------------------------

const WRITE_DATASHEET_DECLARATION = {
  name: WRITE_TOOL,
  description:
    'Write the FINAL product datasheet. CALL THIS EXACTLY ONCE per session ' +
    'when you have collected enough evidence. Every field must be marketplace-' +
    'ready (eBay.de + Kaufland.de). Item specifics must include all required ' +
    'aspects from the system prompt. Do NOT call atomic-tools after this.',
  parameters: {
    type: 'object',
    properties: {
      title_ebay: { type: 'string', description: 'eBay title 70-80 chars, mobile-first.' },
      title_kaufland: { type: 'string', description: 'Kaufland title up to 100 chars.' },
      description_ebay: {
        type: 'string',
        description: 'eBay HTML description, 180-240 words, <p>+<ul>+<li>+<strong>.',
      },
      description_kaufland: {
        type: 'string',
        description: 'Kaufland HTML description.',
      },
      key_features: {
        type: 'array',
        items: { type: 'string' },
        description: '5-7 bullet points "Benefit – Spec".',
      },
      item_specifics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key', 'value'],
        },
        description:
          'All required + recommended eBay aspects. Avoid "Unbekannt" — research first.',
      },
      mobile_snippet: {
        type: 'string',
        description: 'Compact plain-text summary <800 chars.',
      },
      gpsr_manufacturer_name: { type: 'string' },
      gpsr_manufacturer_address: { type: 'string' },
      gpsr_manufacturer_email: { type: 'string' },
      gpsr_manufacturer_phone: { type: 'string' },
      gpsr_manufacturer_country: { type: 'string' },
    },
    required: ['title_ebay', 'title_kaufland', 'description_ebay', 'item_specifics'],
  },
};

// ---------------------------------------------------------------------------
// Sanitizer — keeps the write-tool args inside the CONTENT_SCHEMA whitelist.
// ---------------------------------------------------------------------------

const ALLOWED_WRITE_KEYS = new Set([
  'title_ebay',
  'title_kaufland',
  'description_ebay',
  'description_kaufland',
  'key_features',
  'item_specifics',
  'mobile_snippet',
  'gpsr_manufacturer_name',
  'gpsr_manufacturer_address',
  'gpsr_manufacturer_email',
  'gpsr_manufacturer_phone',
  'gpsr_manufacturer_country',
]);

function _sanitizeWriteArgs(rawArgs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    if (!ALLOWED_WRITE_KEYS.has(k)) continue;
    if (k === 'key_features') {
      if (Array.isArray(v)) {
        out[k] = v.map((s) => String(s == null ? '' : s)).filter(Boolean).slice(0, 12);
      }
    } else if (k === 'item_specifics') {
      if (Array.isArray(v)) {
        out[k] = v
          .filter((it) => it && typeof it === 'object' && it.key && it.value != null)
          .map((it) => ({ key: String(it.key).slice(0, 80), value: String(it.value).slice(0, 200) }))
          .slice(0, 60);
      }
    } else if (typeof v === 'string') {
      out[k] = v;
    } else if (v != null) {
      out[k] = String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build system prompt — same flavour as the upgraded `generateProductContent`.
// ---------------------------------------------------------------------------

function _str(v) {
  return v == null ? '' : String(v).trim();
}

function _buildSystemPrompt({
  identity,
  enrichment,
  ocrSnippets,
  eanLookup,
  weightFallback,
  gpsrWebFallback,
  barcodeConfirmation,
  webImages,
}) {
  const sections = [];

  sections.push(
    'Du bist ein professioneller Produktdaten-Kurator fuer eBay.de und Kaufland.de.',
    '',
    'Auftrag: Erstelle ein VOLLSTAENDIGES marketplace-ready Produktdatenblatt aus den vorliegenden Daten und Bildern.',
    '',
    'Werkzeuge die Du SELBSTSTAENDIG nutzen kannst (KEINE Erlaubnis fragen):',
    '  • googleSearch          — generelle Web-Recherche (Hersteller-Specs, Aspekte)',
    '  • urlContext            — folge konkreten URLs und lies den Inhalt',
    '  • lookup_gtin           — verifiziere GTIN/EAN gegen GS1/EAN-DB/Icecat',
    '  • verify_brand          — Brand-Konsistenz pruefen',
    '  • search_ebay_catalog   — eBay Catalog by GTIN (gibt category + aspects)',
    '  • get_required_aspects  — eBay Pflicht-Artikelmerkmale fuer eine Kategorie',
    '  • search_amazon_product — Amazon-Listing fuer Spec-Cross-Reference',
    '  • search_manufacturer_site — Hersteller-Website fuer GPSR + Specs',
    '  • fetch_url_content     — beliebige URL holen wenn urlContext nicht reicht',
    '',
    'Workflow (PFLICHT):',
    '  1. Pruefe was Du schon weisst (siehe Verifizierte Daten unten).',
    '  2. RECHERCHIERE alles was fehlt — bevorzugt aus 2 unabhaengigen Quellen.',
    '  3. Wenn item_specifics-Pflichtfelder fehlen: rufe get_required_aspects + search_ebay_catalog/search_manufacturer_site BEVOR Du finalisierst.',
    '  4. Beim Abschluss: rufe write_product_datasheet GENAU EINMAL mit dem fertigen Datenblatt.',
    '',
    'KRITISCHE REGELN:',
    '  • Pflicht-Artikelmerkmale VOLLSTAENDIG ausfuellen — "Unbekannt" nur als allerletztes Mittel.',
    '  • Cross-Reference: 2+ Quellen bevor Du eine Behauptung uebernimmst.',
    '  • Nichts erfinden. Nur belegbare Fakten.',
    '  • Beschreibung: 180-240 Woerter, HTML, faktenbasiert.',
    '  • Titel: 70-80 Zeichen, mobile-first, keine Marketingfloskeln.',
    '',
  );

  sections.push('VERIFIZIERTE IDENTITAET (nicht aendern):');
  sections.push(`  Marke: ${_str(identity?.brand) || 'unbekannt'}`);
  sections.push(`  Modell: ${_str(identity?.model) || 'unbekannt'}`);
  if (identity?.mpn) sections.push(`  MPN: ${identity.mpn}`);
  if (identity?.ean) sections.push(`  EAN: ${identity.ean}`);
  if (identity?.variant) sections.push(`  Variante: ${identity.variant}`);
  if (identity?.color) sections.push(`  Farbe: ${identity.color}`);
  if (identity?.size) sections.push(`  Groesse: ${identity.size}`);
  if (identity?.material) sections.push(`  Material: ${identity.material}`);
  sections.push('');

  if (Array.isArray(ocrSnippets) && ocrSnippets.length) {
    sections.push('OCR-TEXT VOM VERPACKUNGS-LABEL (primaere Quelle fuer Aspekte):');
    ocrSnippets.slice(0, 12).forEach((s, i) => {
      const t = _str(s).slice(0, 300);
      if (t) sections.push(`  [${i + 1}] ${t}`);
    });
    sections.push('');
  }

  if (eanLookup && (eanLookup.brand || eanLookup.productName)) {
    sections.push('EAN-DATENBANK-TREFFER:');
    if (eanLookup.brand) sections.push(`  Marke: ${eanLookup.brand}`);
    if (eanLookup.productName) sections.push(`  Produkt: ${eanLookup.productName}`);
    if (eanLookup.category) sections.push(`  Kategorie: ${eanLookup.category}`);
    sections.push('');
  }

  if (Array.isArray(enrichment?.requiredAspects) && enrichment.requiredAspects.length) {
    sections.push('PFLICHT-ARTIKELMERKMALE — ALLE ausfuellen:');
    enrichment.requiredAspects.forEach((a) => sections.push(`  - ${String(a)}`));
    sections.push('');
  }

  if (enrichment?.titleInsights?.sampleTitles?.length) {
    sections.push('WETTBEWERBER-TITEL (Referenz):');
    enrichment.titleInsights.sampleTitles.slice(0, 8).forEach((t) => sections.push(`  - ${t}`));
    sections.push('');
  }
  if (enrichment?.titleInsights?.topTokens?.length) {
    sections.push(`TOP-KEYWORDS: ${enrichment.titleInsights.topTokens.join(', ')}`);
    sections.push('');
  }

  if (enrichment?.pricing?.amount > 0) {
    sections.push(`VERIFIZIERTER PREIS: ${enrichment.pricing.amount} ${enrichment.pricing.currency || 'EUR'}`);
    sections.push('');
  }

  if (weightFallback?.weight_grams) {
    sections.push(`WEB-RECHERCHIERTES GEWICHT: ${weightFallback.weight_grams} g`);
    sections.push('');
  }

  if (enrichment?.gpsr?.found) {
    sections.push('GPSR (Registry, verifiziert, nicht aendern):');
    const g = enrichment.gpsr.data || {};
    if (g.manufacturer_name) sections.push(`  Name: ${g.manufacturer_name}`);
    if (g.manufacturer_address) sections.push(`  Adresse: ${g.manufacturer_address}`);
    if (g.email) sections.push(`  E-Mail: ${g.email}`);
    if (g.manufacturer_phone) sections.push(`  Telefon: ${g.manufacturer_phone}`);
    if (g.entity_country) sections.push(`  Land: ${g.entity_country}`);
    sections.push('');
  } else if (gpsrWebFallback?.manufacturer_name) {
    sections.push('GPSR (Web-Recherche, plausibel pruefen):');
    if (gpsrWebFallback.manufacturer_name) sections.push(`  Name: ${gpsrWebFallback.manufacturer_name}`);
    if (gpsrWebFallback.manufacturer_address) sections.push(`  Adresse: ${gpsrWebFallback.manufacturer_address}`);
    if (gpsrWebFallback.email) sections.push(`  E-Mail: ${gpsrWebFallback.email}`);
    sections.push('');
  }

  if (barcodeConfirmation?.evidence?.length) {
    sections.push('BARCODE-WEB-BESTAETIGUNG:');
    barcodeConfirmation.evidence.slice(0, 5).forEach((e) => {
      const t = _str(e?.title).slice(0, 140);
      const u = _str(e?.url);
      if (t || u) sections.push(`  - ${t}${u ? ` (${u})` : ''}`);
    });
    sections.push('');
  }

  if (Array.isArray(webImages) && webImages.length) {
    const titles = webImages.map((i) => i?.title).filter(Boolean).slice(0, 6);
    if (titles.length) {
      sections.push('WEB-BILD-TITEL (Varianten-Kontext):');
      titles.forEach((t) => sections.push(`  - ${t.slice(0, 120)}`));
      sections.push('');
    }
  }

  if (enrichment?.category?.ebayBreadcrumb) {
    sections.push(`EBAY-KATEGORIE: ${enrichment.category.ebayBreadcrumb}`);
    sections.push('');
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Retry wrapper — adapted from product-chat-v3.withGeminiRetryV3.
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [500, 1000];

async function _withRetry(operation, label = 'agentic') {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retryable = status >= 500 || status === 429 || status == null;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = _envInt('STAGE3_AGENTIC_MAX_ITERATIONS', 5);
const SOFT_RESEARCH_LIMIT = _envInt('STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT', 3);
const TOTAL_TIMEOUT_MS = _envInt('STAGE3_AGENTIC_TIMEOUT_MS', 90000);

async function generateProductContentAgentic({
  identity = {},
  enrichment = {},
  imageParts = [],
  locale = 'de-DE',
  ocrSnippets = [],
  eanLookup = null,
  webImages = [],
  weightFallback = null,
  gpsrWebFallback = null,
  barcodeConfirmation = null,
  // Optional DI for tests.
  aiClient = null,
  modelOverride = null,
} = {}) {
  const startedAt = Date.now();
  const ai = aiClient || (await _getClient());
  const model = modelOverride || resolveModel(null, 'IDENTIFY_MODEL', DEFAULT_MODEL);

  const trace = {
    iterations: 0,
    toolCalls: [],
    sawWriteCall: false,
    forcedFinalizations: 0,
    durationMs: 0,
  };

  const state = {
    finalArgs: null,
  };

  const systemPrompt = _buildSystemPrompt({
    identity,
    enrichment,
    ocrSnippets,
    eanLookup,
    weightFallback,
    gpsrWebFallback,
    barcodeConfirmation,
    webImages,
  });

  const tools = [
    { googleSearch: {} },
    { urlContext: {} },
    {
      functionDeclarations: [
        ...atomicTools.buildToolList({ includeAmazon: true, includeManufacturer: true }),
        WRITE_DATASHEET_DECLARATION,
      ],
    },
  ];

  const config = {
    temperature: _envFloat('STAGE3_AGENTIC_TEMPERATURE', DEFAULT_CHAT_TEMPERATURE),
    maxOutputTokens: _envInt('STAGE3_AGENTIC_MAX_TOKENS', 12000),
    thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: false }),
    safetySettings: defaultSafetySettings(),
    tools,
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
      includeServerSideToolInvocations: true,
    },
    systemInstruction: systemPrompt,
  };

  const chat = ai.chats.create({ model, config, history: [] });
  const executorMap = atomicTools.buildToolExecutorMap();

  // Initial user message — images + a short instruction.
  const userParts = [];
  const maxImages = _envInt('STAGE3_AGENTIC_MAX_IMAGES', 4);
  for (const img of (Array.isArray(imageParts) ? imageParts : []).slice(0, maxImages)) {
    if (!img?.data) continue;
    userParts.push({
      inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data },
    });
  }
  userParts.push({
    text:
      'Erstelle das vollstaendige eBay+Kaufland-Datenblatt fuer das oben gezeigte Produkt. ' +
      'Recherchiere alles was unsicher ist und schliesse mit einem write_product_datasheet-Call ab.',
  });

  // Wall-clock total timeout (covers pathological multi-iteration hangs).
  const totalTimeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`agentic stage 3 total timeout after ${TOTAL_TIMEOUT_MS}ms`)),
      TOTAL_TIMEOUT_MS,
    ),
  );
  totalTimeoutPromise.catch(() => {}); // never an unhandled rejection

  const work = (async () => {
    let response = await _withRetry(
      () => chat.sendMessage({ message: userParts }),
      'sendMessage-initial',
    );

    let researchOnlyIters = 0;

    while (
      response &&
      Array.isArray(response.functionCalls) &&
      response.functionCalls.length > 0 &&
      trace.iterations < MAX_ITERATIONS
    ) {
      const callList = response.functionCalls;
      const hasWriteCall = callList.some((c) => c && c.name === WRITE_TOOL);
      if (hasWriteCall) {
        trace.sawWriteCall = true;
        researchOnlyIters = 0;
      } else {
        researchOnlyIters += 1;
      }

      const toolResponses = await Promise.all(
        callList.map(async (call) => {
          const callName = call?.name || 'unknown';
          const callId = call?.id || null;
          const callArgs = call?.args || {};
          const ts0 = Date.now();
          let result;
          try {
            if (callName === WRITE_TOOL) {
              const sanitized = _sanitizeWriteArgs(callArgs);
              state.finalArgs = sanitized;
              result = { ok: true, source: WRITE_TOOL, data: { accepted: true }, confidence: 1 };
            } else if (typeof executorMap[callName] === 'function') {
              result = await executorMap[callName](callArgs);
            } else {
              result = {
                ok: false,
                source: callName,
                data: null,
                error: { code: 'UNKNOWN_TOOL', message: `No executor for ${callName}` },
              };
            }
          } catch (err) {
            result = {
              ok: false,
              source: callName,
              data: null,
              error: { code: 'EXECUTOR_THREW', message: err?.message || String(err) },
            };
          }

          trace.toolCalls.push({
            id: callId,
            name: callName,
            ok: Boolean(result?.ok),
            latencyMs: Date.now() - ts0,
            error: result?.error?.message || null,
          });

          return {
            functionResponse: {
              id: callId || undefined,
              name: callName,
              response: result,
            },
          };
        }),
      );

      trace.iterations += 1;

      // If the write-tool fired this iteration, we're done — break and emit the result.
      if (state.finalArgs) break;

      const atLastIter = trace.iterations >= MAX_ITERATIONS;
      const softForce = !trace.sawWriteCall && researchOnlyIters >= SOFT_RESEARCH_LIMIT;
      const forceFinalize = atLastIter || softForce;
      if (forceFinalize) trace.forcedFinalizations += 1;

      const sendConfig = forceFinalize
        ? {
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: [WRITE_TOOL],
              },
            },
          }
        : undefined;

      // eslint-disable-next-line no-await-in-loop
      response = await _withRetry(
        () =>
          sendConfig
            ? chat.sendMessage({ message: toolResponses, config: sendConfig })
            : chat.sendMessage({ message: toolResponses }),
        forceFinalize ? 'sendMessage-forced' : 'sendMessage-loop',
      );
    }

    // Ultimate fallback — if loop ran out without a write-call, send one
    // last forced-finalize message asking ONLY for write_product_datasheet.
    if (!state.finalArgs) {
      try {
        const fallbackResponse = await _withRetry(
          () =>
            chat.sendMessage({
              message: [
                {
                  text:
                    'Schreibe JETZT das fertige Datenblatt mit write_product_datasheet — ' +
                    'keine weitere Recherche.',
                },
              ],
              config: {
                toolConfig: {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.ANY,
                    allowedFunctionNames: [WRITE_TOOL],
                  },
                },
              },
            }),
          'sendMessage-ultimate',
        );
        const calls = fallbackResponse?.functionCalls || [];
        const writeCall = calls.find((c) => c && c.name === WRITE_TOOL);
        if (writeCall) {
          state.finalArgs = _sanitizeWriteArgs(writeCall.args || {});
          trace.sawWriteCall = true;
          trace.forcedFinalizations += 1;
        }
      } catch (err) {
        // Surface as throw — caller will fall back to single-shot.
        throw new Error(`agentic stage 3: ultimate finalize failed: ${err?.message || err}`);
      }
    }

    if (!state.finalArgs) {
      throw new Error('agentic stage 3: no write_product_datasheet call after all retries');
    }
  })();

  try {
    await Promise.race([work, totalTimeoutPromise]);
  } catch (err) {
    trace.durationMs = Date.now() - startedAt;
    throw Object.assign(err, { _agentic: trace });
  }

  trace.durationMs = Date.now() - startedAt;

  return {
    ...state.finalArgs,
    _agentic: {
      iterations: trace.iterations,
      toolCalls: trace.toolCalls,
      sawWriteCall: trace.sawWriteCall,
      forcedFinalizations: trace.forcedFinalizations,
      durationMs: trace.durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Feature-flag helpers.
// ---------------------------------------------------------------------------

function isAgenticEnabled() {
  const raw = String(process.env.STAGE3_AGENTIC || '').trim().toLowerCase();
  // Explicit opt-out
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  // Explicit opt-in
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  // Sample-based opt-in (deterministic per call) — sample = 0.0..1.0.
  // Only consulted when STAGE3_AGENTIC itself is not set — useful for canary
  // periods. With STAGE3_AGENTIC defaulting to ON below, sample is a way to
  // partially DISABLE (sample=0).
  const sampleRaw = String(process.env.STAGE3_AGENTIC_SAMPLE || '').trim();
  if (sampleRaw) {
    const s = Number.parseFloat(sampleRaw);
    if (Number.isFinite(s) && s >= 0 && s <= 1) {
      return Math.random() < s;
    }
  }
  // Default: ON. The agentic path has a 3-tier fallback (single-shot → V2-record),
  // so a runtime failure cannot break the pipeline — it gracefully degrades.
  return true;
}

module.exports = {
  generateProductContentAgentic,
  isAgenticEnabled,
  // exposed for tests
  _internal: {
    sanitizeWriteArgs: _sanitizeWriteArgs,
    buildSystemPrompt: _buildSystemPrompt,
    WRITE_DATASHEET_DECLARATION,
  },
};
