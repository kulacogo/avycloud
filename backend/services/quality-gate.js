/* eslint-disable no-console */
/**
 * Product Data Quality Gate (v1)
 *
 * Goals:
 * - Holistic validation of a product datasheet for "eBay-ready" publishing.
 * - Combine deterministic rules + web evidence + LLM plausibility review (optional).
 * - Persist results under ops.data_quality.quality_gate_v1 to surface in UI.
 *
 * IMPORTANT:
 * - No silent assumptions: LLM must only use provided evidence (web excerpts + images + product snapshot).
 * - Web search uses HTML fetch (no SerpAPI).
 */

const crypto = require('crypto');
const { buildGenerationConfig } = require('../lib/gemini-config');
const sharp = require('sharp');
const { Firestore, Timestamp } = require('@google-cloud/firestore');

const { getProduct, PRODUCTS_COLLECTION } = require('../lib/firestore');
const { resolveModel } = require('../lib/model-select');
const { getGeminiClient } = require('../lib/gemini-client');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { evaluateEbayReady } = require('../lib/datasheet-quality');
const { buildEbayReadyIssuesDetailed } = require('../lib/ebay-ready-issues');
const { isValidGtin, normalizeDigits } = require('../lib/gtin');
const { searchWeb, fetchPageText } = require('../lib/web-search-html');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const USE_LLM = (process.env.QUALITY_GATE_USE_LLM || 'true').toString().toLowerCase() !== 'false';
const USE_UNLOCKER =
  (process.env.QUALITY_GATE_USE_UNLOCKER ||
    process.env.WEB_USE_UNLOCKER ||
    process.env.BARCODE_WEB_USE_UNLOCKER ||
    '')
    .toString()
    .toLowerCase() === 'true';

const MAX_EVIDENCE_RESULTS = parseInt(process.env.QUALITY_GATE_EVIDENCE_RESULTS || '6', 10);
const MAX_EVIDENCE_PAGES = parseInt(process.env.QUALITY_GATE_EVIDENCE_PAGES || '3', 10);
const MAX_IMAGES = parseInt(process.env.QUALITY_GATE_IMAGE_COUNT || '2', 10);
const IMAGE_MAX_EDGE = parseInt(process.env.QUALITY_GATE_IMAGE_MAX_EDGE || '1200', 10);
const IMAGE_JPEG_QUALITY = parseInt(process.env.QUALITY_GATE_IMAGE_JPEG_QUALITY || '84', 10);

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeLower(v) {
  return safeString(v).toLowerCase();
}

function isUnknownValue(v) {
  const s = normalizeLower(v);
  return (
    !s ||
    s === 'unbekannt' ||
    s === 'unknown' ||
    s === 'n/a' ||
    s === 'na' ||
    s === '-' ||
    s === '—' ||
    s === '--' ||
    s === 'null' ||
    s === 'undefined'
  );
}

