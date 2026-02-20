/* eslint-disable no-console */
/**
 * Enrich ONE manufacturer GPSR record (registry-level) via web evidence + Gemini.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-enrich-manufacturer.js --manufacturer Adidas --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-enrich-manufacturer.js --manufacturer Adidas --apply
 *
 * Env:
 *   WEB_USE_UNLOCKER=true
 *   GPSR_SEARCH_LIMIT=10
 *   GPSR_ENRICH_MAX_PAGES=5
 *   GPSR_MIN_APPLY_CONFIDENCE=0.6
 */

const { search, fetchText } = require('../lib/evidence-provider');
const { callGeminiStructured } = require('../lib/gemini-structured');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { upsertManufacturerGpsr, isGpsrPlaceholderLike } = require('../lib/gpsr-manufacturer-registry');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}
function htmlToText(html = '') {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:div|p|br|li|ul|ol|h\d|tr|td|th|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeSpaces(cleaned).slice(0, 200_000);
}

function tryParseJsonLenient(text) {
  const raw = (text == null ? '' : String(text)).trim();
  if (!raw) return { ok: false, error: 'empty' };

  const stripBOM = (s) => s.replace(/^\uFEFF/, '');
  const extractFirstFencedBlock = (s) => {
    const m = String(s).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return m ? String(m[1]).trim() : String(s);
  };
  const stripOuterFences = (s) =>
    String(s)
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

  const extractBalancedJson = (s, startIdx) => {
    const src = String(s);
    if (startIdx < 0 || startIdx >= src.length) return null;
    const open = src[startIdx];
    const close = open === '{' ? '}' : open === '[' ? ']' : null;
    if (!close) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < src.length; i += 1) {
      const ch = src[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) depth -= 1;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
    return null;
  };

  const cleaned = stripOuterFences(extractFirstFencedBlock(stripBOM(raw)));
  const candidates = [cleaned];

  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  const firstStart = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (firstStart !== -1) {
    const balanced = extractBalancedJson(cleaned, firstStart);
    if (balanced) candidates.push(balanced);
  }

  const normalizeJsonish = (s) =>
    String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(normalizeJsonish(c));
      if (parsed && typeof parsed === 'object') return { ok: true, parsed };
    } catch {
      // try next
    }
  }
  return { ok: false, error: 'json_parse_failed', rawPreview: cleaned.slice(0, 800) };
}

const GPSR_SCHEMA = {
  type: 'object',
  properties: {
    entity_country: { type: 'string' },
    manufacturer_name: { type: 'string' },
    manufacturer_address: { type: 'string' },
    manufacturer_city: { type: 'string' },
    manufacturer_postalcode: { type: 'string' },
    manufacturer_state_province: { type: 'string' },
    manufacturer_email: { type: 'string' },
    manufacturer_phone: { type: 'string' },
    manufacturer_url: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: [
    'entity_country',
    'manufacturer_name',
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'manufacturer_email',
    'manufacturer_phone',
    'manufacturer_url',
    'sources',
    'confidence',
  ],
};

function buildQueries(manufacturer) {
  const m = safeString(manufacturer);
  const qs = [
    `${m} Impressum Adresse E-Mail Telefon`,
    `${m} Kontakt Adresse E-Mail Telefon`,
    `${m} manufacturer address email phone`,
    `${m} site:adidas.com impressum adresse telefon`,
    `${m} headquarters address email phone`,
  ];
  return Array.from(new Set(qs.map((x) => normalizeSpaces(x)).filter(Boolean))).slice(0, 8);
}

function buildPrompt({ manufacturer, evidenceBlocks, urls }) {
  const policy = buildCommonPolicyText({ mode: 'gpsr' });
  return normalizeSpaces(`
${policy}

TASK:
Extract GPSR manufacturer/contact data for the manufacturer below using ONLY the provided WEB EVIDENCE.
If a value is not clearly supported by evidence, return an empty string for that field.
Do NOT refuse. Do NOT complain. Do NOT mention policy. Just return JSON matching the schema.

Manufacturer: ${manufacturer}

Fields to extract:
- entity_country (English country name, e.g. "Germany")
- manufacturer_name
- manufacturer_address (street + house number only; no postal code/city/country)
- manufacturer_city
- manufacturer_postalcode
- manufacturer_state_province
- manufacturer_email (support email ok)
- manufacturer_phone (support hotline ok)
- manufacturer_url (official website)

Sources:
You MUST output "sources" as the subset of URLs you used from this list:
${urls.map((u) => `- ${u}`).join('\n')}

WEB EVIDENCE (snippets):
${evidenceBlocks.join('\n\n---\n\n').slice(0, 120_000)}
  `).trim();
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const manufacturer = safeString(argValue('--manufacturer', process.env.MANUFACTURER || ''));
  if (!manufacturer) throw new Error('--manufacturer is required');

  const searchLimit = Math.max(3, Math.min(15, parseInt(process.env.GPSR_SEARCH_LIMIT || '10', 10) || 10));
  const maxPages = Math.max(1, Math.min(8, parseInt(process.env.GPSR_ENRICH_MAX_PAGES || '5', 10) || 5));
  const minApplyConfidence = Math.max(0, Math.min(1, parseFloat(process.env.GPSR_MIN_APPLY_CONFIDENCE || '0.6') || 0.6));

  console.log(JSON.stringify({ action: 'gpsr-enrich-manufacturer', dryRun, manufacturer, searchLimit, maxPages, minApplyConfidence }, null, 2));

  let urls = [];
  let chosenQuery = '';
  for (const q of buildQueries(manufacturer)) {
    const res = await search(q, { limit: searchLimit, locale: 'de-DE' });
    const found = Array.isArray(res?.results) ? res.results.map((r) => safeString(r?.url)).filter(Boolean) : [];
    if (found.length) {
      chosenQuery = q;
      urls = found.slice(0, maxPages);
      break;
    }
  }
  if (!urls.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no_search_results', chosenQuery }, null, 2));
    process.exitCode = 2;
    return;
  }

  const pages = (
    await Promise.all(
      urls.map(async (u) => {
        const fetched = await fetchText(u, { timeoutMs: 30_000 }).catch(() => null);
        if (!fetched?.ok || !fetched?.text) return null;
        return { url: u, text: fetched.text };
      })
    )
  ).filter(Boolean);

  if (!pages.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no_pages_fetched', chosenQuery, urls }, null, 2));
    process.exitCode = 2;
    return;
  }

  const evidenceBlocks = pages.map((p) => `URL: ${p.url}\n${htmlToText(p.text).slice(0, 25_000)}`);
  const prompt = buildPrompt({ manufacturer, evidenceBlocks, urls });

  const jsonText = await callGeminiStructured({
    parts: [{ text: prompt }],
    responseSchema: GPSR_SCHEMA,
    temperature: 0.0,
    maxOutputTokens: 2048,
    stopSequences: [],
  });

  const attempt = tryParseJsonLenient(jsonText);
  if (!attempt.ok) {
    console.log(JSON.stringify({ ok: false, reason: 'json_parse_failed', rawPreview: attempt.rawPreview || null }, null, 2));
    process.exitCode = 2;
    return;
  }
  const parsed = attempt.parsed;

  const extracted = {
    entity_country: safeString(parsed.entity_country),
    manufacturer_name: safeString(parsed.manufacturer_name) || manufacturer,
    manufacturer_address: safeString(parsed.manufacturer_address),
    manufacturer_city: safeString(parsed.manufacturer_city),
    manufacturer_postalcode: safeString(parsed.manufacturer_postalcode),
    manufacturer_state_province: safeString(parsed.manufacturer_state_province),
    email: safeString(parsed.manufacturer_email),
    manufacturer_phone: safeString(parsed.manufacturer_phone),
    url: safeString(parsed.manufacturer_url),
  };
  for (const [k, v] of Object.entries(extracted)) {
    if (isGpsrPlaceholderLike(v)) extracted[k] = '';
  }

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const src = Array.isArray(parsed.sources) ? parsed.sources.map((x) => safeString(x)).filter(Boolean) : [];
  const effectiveSources = src.length ? src : urls;
  const canApply = effectiveSources.length > 0 && confidence >= minApplyConfidence;

  console.log(JSON.stringify({ ok: true, chosenQuery, confidence, canApply, sources: effectiveSources.slice(0, 8), extracted }, null, 2));

  if (!dryRun && canApply) {
    await upsertManufacturerGpsr({
      manufacturer_name: extracted.manufacturer_name || manufacturer,
      gpsr: extracted,
      confidence,
      sources: effectiveSources,
      from_product_id: `manufacturer:${manufacturer}`,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