function findAttrValue(attrs, candidatesLower = []) {
  const obj = attrs && typeof attrs === 'object' ? attrs : {};
  const wanted = new Set((candidatesLower || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  for (const key of Object.keys(obj)) {
    const lower = String(key || '').trim().toLowerCase();
    if (!wanted.has(lower)) continue;
    const value = safeString(obj[key]);
    if (!value) continue;
    return { key, value };
  }
  return null;
}

function normalizeAttrValue(v) {
  return safeString(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractWeightsKgFromText(text) {
  const out = [];
  const t = String(text || '').replace(/\u00a0/g, ' ');
  // kg / kilogramm
  for (const m of t.matchAll(/(\d{1,3}(?:[.,]\d{1,3})?)\s*(kg|kilogramm)\b/gi)) {
    const raw = (m[1] || '').replace(',', '.');
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0 && n < 500) out.push(n);
  }
  // g → kg (ignore tiny values)
  for (const m of t.matchAll(/(\d{2,6}(?:[.,]\d{1,3})?)\s*g\b/gi)) {
    const raw = (m[1] || '').replace(',', '.');
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 10 && n < 500000) out.push(n / 1000);
  }
  return out;
}

function sanitizeValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Timestamp) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((x) => x !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const s = sanitizeValue(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return value;
}

function pickPrimaryBarcode(product) {
  const ids = product?.details?.identifiers || {};
  const list = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([ids.ean, ids.gtin, ids.upc])
    .filter(Boolean)
    .map((v) => normalizeDigits(String(v)));
  const valid = list.find((c) => c && [8, 12, 13, 14].includes(c.length) && isValidGtin(c)) || '';
  return valid;
}

function buildEvidenceQuery(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  const idBrandRaw = safeString(product?.identification?.brand);
  const attrBrand = findAttrValue(attrs, ['marke', 'brand', 'hersteller', 'manufacturer']);
  const brand = !isUnknownValue(idBrandRaw)
    ? idBrandRaw
    : attrBrand?.value && !isUnknownValue(attrBrand.value)
      ? attrBrand.value
      : '';

  const mpn =
    safeString(ids.mpn) ||
    safeString(findAttrValue(attrs, ['herstellernummer', 'mpn', 'modellnummer', 'model', 'modell'])?.value);
  const barcode = pickPrimaryBarcode(product);
  const title = safeString(product?.identification?.name)
    .replace(/\bSKU[\s\-_]?\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (barcode) return `${barcode} ${brand} ${mpn}`.trim();
  if (brand && mpn) return `${brand} ${mpn}`.trim();
  if (mpn) return `${mpn} ${brand} ${title}`.trim().slice(0, 160);
  return `${brand} ${title}`.trim();
}

async function collectWebEvidence(product, { locale = 'de-DE' } = {}) {
  const query = buildEvidenceQuery(product);
  if (!query) return null;
  const search = await searchWeb(query, { limit: Math.max(1, MAX_EVIDENCE_RESULTS), locale });
  const results = Array.isArray(search?.results) ? search.results : [];
  const checked = [];

  for (const r of results.slice(0, MAX_EVIDENCE_PAGES)) {
    if (!r?.url) continue;
    const page = await fetchPageText(r.url, { timeoutMs: 25_000 });
    checked.push({
      title: r.title || '',
      url: r.url,
      ok: Boolean(page.ok),
      status: page.status,
      via: page.via,
      excerpt: page.ok ? String(page.text || '').slice(0, 900) : '',
    });
  }

  return {
    query,
    engine: search.engine,
    search_url: search.url,
    fetched_at_iso: new Date().toISOString(),
    results: results.slice(0, MAX_EVIDENCE_RESULTS).map((x) => ({ title: x.title || '', url: x.url })),
    pages: checked,
  };
}

async function fetchImageBase64(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // Prefer unlocker when enabled; otherwise direct fetch (node fetch).
  if (USE_UNLOCKER) {
    try {
      const unlocked = await fetchWithUnlocker({ url, timeoutMs: 30_000 });
      if (unlocked?.success && unlocked?.body_base64 && /^image\//i.test(unlocked?.contentType || '')) {
        return { mimeType: unlocked.contentType || 'image/jpeg', base64: unlocked.body_base64 };
      }
    } catch {
      // fall back to direct
    }
  }
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType: contentType, base64: buf.toString('base64') };
  } catch {
    return null;
  }
}

async function compressImagePart({ base64, mimeType }) {
  try {
    const input = Buffer.from(base64, 'base64');
    const pipeline = sharp(input).rotate();
    const meta = await pipeline.metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    let resized = pipeline;
    if (longest > IMAGE_MAX_EDGE) {
      resized =
        meta.width >= meta.height
          ? resized.resize({ width: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          : resized.resize({ height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    }
    const out = await resized.jpeg({ quality: IMAGE_JPEG_QUALITY, chromaSubsampling: '4:2:0' }).toBuffer();
    return { mimeType: 'image/jpeg', base64: out.toString('base64') };
  } catch {
    // If compression fails, use original
    return { mimeType, base64 };
  }
}

function buildRuleIssues(product, { webEvidence } = {}) {
  const q = evaluateEbayReady(product, { force: true });
  const issues = [];
  const details = product?.details || {};
  const attrs = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const titleLower = normalizeLower(product?.identification?.name);
  const categoryLower = normalizeLower(product?.identification?.category);
  const descLower = normalizeLower(details?.short_description || details?.description);

  const baseIssues =
    Array.isArray(q?.issuesDetailed) && q.issuesDetailed.length
      ? q.issuesDetailed
      : buildEbayReadyIssuesDetailed(q?.issues || []);
  baseIssues.forEach((i) => {
    if (!i || typeof i !== 'object') return;
    issues.push(i);
  });

  // Additional deterministic checks
  const bar = pickPrimaryBarcode(product);
  if (!bar) {
    issues.push({
      code: 'barcode_missing',
      severity: 'warn',
      fields: ['identification.barcodes', 'details.identifiers'],
      message: 'Kein validierter Barcode (EAN/GTIN/UPC) vorhanden.',
      source: 'rule',
      confidence: 0.9,
    });
  }

  // Category plausibility (high-signal): prevent obvious branch mistakes like E‑Scooter under "Fahrzeuge > Automobile"
  const isAutomobileBranch = categoryLower.includes('fahrzeuge') && categoryLower.includes('automobile');
  const looksLikeEScooter =
    /\be[-\s]?scooter\b/.test(titleLower) ||
    /\bescooter\b/.test(titleLower) ||
    /\be[-\s]?roller\b/.test(titleLower) ||
    /\btrottinett\b/.test(titleLower) ||
    /\bscooter\b/.test(titleLower) ||
    /\be[-\s]?scooter\b/.test(descLower) ||
    /\be[-\s]?roller\b/.test(descLower);
  if (isAutomobileBranch && looksLikeEScooter) {
    issues.push({
      code: 'category_implausible_vehicle_branch',
      severity: 'error',
      fields: ['identification.category', 'details.categoryId'],
      message: 'Kategorie wirkt wie PKW/Automobile, aber Produkt/Titel deutet klar auf E‑Scooter/Scooter hin. Bitte Kategorie prüfen.',
      source: 'rule',
      confidence: 0.9,
    });
  }

  // Duplicate / redundant attributes with identical values (e.g. "Schutzart=IPX5" and "Spritzwasserschutz=IPX5")
  if (attrs && typeof attrs === 'object') {
    const ignoredKeys = new Set(['ean', 'gtin', 'upc', 'sku', 'k-typ', 'ktyp', 'k typ', 'weight']);
    const groups = new Map();
    for (const [k, v] of Object.entries(attrs)) {
      const keyLower = String(k || '').trim().toLowerCase();
      if (!k || ignoredKeys.has(keyLower)) continue;
      const norm = normalizeAttrValue(v);
      if (!norm || norm.length < 3) continue;
      const g = groups.get(norm) || { value: safeString(v), keys: [] };
      g.keys.push(String(k));
      groups.set(norm, g);
    }
    for (const [valNorm, g] of groups.entries()) {
      if (!g?.keys || g.keys.length < 2) continue;
      const keys = g.keys.slice(0, 6);
      const isIpRating = /^ipx?\d/i.test(valNorm) || /^ip\d{2}/i.test(valNorm);
      issues.push({
        code: isIpRating ? 'attributes_duplicate_ip_rating' : 'attributes_duplicate_value',
        severity: 'warn',
        fields: keys.map((k) => `details.attributes.${k}`),
        message: `Redundante Attribute: gleicher Wert "${g.value}" in ${keys.join(', ')}.`,
        source: 'rule',
        confidence: 0.85,
      });
    }
  }

  // Brand plausibility: mismatch between identification.brand and attribute brand / unverified brand without evidence
  const attrBrand = findAttrValue(attrs, ['marke', 'brand', 'hersteller', 'manufacturer']);
  const idBrandRaw = safeString(product?.identification?.brand);
  if (idBrandRaw && isUnknownValue(idBrandRaw)) {
    issues.push({
      code: 'brand_unknown',
      severity: 'warn',
      fields: ['identification.brand'],
      message: 'Marke/Hersteller ist "Unbekannt" – bitte prüfen/ergänzen.',
      source: 'rule',
      confidence: 0.8,
    });
  }
  if (attrBrand?.value) {
    const idBrandNorm = normalizeLower(idBrandRaw);
    const attrBrandNorm = normalizeLower(attrBrand.value);
    if (!idBrandRaw || isUnknownValue(idBrandRaw) || (idBrandNorm && attrBrandNorm && idBrandNorm !== attrBrandNorm)) {
      issues.push({
        code: 'brand_inconsistent',
        severity: 'warn',
        fields: ['identification.brand', `details.attributes.${attrBrand.key}`],
        message: `Marke inkonsistent: identification.brand="${idBrandRaw || '—'}", ${attrBrand.key}="${attrBrand.value}".`,
        source: 'rule',
        confidence: 0.85,
      });
    }
  }
  const candidateBrand = !isUnknownValue(idBrandRaw) ? idBrandRaw : safeString(attrBrand?.value);
  if (candidateBrand && !isUnknownValue(candidateBrand) && !bar) {
    const pages = Array.isArray(webEvidence?.pages) ? webEvidence.pages : [];
    const evidenceText = pages
      .filter((p) => p?.ok)
      .map((p) => String(p?.excerpt || ''))
      .join('\n')
      .toLowerCase();
    if (evidenceText && !evidenceText.includes(candidateBrand.toLowerCase())) {
      issues.push({
        code: 'brand_unverified_web',
        severity: 'warn',
        fields: ['identification.brand', 'identification.name'],
        message: `Marke "${candidateBrand}" ist ohne Barcode nicht durch Web-Evidenz bestätigt (Brand nicht in Quellen gefunden).`,
        evidence_urls: pages.filter((p) => p?.ok && p?.url).slice(0, 5).map((p) => p.url),
        source: 'rule',
        confidence: 0.45,
      });
    }
  }

  // Weight presence check: flag products with no weight at all.
  const storedWeight = Number(attrs?.weight || details?.weight || attrs?.['Gewicht (kg)'] || 0);
  const hasStoredWeight = Number.isFinite(storedWeight) && storedWeight > 0;
  if (!hasStoredWeight) {
    issues.push({
      code: 'weight_missing',
      severity: 'warn',
      fields: ['details.weight'],
      message: 'Produktgewicht fehlt. Pflichtfeld für Carrier-Zuordnung (DHL/DPD) und Versandkosten-Kalkulation.',
      source: 'rule',
      confidence: 1.0,
    });
  }

  // Weight plausibility: compare stored bucket weight with web evidence or high-signal keywords.
  const pages = Array.isArray(webEvidence?.pages) ? webEvidence.pages : [];
  const weightHits = [];
  for (const p of pages.filter((x) => x?.ok)) {
    const weights = extractWeightsKgFromText(p?.excerpt || '');
    for (const kg of weights.slice(0, 3)) {
      if (Number.isFinite(kg) && kg > 0) weightHits.push({ kg, url: p?.url });
    }
  }
  const bestEvidenceKg = weightHits.length ? Math.max(...weightHits.map((h) => h.kg)) : null;
  if (hasStoredWeight && bestEvidenceKg && (bestEvidenceKg >= storedWeight * 3 || bestEvidenceKg - storedWeight >= 5)) {
    issues.push({
      code: 'weight_mismatch_web',
      severity: 'warn',
      fields: ['details.attributes.weight'],
      message: `Gewicht wirkt unplausibel: gespeichert ~${storedWeight}kg, Web-Evidenz ~${bestEvidenceKg.toFixed(2)}kg.`,
      evidence_urls: Array.from(new Set(weightHits.map((h) => h.url).filter(Boolean))).slice(0, 5),
      source: 'rule',
      confidence: 0.7,
    });
  } else if (hasStoredWeight && storedWeight <= 2) {
    const heavyKeyword =
      /\bräucher/.test(titleLower) ||
      /\bsmoker\b/.test(titleLower) ||
      /\bgrill\b/.test(titleLower) ||
      /\bofen\b/.test(titleLower) ||
      /\bkamin\b/.test(titleLower) ||
      /\bweber\b/.test(titleLower);
    if (heavyKeyword) {
      issues.push({
        code: 'weight_suspicious_low',
        severity: 'warn',
        fields: ['details.attributes.weight'],
        message: `Gewicht wirkt zu niedrig (${storedWeight}kg) für Produkt-Typ (z.B. Ofen/Smoker/Grill). Bitte prüfen.`,
        source: 'rule',
        confidence: 0.65,
      });
    }
  }

  return { ok: q.ok && issues.filter((i) => i.severity === 'error').length === 0, issues, snapshot: q.snapshot };
}

function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  const cleaned = { ...schema };
  if (Array.isArray(cleaned.type)) {
    const valid = cleaned.type.filter((t) => t !== 'null');
    cleaned.type = valid.length === 1 ? valid[0] : valid[0] || 'string';
  }
  if (cleaned.properties) {
    const props = {};
    for (const [k, v] of Object.entries(cleaned.properties)) props[k] = cleanSchemaForGemini(v);
    cleaned.properties = props;
  }
  if (cleaned.items) cleaned.items = cleanSchemaForGemini(cleaned.items);
  delete cleaned.additionalProperties;
  delete cleaned.default;
  return cleaned;
}

const QUALITY_GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'issues'],
  properties: {
    summary: { type: 'string', minLength: 10, maxLength: 500 },
    issues: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'message', 'fields', 'confidence'],
        properties: {
          code: { type: 'string', minLength: 3, maxLength: 80 },
          severity: { type: 'string', enum: ['error', 'warn', 'info'] },
          message: { type: 'string', minLength: 6, maxLength: 300 },
          fields: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 80 } },
          evidence_urls: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 6, maxLength: 400 } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

function buildLlmPrompt({ product, webEvidence, ruleIssues, locale }) {
  const snapshot = {
    id: product?.id,
    brand: product?.identification?.brand,
    title: product?.identification?.name,
    category: product?.identification?.category,
    categoryId: product?.details?.categoryId,
    identifiers: product?.details?.identifiers,
    barcodes: product?.identification?.barcodes,
    attributes: product?.details?.attributes,
    highlights: product?.details?.key_features,
    description: product?.details?.short_description,
    images: (product?.details?.images || []).slice(0, 6).map((img) => ({
      url: img.url_or_base64 || img.url || img.href || '',
      source: img.source || '',
      notes: img.notes || '',
    })),
  };

  return [
    'Du bist ein strenger Quality Gate Inspector für ein eBay-fertiges Produktdatenblatt.',
    buildCommonPolicyText({ locale, allowWebEvidence: true }),
    '',
    'AUFGABE:',
    '- Prüfe das Datenblatt ganzheitlich auf Fehler, fehlende Pflichtinfos, falsche Bilder, unplausible Werte.',
    '- Prüfe Best-Match-Relevanz: Titel/Search-Intent, Vollständigkeit der Item Specifics, visuelle Qualität, Preisplausibilität.',
    '- Prüfe den Titel auf CTR-Relevanz in den ersten 3-5 Wörtern (Marke + Produkttyp + Kernmerkmal), ohne Keyword-Stuffing.',
    '- Prüfe die Beschreibung auf HTML-Struktur (<p>, <ul>, <li>, <strong>) und ausreichende Substanz statt 1-Satz-Text.',
    '- Markiere artikelfremde oder manipulative Keywords als Fehler (Search/Browse Manipulation).',
    '- Prüfe, ob die Kategorie plausibel zum Produkttyp passt (z.B. E‑Scooter darf nicht unter "Fahrzeuge > Automobile" landen).',
    '- Prüfe, ob Marke/Hersteller/Modell durch Web-Evidenz oder Barcode/Label belegbar ist; sonst WARN mit niedriger confidence.',
    '- Erkenne redundante Attribute (gleicher Inhalt in mehreren Keys) und widersprüchliche Angaben.',
    '- Prüfe, ob Pflicht-Item-Specifics vollständig und nicht leer sind; unvollständige Pflichtfelder mindestens als WARN, bei klaren Pflichtverletzungen als ERROR.',
    '- Prüfe Bildqualität für eBay-Hauptbild: Produkt vollständig erkennbar, neutraler Hintergrund, keine Overlays/Wasserzeichen/Badge-Texte.',
    '- Prüfe Plausibilität typischer Zahlenwerte (z.B. Gewicht, Maße, Spannung/Leistung) gegen Web-Evidenz.',
    '- Vergleiche ausschließlich mit der beigefügten WEB-EVIDENZ (URLs + Excerpts) und den beigefügten Bildern.',
    '- Wenn du etwas nicht sicher verifizieren kannst: issue mit severity="warn" und niedriger confidence, KEINE Behauptungen.',
    '',
    'HARD RULES:',
    '- Keine Halluzinationen. Nutze nur Daten aus SNAPSHOT, BILDERN oder WEB-EVIDENZ.',
    '- Barcodes nur akzeptieren, wenn sie plausibel zum Produkt passen (Brand/MPN/Modell im Beleg).',
    '',
    'RULE-BASED FINDINGS (vorab):',
    JSON.stringify(ruleIssues, null, 2),
    '',
    'WEB-EVIDENZ:',
    webEvidence ? JSON.stringify(webEvidence, null, 2) : 'keine',
    '',
    'SNAPSHOT:',
    JSON.stringify(snapshot, null, 2),
    '',
    'OUTPUT:',
    '- Antworte ausschließlich als JSON gemäß Schema { summary, issues[] }.',
    '- issues[].fields soll die betroffenen Pfade enthalten (z.B. "identification.name", "details.short_description", "details.images[0]").',
  ].join('\n');
}

async function runLlmQualityCheck({ product, webEvidence, ruleIssues, locale = 'de-DE' }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'QUALITY_GATE_MODEL', 'gemini-2.5-pro');
  const model = client.getGenerativeModel({ model: modelName });

  const promptText = buildLlmPrompt({ product, webEvidence, ruleIssues, locale });

  // Attach 1-2 reference images (non-generated preferred). This is best-effort.
  const imageUrls = (product?.details?.images || [])
    .map((img) => img?.url_or_base64 || img?.url || img?.href || '')
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    .slice(0, MAX_IMAGES);

  const parts = [{ text: promptText }];
  for (const url of imageUrls) {
    const raw = await fetchImageBase64(url);
    if (!raw?.base64) continue;
    const compressed = await compressImagePart(raw);
    parts.push({ inline_data: { mime_type: compressed.mimeType, data: compressed.base64 } });
  }

  // Phase F.1b — quality-gate uses moderate determinism (low temp, narrow sampling)
  // for consistent eBay-readiness scoring. Centralized via buildGenerationConfig.
  const generationConfig = buildGenerationConfig({
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    responseMimeType: 'application/json',
    responseSchema: cleanSchemaForGemini(QUALITY_GATE_SCHEMA),
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts }],
    generationConfig,
  });
  const text = result?.response?.text?.() || result?.response?.text?.() || result?.response?.text || '';
  const payload = JSON.parse(typeof text === 'string' ? text : String(text));
  return { payload, modelUsed: modelName };
}

async function persistQualityResult(productId, qualityResult) {
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  const payload = sanitizeValue({
    'ops.data_quality.quality_gate_v1': qualityResult,
    'ops.data_quality.last_quality_gate_iso': qualityResult?.checked_at_iso || new Date().toISOString(),
  });
  await docRef.update(payload);
}

async function runQualityGateForProduct(productId, { locale = 'de-DE', reason = 'auto', requestedBy = 'system', force = false } = {}) {
  const startedAt = Date.now();
  const product = await getProduct(productId);
  if (!product) {
    const error = new Error('Product not found');
    error.code = 404;
    throw error;
  }

  const existing = product?.ops?.data_quality?.quality_gate_v1;
  if (!force && existing?.checked_at_iso && existing?.revision_checked === product?.ops?.revision) {
    return { skipped: true, existing };
  }

  const webEvidence = await collectWebEvidence(product, { locale }).catch((e) => {
    console.warn('[quality-gate] web evidence failed:', e.message);
    return null;
  });

  const rule = buildRuleIssues(product, { webEvidence });

  let llm = null;
  if (USE_LLM) {
    try {
      llm = await runLlmQualityCheck({ product, webEvidence, ruleIssues: rule, locale });
    } catch (e) {
      llm = { error: e.message };
    }
  }

  const llmIssues = Array.isArray(llm?.payload?.issues) ? llm.payload.issues : [];
  const mergedIssues = []
    .concat(rule.issues || [])
    .concat(
      llmIssues.map((i) => ({
        ...i,
        source: 'llm',
      }))
    )
    .slice(0, 60);

  const ok = mergedIssues.filter((i) => i?.severity === 'error').length === 0;
  const checkedAtIso = new Date().toISOString();
  const qualityResult = {
    id: `qg_${crypto.randomUUID()}`,
    version: 1,
    checked_at_iso: checkedAtIso,
    duration_ms: Date.now() - startedAt,
    ok,
    summary:
      safeString(llm?.payload?.summary) ||
      (ok ? 'Keine kritischen Quality-Issues erkannt.' : 'Quality-Issues erkannt – bitte prüfen.'),
    issues: mergedIssues,
    evidence: webEvidence || null,
    modelUsed: llm?.modelUsed || null,
    reason,
    requestedBy,
    revision_checked: product?.ops?.revision || null,
  };

  await persistQualityResult(productId, qualityResult);
  return { ok, qualityResult };
}

module.exports = {
  runQualityGateForProduct,
};

