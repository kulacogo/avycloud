'use strict';

/**
 * Kaufland-Attribute-Enricher — pre-repair enrichment layer.
 *
 * Why this exists: `services/kaufland-product-data-repair.js` patches
 * Kaufland-product-data with whatever sits in `products_v2.details.*`. When
 * those fields are missing or in the wrong shape, the repair-call essentially
 * patches nothing useful and Kaufland keeps the listing in "Indexierung läuft"
 * (`product.is_valid=false`).
 *
 * This enricher runs BEFORE `tryRepairKauflandProductData` and fills the gaps
 * Kaufland complains about (from `getProductDataStatus.missing_attributes`):
 *   - GPSR (manufacturer_name/address/email/url) via web fallback
 *   - description via Gemini (~50-80 German words)
 *   - material composition via Gemini in Kaufland's "XX% Material" format
 *   - manufacturer derived from brand when only brand is set
 *   - content ("Inhalt", z.B. "300 g"/"5 l") deterministisch aus Titel/
 *     Attributen, Gemini-Flash nur als Fallback (regex-validiert)
 *   - weight ("Gewicht", "X g"/"X kg") aus logistics/details/Attributen,
 *     best-effort Web-Suche (lib/weight-web-lookup.js) als Fallback
 *   - hazmat (GHS/CLP: "Signalwort", "Gefahrenhinweise", "Sicherheitsinfo
 *     (P-Sätze)", "Sicherheitsdatenblatt") via verifiziertem Gemini-Lookup
 *     (lib/hazmat-gemini-lookup.js) — H-/P-Sätze NUR aus per PDF-Magic-Check
 *     verifiziertem SDS, Signalwort nur verifiziert bzw. belegtes
 *     'Kein Signalwort'; SDS-PDF wird nach GCS gespiegelt (lib/storage.js)
 *   - biozid ("Biozid", Pflicht-Kennzeichnung) aus demselben Lookup —
 *     NUR mit belegter Quelle
 *
 * The enriched product is returned to the caller AND persisted to
 * `products_v2` via `saveProductV2(... skipStockEvent:true)` so future syncs
 * benefit. Stock event is suppressed because this is an attribute-only update.
 *
 * Safety:
 *   - Per-field hard timeout (8s default)
 *   - Per-product total timeout (20s default)
 *   - Each field swallowed individually — one failure never kills the others
 *   - No-op when `missingAttributes` is empty
 *   - All errors swallowed at the top level so callers (sync cron) never crash
 */

const { lookupGpsrFromWeb } = require('../lib/gpsr-web-fallback');
const { callGeminiVision } = require('../lib/gemini-client');

const DEFAULT_FIELD_TIMEOUT_MS = 8000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

/**
 * GHS/CLP-Sub-Feld-Matcher für den 'hazmat'-Bucket. Nimmt einen bereits
 * normalizeToken()-ten Attribut-Namen und liefert das Sub-Feld — genutzt
 * sowohl für die Bucket-Klassifikation als auch für den "existiert schon
 * non-empty?"-Check (nie überschreiben).
 *
 * @param {string} token — normalizeToken()-Form
 * @returns {'signalwort'|'hSaetze'|'pSaetze'|'sds'|null}
 */
function classifyHazmatToken(token) {
  if (token === 'signalwort' || token === 'signalword') return 'signalwort';
  if (token === 'gefahrenhinweise' || token === 'hsätze' || token === 'hsaetze'
    || token === 'hazardstatements') return 'hSaetze';
  // Kaufland-Label "Sicherheitsinfo (P-Sätze)" → 'sicherheitsinfopsätze'.
  if (token.startsWith('sicherheitsinfo') || token === 'psätze' || token === 'psaetze'
    || token === 'precautionarystatements') return 'pSaetze';
  if (token === 'sicherheitsdatenblatt' || token === 'safetydatasheet') return 'sds';
  return null;
}

/**
 * Match a Kaufland missing-attribute name against one of our high-level
 * enrichment buckets ('gpsr' | 'description' | 'material' | 'manufacturer'
 * | 'picture' | 'content' | 'weight' | 'hazmat' | 'biozid').
 *
 * Kaufland's labels are German/locale-dependent ("Materialzusammensetzung",
 * "Produktbeschreibung", "Hersteller", "product_safety_contact" etc.). We
 * normalise + substring-match against known tokens.
 */
function classifyMissingAttribute(name) {
  const token = normalizeToken(name);
  if (!token) return null;
  if (token.includes('productsafetycontact')
    || token.includes('compliancecontact')
    || token.includes('verantwortlicheperson')
    || token.includes('responsibleperson')
    || token.includes('gpsr')
    || token.includes('herstellerkontakt')) return 'gpsr';
  if (token === 'manufacturer' || token === 'hersteller') return 'manufacturer';
  if (token.includes('beschreibung') || token.includes('description')) return 'description';
  if (token.includes('material') && (token.includes('zusammensetzung') || token === 'material' || token.includes('composition'))) return 'material';
  if (token.includes('bild') || token === 'picture' || token === 'pictures') return 'picture';
  // "Inhalt" = Kaufland content_volume (Typ Si_Litre, Format "5 l"/"500 ml"/"300 g").
  // Bewusst exakte Tokens — 'inhaltsstoffe' (Ingredients) darf NICHT matchen.
  if (token === 'inhalt' || token === 'contentvolume' || token === 'füllmenge' || token === 'fuellmenge') return 'content';
  // Exakt — 'maximalgewicht'/'traglast' etc. sind KEINE Produktgewichte.
  if (token === 'gewicht' || token === 'weight') return 'weight';
  // GHS/CLP-Gefahrstoff-Kennzeichnung (Live-Labels: "Signalwort",
  // "Gefahrenhinweise", "Sicherheitsinfo (P-Sätze)", "Sicherheitsdatenblatt").
  if (classifyHazmatToken(token)) return 'hazmat';
  // Regulatorische Pflicht-Kennzeichnung Biozid (TerraDomi-Fall).
  if (token === 'biozid' || token === 'biocide') return 'biozid';
  return null;
}

/**
 * Race a promise against a timeout. Resolves with `null` on timeout/error.
 */
async function withTimeout(promise, timeoutMs, label = 'op') {
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate a short German product description (~50-80 words) via Gemini Flash.
 * Plain text, no markdown. Returns null on failure.
 */
async function generateDescription({ title, brand, category }) {
  const prompt = [
    'Erstelle eine kurze deutsche Produktbeschreibung (~50-80 Wörter) für folgendes Produkt.',
    'Reiner Fließtext, keine Bullet Points, kein Markdown, keine Überschriften.',
    'Kein Werbe-Sprech ("revolutionär", "perfekt"), nur sachliche Beschreibung der Hauptmerkmale.',
    '',
    `Titel: ${safeString(title) || 'unbekannt'}`,
    `Marke: ${safeString(brand) || 'unbekannt'}`,
    `Kategorie: ${safeString(category) || 'unbekannt'}`,
    '',
    'Antworte NUR mit dem reinen Beschreibungstext, ohne Präfix oder Erläuterung.',
  ].join('\n');
  try {
    const text = await callGeminiVision(prompt, [], {
      model: 'gemini-2.5-flash',
      temperature: 0.6,
      maxOutputTokens: 2048, // Gemini-3 Thinking frisst knappe Budgets — Antwort truncated sonst (Live-Fall '40%')
    });
    const cleaned = safeString(text).replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!cleaned || cleaned.length < 30) return null;
    return cleaned.slice(0, 4000);
  } catch (err) {
    console.warn('[kaufland-enricher] description gen failed:', err?.message || err);
    return null;
  }
}

/**
 * Infer material composition in Kaufland's "XX% Material1, YY% Material2" format.
 * Returns a single string or null.
 */
async function generateMaterial({ title, brand, category }) {
  const prompt = [
    'Schätze die Materialzusammensetzung dieses Produkts.',
    `Titel: ${safeString(title) || 'unbekannt'}`,
    `Marke: ${safeString(brand) || 'unbekannt'}`,
    `Kategorie: ${safeString(category) || 'unbekannt'}`,
    '',
    'Antworte AUSSCHLIESSLICH in diesem exakten Format: "XX% Material1, YY% Material2"',
    'Beispiel: "98% Baumwolle, 2% Elasthan" oder "100% Polyester"',
    'Wenn du unsicher bist: "100% [Hauptmaterial]" (z.B. "100% Kunststoff").',
    'Keine Erläuterung, keine Anführungszeichen, nur die Materialangabe.',
  ].join('\n');
  try {
    const text = await callGeminiVision(prompt, [], {
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      maxOutputTokens: 2048, // s.o. — nie unter ~1024 bei Gemini-3
    });
    const cleaned = safeString(text).replace(/^["'`]+|["'`]+$/g, '').replace(/\n.*$/s, '').trim();
    // Sanity: must contain percent + actual material name (not just "100%")
    if (!cleaned || !/\d{1,3}\s*%\s*[A-Za-zÄÖÜäöüß]{3,}/.test(cleaned)) return null;
    return cleaned.slice(0, 250);
  } catch (err) {
    console.warn('[kaufland-enricher] material gen failed:', err?.message || err);
    return null;
  }
}

// ── Content ("Inhalt", Kaufland content_volume, Typ Si_Litre) ──────────────
// Kaufland-Format: Zahl, Leerzeichen, Einheit klein — "300 g", "5 l", "50 ml".
// Deterministische Extraktion aus Titel/Attributen ist first-tier (kein
// LLM-Call). Multipacks ("2x250 ml") liefern konservativ die EINZELgebinde-
// Menge (250 ml) — der Regex kann "2x" nie als Menge matchen, weil auf die
// Zahl direkt die Einheit folgen muss.
const CONTENT_QUANTITY_RX = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(milliliter|ml|liter|litre|l|kilogramm|kilogram|kg|gramm|gram|g)(?![a-zäöüß])/i;

// Attribut-Keys, deren Werte als Mengen-Quelle gelten (normalizeToken-Form).
const CONTENT_ATTR_TOKENS = new Set([
  'inhalt', 'füllmenge', 'fuellmenge', 'contentvolume', 'volumen',
  'menge', 'nettoinhalt', 'inhaltsmenge', 'nettofüllmenge', 'nettovolumen',
]);

function normalizeContentUnit(rawUnit) {
  const u = String(rawUnit || '').toLowerCase();
  if (u === 'ml' || u.startsWith('milli')) return 'ml';
  if (u === 'kg' || u.startsWith('kilo')) return 'kg';
  if (u === 'l' || u.startsWith('lit')) return 'l';
  return 'g';
}

/**
 * Extract a content/fill quantity from free text and normalise it to the
 * Kaufland format ("300 g", "5 l", "50 ml", "0,5 l"). Returns null when no
 * plausible quantity is found. Decimal separator is normalised to comma (DE).
 */
function extractContentFromText(text) {
  const m = CONTENT_QUANTITY_RX.exec(safeString(text));
  if (!m) return null;
  const num = m[1].replace('.', ',');
  return `${num} ${normalizeContentUnit(m[2])}`;
}

/**
 * Gemini-Flash fallback when no quantity is extractable deterministically.
 * Answer is validated through the same regex — anything non-conforming → null.
 */
async function generateContent({ title, brand, category }) {
  const prompt = [
    'Ermittle die Füllmenge / den Inhalt (Nettomenge) dieses Produkts.',
    `Titel: ${safeString(title) || 'unbekannt'}`,
    `Marke: ${safeString(brand) || 'unbekannt'}`,
    `Kategorie: ${safeString(category) || 'unbekannt'}`,
    '',
    'Antworte AUSSCHLIESSLICH mit der Mengenangabe: Zahl, Leerzeichen, Einheit (ml, l, g oder kg).',
    'Beispiele: "500 ml", "5 l", "300 g", "1 kg"',
    'Wenn die Menge nicht sicher bestimmbar ist, antworte NUR mit: unbekannt',
    'Keine Erläuterung, keine Anführungszeichen.',
  ].join('\n');
  try {
    const text = await callGeminiVision(prompt, [], {
      model: 'gemini-2.5-flash',
      temperature: 0.1,
      maxOutputTokens: 2048, // s.o. — nie unter ~1024 bei Gemini-3
    });
    const cleaned = safeString(text).replace(/^["'`]+|["'`]+$/g, '').replace(/\n.*$/s, '').trim();
    if (!cleaned || /unbekannt/i.test(cleaned)) return null;
    // Regex-Validierung + Normalisierung — alles andere wird verworfen.
    return extractContentFromText(cleaned);
  } catch (err) {
    console.warn('[kaufland-enricher] content gen failed:', err?.message || err);
    return null;
  }
}

// ── Weight ("Gewicht") ──────────────────────────────────────────────────────
// Plausibilitätsfenster gespiegelt zu lib/weight-web-lookup.js (1 g – 50 kg).
const MIN_WEIGHT_G = 1;
const MAX_WEIGHT_G = 50000;
const WEIGHT_VALUE_RX = /(\d+(?:[.,]\d+)?)\s*(kilogramm|kilogram|kilos?|kg|gramm|grams?|gram|g)\b/i;

/**
 * Parse a weight value from products_v2 fields into grams.
 * Convention: bare numbers are KG (details.weight / "Gewicht (kg)" store
 * numeric kg — see lib/apply-chat-changes.js + lib/firestore.js). Strings may
 * carry a unit ("500 g", "1,5 kg"). Returns null when unparseable or
 * implausible (outside 1 g – 50 kg).
 */
function parseWeightToGramsLoose(value) {
  let grams = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    grams = Math.round(value * 1000); // numerisch == kg (Repo-Konvention)
  } else {
    const text = safeString(value);
    if (!text) return null;
    const m = WEIGHT_VALUE_RX.exec(text);
    if (m) {
      const num = Number(m[1].replace(',', '.'));
      if (!Number.isFinite(num) || num <= 0) return null;
      grams = /^k/i.test(m[2]) ? Math.round(num * 1000) : Math.round(num);
    } else {
      const bare = Number(text.replace(',', '.'));
      if (Number.isFinite(bare) && bare > 0) grams = Math.round(bare * 1000); // bare == kg
    }
  }
  if (grams == null || grams < MIN_WEIGHT_G || grams > MAX_WEIGHT_G) return null;
  return grams;
}

/**
 * Format grams into Kaufland attribute form: "X g" below 1 kg, "X kg" above
 * (decimal comma, max 2 Nachkommastellen).
 */
function formatWeightForKaufland(grams) {
  if (!Number.isFinite(grams) || grams <= 0) return null;
  if (grams >= 1000) {
    const kg = Math.round((grams / 1000) * 100) / 100;
    return `${String(kg).replace('.', ',')} kg`;
  }
  return `${Math.round(grams)} g`;
}

// Fresh clone of details.attributes — used at WRITE time inside async tasks so
// parallel bucket-writes (material/content/weight) never clobber each other.
function cloneAttrs(details) {
  const attrs = details?.attributes;
  return { ...(attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? attrs : {}) };
}

// ── Hazmat/Biozid ("Signalwort", "Gefahrenhinweise", "Sicherheitsinfo
// (P-Sätze)", "Sicherheitsdatenblatt", "Biozid") ────────────────────────────
// Gemini-Lookup (20s) + SDS-PDF-Verifikation (15s) brauchen zusammen mehr als
// das 8s-Feld-Default. Der Lookup cached in Firestore (30d TTL, inkl. negativ)
// — wenn der ERSTE Lauf ins Total-Timeout läuft, füllt der Cache den nächsten
// Sync-Lauf (15-min-Intervall) instant. Kein Call-Site-Umbau nötig.
const HAZMAT_LOOKUP_TIMEOUT_MS = 20000;

function attrValueNonEmpty(v) {
  if (Array.isArray(v)) return v.some((x) => !!safeString(x));
  return !!safeString(v);
}

/**
 * True wenn irgendein bestehendes Attribut, dessen normalisierter Key das
 * Prädikat erfüllt, einen non-empty Wert hat. Guard gegen Überschreiben —
 * bestehende non-empty Werte werden NIE angefasst.
 */
function hasNonEmptyAttrToken(attrs, predicate) {
  return Object.entries(attrs || {}).some(([k, v]) => predicate(normalizeToken(k)) && attrValueNonEmpty(v));
}

/**
 * Merge GPSR web-lookup result into product.details.gpsr without overwriting
 * existing non-empty values. Returns a NEW gpsr object (does not mutate input).
 */
function mergeGpsr(existingGpsr, webResult) {
  const out = { ...(existingGpsr && typeof existingGpsr === 'object' ? existingGpsr : {}) };
  if (!webResult) return out;
  // Web result returns a single combined address — only fill if existing
  // manufacturer_address is empty (preserve any structured data we already have).
  if (!safeString(out.manufacturer_name) && safeString(webResult.manufacturer_name)) {
    out.manufacturer_name = webResult.manufacturer_name;
  }
  if (!safeString(out.manufacturer_address) && safeString(webResult.manufacturer_address)) {
    out.manufacturer_address = webResult.manufacturer_address;
  }
  if (!safeString(out.email) && safeString(webResult.manufacturer_email)) {
    out.email = webResult.manufacturer_email;
  }
  if (!safeString(out.url) && safeString(webResult.manufacturer_url)) {
    out.url = webResult.manufacturer_url;
  }
  return out;
}

/**
 * Enrich a `products_v2` document with the fields Kaufland says are missing.
 *
 * @param {object} product - products_v2 doc (must have .details, .identification)
 * @param {string[]} missingAttributes - Kauflands missing_attributes list
 * @param {object} [opts]
 * @param {number} [opts.fieldTimeoutMs=8000]
 * @param {number} [opts.totalTimeoutMs=20000]
 * @param {Array<{attribute: string, message: string}>} [opts.declined=[]]
 *   Kauflands DECLINED attribute_values (state==='DECLINED') als Hints —
 *   z.B. material_composition mit invalid_text_format erzwingt das
 *   %-Re-Format, auch wenn lokal bereits ein Wert existiert.
 * @returns {Promise<{ enriched: object, enrichedFields: string[], errors: string[] }>}
 *   `enriched` is always a NEW object (shallow-cloned). `enrichedFields` is the
 *   list of high-level bucket names that were actually populated this run.
 */
async function enrichProductForKaufland(product, missingAttributes = [], opts = {}) {
  const fieldTimeoutMs = Number.isFinite(opts.fieldTimeoutMs) ? opts.fieldTimeoutMs : DEFAULT_FIELD_TIMEOUT_MS;
  const totalTimeoutMs = Number.isFinite(opts.totalTimeoutMs) ? opts.totalTimeoutMs : DEFAULT_TOTAL_TIMEOUT_MS;

  const enrichedFields = [];
  const errors = [];

  // Shallow clone — we'll mutate details / details.gpsr below.
  const enriched = { ...(product || {}) };
  enriched.details = { ...(product?.details || {}) };
  enriched.identification = { ...(product?.identification || {}) };

  const list = Array.isArray(missingAttributes) ? missingAttributes : [];
  const declinedList = (Array.isArray(opts.declined) ? opts.declined : [])
    .filter((d) => d && (safeString(d.attribute) || safeString(d.message)));
  if (!list.length && !declinedList.length) {
    return { enriched, enrichedFields, errors };
  }

  // Classify missing fields into buckets. De-dupe per bucket. DECLINED
  // attributes (present but rejected by Kauflands validator) zählen ebenfalls
  // — sie stehen NICHT in missing_attributes, brauchen aber genauso Repair.
  const buckets = new Set();
  for (const name of list) {
    const bucket = classifyMissingAttribute(name);
    if (bucket) buckets.add(bucket);
  }
  for (const d of declinedList) {
    const bucket = classifyMissingAttribute(d.attribute);
    if (bucket) buckets.add(bucket);
  }
  if (!buckets.size) {
    return { enriched, enrichedFields, errors };
  }

  const title = safeString(enriched.identification?.name);
  const brand = safeString(enriched.identification?.brand
    || enriched.details?.identifiers?.brand);
  const category = safeString(enriched.identification?.category
    || enriched.details?.category?.path);

  // ── Bucket: manufacturer (cheap, no IO) ────────────────────────────────
  // If Kaufland complains about missing manufacturer but we have a brand,
  // mirror brand → details.attributes.manufacturer / Hersteller (existing
  // repair logic reads brand directly so this is mostly for parity with
  // attributes that survive a different code path).
  if (buckets.has('manufacturer') && brand) {
    const attrs = { ...(enriched.details.attributes && typeof enriched.details.attributes === 'object' && !Array.isArray(enriched.details.attributes) ? enriched.details.attributes : {}) };
    const hasManufacturer = Object.keys(attrs).some((k) => {
      const token = normalizeToken(k);
      return token === 'manufacturer' || token === 'hersteller';
    });
    if (!hasManufacturer) {
      attrs.Hersteller = brand;
      enriched.details.attributes = attrs;
      enrichedFields.push('manufacturer');
    }
  }

  // Build per-bucket tasks (parallel) but wrap in total-timeout.
  const tasks = [];

  if (buckets.has('gpsr')) {
    const gpsrExisting = enriched.details.gpsr && typeof enriched.details.gpsr === 'object' ? enriched.details.gpsr : {};

    // ── 1st-Tier: Brand-Lookup in unserer eigenen DB ────────────────────────
    // Wenn der Aufrufer einen brandGpsrMap mitliefert (vorbereitet im
    // sync-phase aus allen products_v2), nutze Geschwister-Produkte derselben
    // Brand als Datenquelle. Beispiel: Anker-Charger ohne GPSR — wir haben
    // GPSR auf einem anderen Anker-Produkt → kopieren statt scrapen.
    //
    // Brand-Quelle hat dieselbe Shape wie products_v2 GPSR (email, url,
    // manufacturer_address, manufacturer_city etc. — NICHT die web-fallback
    // shape mit "manufacturer_email"). Daher inline-Merge mit existing-wins.
    // BELEG-GATE (AUDIT 2026-07-16): brandGpsrMap war ein Halluzinations-
    // Amplifikator — EIN falscher GPSR-Eintrag wurde stumm auf alle Geschwister-
    // Produkte derselben Brand kopiert. Kopiert wird nur noch wenn:
    //   (a) die Quelle einen verified-Beleg traegt (details.gpsr.evidence), ODER
    //   (b) das Ziel-Produkt GAR keine echte manufacturer_name hat (leer oder
    //       blosses Brand-Echo "manufacturer_name === brand" — das Artefakt des
    //       alten Erfindungs-Fallbacks) — dann wird die Kopie EXPLIZIT als
    //       unverified markiert (evidence={status:'inherited_unverified',fromSku}).
    // Nie stumm verified-los kopieren.
    if (brand && opts.brandGpsrMap && typeof opts.brandGpsrMap.get === 'function') {
      const fromBrand = opts.brandGpsrMap.get(brand.toLowerCase());
      if (fromBrand && fromBrand.gpsr) {
        const sourceEvidence = (fromBrand.gpsr.evidence && typeof fromBrand.gpsr.evidence === 'object')
          ? fromBrand.gpsr.evidence
          : ((fromBrand.evidence && typeof fromBrand.evidence === 'object') ? fromBrand.evidence : null);
        const sourceVerified = !!sourceEvidence && safeString(sourceEvidence.status) === 'verified';
        const existingName = safeString(gpsrExisting.manufacturer_name);
        const targetHasRealName = !!existingName
          && existingName.toLowerCase() !== brand.toLowerCase();
        if (!sourceVerified && targetHasRealName) {
          errors.push(`gpsr-brand: Quelle ${safeString(fromBrand.fromSku) || 'unbekannt'} ohne verified-Beleg — Kopie auf Produkt mit eigener manufacturer_name blockiert`);
        } else {
          const merged = {};
          // Brand-Quelle als Defaults (deren evidence NIE roh mitkopieren)
          for (const [k, v] of Object.entries(fromBrand.gpsr)) {
            if (k === 'evidence') continue;
            const sv = typeof v === 'string' ? v.trim() : v;
            if (sv !== '' && sv != null) merged[k] = sv;
          }
          // Existing gewinnt wo non-empty (nicht überschreiben)
          for (const [k, v] of Object.entries(gpsrExisting)) {
            const sv = typeof v === 'string' ? v.trim() : v;
            if (sv !== '' && sv != null) merged[k] = sv;
          }
          const existingKeys = Object.keys(gpsrExisting).filter((k) => {
            if (k === 'evidence') return false;
            const v = gpsrExisting[k];
            return typeof v === 'string' ? v.trim() : v != null;
          });
          const mergedFieldKeys = Object.keys(merged).filter((k) => k !== 'evidence');
          const changed = mergedFieldKeys.length > existingKeys.length;
          if (changed) {
            merged.evidence = sourceVerified
              ? {
                status: 'inherited_verified',
                fromSku: safeString(fromBrand.fromSku) || null,
                url: safeString(sourceEvidence.url) || null,
                checked_at: safeString(sourceEvidence.checked_at) || null,
              }
              : {
                status: 'inherited_unverified',
                fromSku: safeString(fromBrand.fromSku) || null,
              };
            enriched.details.gpsr = merged;
            enrichedFields.push('gpsr-brand');
          }
        }
      }
    }

    // ── 1.5-Tier: Gemini-Lookup mit googleSearch (orphan brands) ───────────
    // Wenn brand-map nichts hatte, versuche Gemini-3-Flash mit googleSearch
    // BEVOR wir das regex-basierte Web-Fallback antasten. Gemini findet das
    // EU-verantwortliche Impressum bei Marken wie GANT, Desigual, TOMMY JEANS
    // wo wir keine Sibling-Produkte haben. Cache in Firestore (30d TTL) damit
    // wir denselben Brand nicht 100x pro Sync abfragen.
    //
    // Output-Shape ist identisch mit unserer products_v2-GPSR-Shape
    // (email, url, manufacturer_address, manufacturer_city, …), also Inline-
    // Merge mit existing-wins — kein mergeGpsr(), das ist für die web-fallback
    // shape mit "manufacturer_email"/"manufacturer_url".
    let gpsrAfterBrand = enriched.details.gpsr || {};
    let stillIncomplete = !safeString(gpsrAfterBrand.manufacturer_name)
      || !safeString(gpsrAfterBrand.manufacturer_address);

    if (brand && stillIncomplete && opts.useGeminiLookup !== false) {
      try {
        const { getOrFetchBrandGpsr } = require('../lib/gpsr-gemini-lookup');
        const geminiResult = await withTimeout(
          getOrFetchBrandGpsr(brand),
          15000,
          'gemini-gpsr'
        );
        if (geminiResult && geminiResult.gpsr
            && (geminiResult.gpsr.manufacturer_name || geminiResult.gpsr.manufacturer_address)) {
          // BELEG-GATE (AUDIT 2026-07-16): Gemini-GPSR wird NUR uebernommen,
          // wenn der Lookup einen verified/partial-Beleg traegt. Ergebnisse
          // OHNE evidence-Feld stammen entweder aus dem Alt-Cache (30d,
          // unverifiziert geschrieben — genau die Halluzinations-Quelle des
          // Audits → ablehnen, cached:true) oder aus einem Lauf mit explizit
          // abgeschalteter Verifikation (Kill-Switch GPSR_LOOKUP_VERIFY=false
          // bzw. injizierte Test-Mocks → altes Verhalten, cached:false).
          const geminiEvidence = geminiResult.evidence && typeof geminiResult.evidence === 'object'
            ? geminiResult.evidence
            : null;
          const geminiEvidenceStatus = geminiEvidence ? safeString(geminiEvidence.status) : '';
          const geminiAccepted = geminiEvidence
            ? (geminiEvidenceStatus === 'verified' || geminiEvidenceStatus === 'partial')
            : (geminiResult.cached !== true && geminiResult.unverified !== true);
          if (!geminiAccepted) {
            errors.push(`gpsr-gemini: Beleg-Status '${geminiEvidenceStatus || 'fehlt'}' — Datensatz nicht übernommen (unverifiziert)`);
          } else {
            const merged = {};
            // Gemini-Quelle als Defaults
            for (const [k, v] of Object.entries(geminiResult.gpsr)) {
              if (k === 'evidence') continue;
              const sv = typeof v === 'string' ? v.trim() : v;
              if (sv !== '' && sv != null) merged[k] = sv;
            }
            // Existing gewinnt wo non-empty (nicht überschreiben)
            for (const [k, v] of Object.entries(gpsrAfterBrand)) {
              const sv = typeof v === 'string' ? v.trim() : v;
              if (sv !== '' && sv != null) merged[k] = sv;
            }
            const existingKeys = Object.keys(gpsrAfterBrand).filter((k) => {
              if (k === 'evidence') return false;
              const v = gpsrAfterBrand[k];
              return typeof v === 'string' ? v.trim() !== '' : v != null;
            });
            const mergedFieldKeys = Object.keys(merged).filter((k) => k !== 'evidence');
            if (mergedFieldKeys.length > existingKeys.length) {
              // Beleg-Metadaten mitschreiben (nur wenn das Ziel noch keine trug).
              if (geminiEvidence && !merged.evidence) {
                merged.evidence = {
                  status: geminiEvidenceStatus,
                  url: safeString(geminiEvidence.url) || null,
                  checked_at: safeString(geminiEvidence.checked_at) || null,
                  method: safeString(geminiEvidence.method) || null,
                  source: 'gemini-lookup',
                };
              }
              enriched.details.gpsr = merged;
              enrichedFields.push('gpsr-gemini');
            }
          }
        }
      } catch (_) { /* swallow — fall through to web-fallback */ }
    }

    // Re-check whether GPSR is still incomplete after Gemini-lookup
    gpsrAfterBrand = enriched.details.gpsr || {};
    stillIncomplete = !safeString(gpsrAfterBrand.manufacturer_name)
      || !safeString(gpsrAfterBrand.manufacturer_address);

    // ── 2nd-Tier: Web-Fallback (falls Brand-Map + Gemini nichts brachte) ────
    if (brand && stillIncomplete) {
      tasks.push((async () => {
        try {
          const webResult = await withTimeout(
            lookupGpsrFromWeb(brand, { timeout: fieldTimeoutMs }),
            fieldTimeoutMs + 500,
            'gpsr-web'
          );
          if (webResult && (webResult.manufacturer_name || webResult.manufacturer_address || webResult.manufacturer_email)) {
            const merged = mergeGpsr(gpsrExisting, webResult);
            // Only count as enriched if SOMETHING was added vs the original.
            const changed = Object.keys(merged).some((k) => merged[k] && merged[k] !== gpsrExisting[k]);
            if (changed) {
              enriched.details.gpsr = merged;
              enrichedFields.push('gpsr');
            }
          }
        } catch (err) {
          errors.push(`gpsr: ${err?.message || err}`);
        }
      })());
    }
  }

  if (buckets.has('description')) {
    const descCurrent = safeString(enriched.details.description) || safeString(enriched.details.short_description);
    // Kaufland complained → regenerate if missing OR too short (<50 chars).
    // Kaufland validator probably wants substantial product info.
    if ((!descCurrent || descCurrent.length < 50) && title) {
      tasks.push((async () => {
        try {
          const desc = await withTimeout(
            generateDescription({ title, brand, category }),
            fieldTimeoutMs,
            'description-gemini'
          );
          if (desc) {
            enriched.details.description = desc;
            enrichedFields.push('description');
          }
        } catch (err) {
          errors.push(`description: ${err?.message || err}`);
        }
      })());
    }
  }

  if (buckets.has('material')) {
    const attrsForMaterial = enriched.details.attributes && typeof enriched.details.attributes === 'object' && !Array.isArray(enriched.details.attributes)
      ? enriched.details.attributes
      : {};
    // Kaufland complained → check our existing material value for QUALITY,
    // not mere presence. Kaufland validator rejects free-text without
    // percentage (e.g., "Baumwollmischung mit Stretch") even if stored.
    // Re-format whenever the existing value doesn't match `XX% Y` pattern.
    let existingMaterialValue = '';
    for (const [k, v] of Object.entries(attrsForMaterial)) {
      const token = normalizeToken(k);
      if (token.includes('material') && (token.includes('zusammensetzung') || token === 'material' || token.includes('composition'))) {
        const candidate = Array.isArray(v) ? safeString(v[0]) : safeString(v);
        if (candidate) { existingMaterialValue = candidate; break; }
      }
    }
    // Kaufland-Format: "98% Baumwolle, 2% Elasthan" — Prozent UND Materialname.
    // Vorheriger Regex matched "100%" alleine (kein Material). Verschärft:
    // Prozent (1-3 Digits) + optionales Leerzeichen + mindestens 3-Buchstaben-
    // Material-Token. Schmeißt "100%" und "%" zurück → Gemini regeneriert.
    const VALID_MATERIAL_RX = /\d{1,3}\s*%\s*[A-Za-zÄÖÜäöüß]{3,}/;
    const hasValidMaterialFormat = existingMaterialValue && VALID_MATERIAL_RX.test(existingMaterialValue);
    // Kaufland hat material_composition explizit DECLINED (z.B. hint:
    // material_composition_must_contain_%, reason: invalid_text_format) →
    // Re-Format ERZWINGEN, egal was lokal steht. Der lokale Wert ist bewiesen
    // nicht akzeptiert.
    const materialDeclined = declinedList.some((d) => classifyMissingAttribute(d.attribute) === 'material');
    if ((!hasValidMaterialFormat || materialDeclined) && title) {
      tasks.push((async () => {
        try {
          const material = await withTimeout(
            generateMaterial({ title, brand, category }),
            fieldTimeoutMs,
            'material-gemini'
          );
          if (material) {
            const attrs = cloneAttrs(enriched.details);
            attrs.Materialzusammensetzung = material;
            enriched.details.attributes = attrs;
            enrichedFields.push('material');
          }
        } catch (err) {
          errors.push(`material: ${err?.message || err}`);
        }
      })());
    }
  }

  // ── Bucket: content ("Inhalt" / content_volume, Format "300 g"/"5 l") ────
  // 1st-tier: deterministisch aus Attribut-Werten (Inhalt/Füllmenge/Volumen…)
  // und Titel — kein LLM-Call. 2nd-tier: Gemini-Flash, Antwort regex-validiert.
  if (buckets.has('content')) {
    const attrsForContent = cloneAttrs(enriched.details);
    let contentValue = null;
    for (const [k, v] of Object.entries(attrsForContent)) {
      const token = normalizeToken(k);
      if (!CONTENT_ATTR_TOKENS.has(token)) continue;
      const candidate = Array.isArray(v) ? safeString(v[0]) : safeString(v);
      const extracted = extractContentFromText(candidate);
      if (extracted) { contentValue = extracted; break; }
    }
    if (!contentValue && title) {
      contentValue = extractContentFromText(title);
    }
    if (contentValue) {
      const attrs = cloneAttrs(enriched.details);
      attrs.Inhalt = contentValue;
      enriched.details.attributes = attrs;
      enrichedFields.push('content');
    } else if (title) {
      tasks.push((async () => {
        try {
          const generated = await withTimeout(
            generateContent({ title, brand, category }),
            fieldTimeoutMs,
            'content-gemini'
          );
          if (generated) {
            const attrs = cloneAttrs(enriched.details);
            attrs.Inhalt = generated;
            enriched.details.attributes = attrs;
            enrichedFields.push('content');
          }
        } catch (err) {
          errors.push(`content: ${err?.message || err}`);
        }
      })());
    }
  }

  // ── Bucket: weight ("Gewicht", Format "X g"/"X kg") ──────────────────────
  // Quellen-Kaskade: (a) details.logistics.weight / details.weight /
  // Gewichts-Attribute (numerisch == kg, Repo-Konvention) → (b) best-effort
  // Web-Suche (lib/weight-web-lookup.js) → (c) nichts.
  if (buckets.has('weight')) {
    let weightGrams = parseWeightToGramsLoose(enriched.details?.logistics?.weight);
    if (weightGrams == null) weightGrams = parseWeightToGramsLoose(enriched.details?.weight);
    if (weightGrams == null) {
      const attrsForWeight = cloneAttrs(enriched.details);
      for (const [k, v] of Object.entries(attrsForWeight)) {
        const token = normalizeToken(k);
        if (token !== 'gewicht' && token !== 'weight' && token !== 'gewichtkg') continue;
        const candidate = Array.isArray(v) ? v[0] : v;
        const parsed = parseWeightToGramsLoose(candidate);
        if (parsed != null) { weightGrams = parsed; break; }
      }
    }
    if (weightGrams != null) {
      const attrs = cloneAttrs(enriched.details);
      attrs.Gewicht = formatWeightForKaufland(weightGrams);
      enriched.details.attributes = attrs;
      enrichedFields.push('weight');
    } else if (title || brand) {
      tasks.push((async () => {
        try {
          // Lazy require (Muster gpsr-gemini-lookup) — Modul zieht intern
          // services/toolkit.js erst beim Search-Call nach.
          const { lookupWeightFromWeb } = require('../lib/weight-web-lookup');
          const ean = safeString(enriched.details?.identifiers?.ean || enriched.identification?.ean);
          const res = await withTimeout(
            lookupWeightFromWeb({ brand, model: title, ean }, { timeout: fieldTimeoutMs }),
            fieldTimeoutMs + 500,
            'weight-web'
          );
          const grams = Number(res?.weight_grams);
          if (Number.isFinite(grams) && grams >= MIN_WEIGHT_G && grams <= MAX_WEIGHT_G
              && Number(res?.confidence) >= 0.6) {
            const attrs = cloneAttrs(enriched.details);
            attrs.Gewicht = formatWeightForKaufland(grams);
            enriched.details.attributes = attrs;
            enrichedFields.push('weight');
          }
        } catch (err) {
          errors.push(`weight: ${err?.message || err}`);
        }
      })());
    }
  }

  // ── Bucket: hazmat + biozid (GHS/CLP via verifiziertem Gemini-Lookup) ─────
  // Beide Buckets teilen sich EINEN getOrFetchHazmat-Call (Kostenkontrolle);
  // biozid erweitert den Prompt via requestedFields=['biozid'].
  //
  // STRENGE COMPLIANCE-GUARDS (falsche Gefahrstoff-Angaben sind schlimmer als
  // fehlende — dann bleibt der Cockpit-Fehler sichtbar, Operator übernimmt):
  //   - H-/P-Sätze NUR wenn result.verified (SDS-PDF per Magic-Bytes geprüft)
  //   - Signalwort wenn verified ODER belegtes 'Kein Signalwort'
  //     (confidence >= 0.8 UND sources non-empty) — ein falsches
  //     "Kein Signalwort" bei einem Gefahrstoff wäre fatal
  //   - Sicherheitsdatenblatt: verifiedSdsUrl nach GCS spiegeln
  //     (uploadDocumentBuffer), Mirror-Fehler → Original-URL (besser als nichts)
  //   - Biozid NUR mit belegter Quelle (regulatory.sources)
  //   - Bestehende non-empty Werte werden NIE überschrieben
  if (buckets.has('hazmat') || buckets.has('biozid')) {
    const attrsNow = cloneAttrs(enriched.details);
    const hasSignalwort = hasNonEmptyAttrToken(attrsNow, (t) => classifyHazmatToken(t) === 'signalwort');
    const hasHSaetze = hasNonEmptyAttrToken(attrsNow, (t) => classifyHazmatToken(t) === 'hSaetze');
    const hasPSaetze = hasNonEmptyAttrToken(attrsNow, (t) => classifyHazmatToken(t) === 'pSaetze');
    const hasSds = hasNonEmptyAttrToken(attrsNow, (t) => classifyHazmatToken(t) === 'sds');
    const hasBiozid = hasNonEmptyAttrToken(attrsNow, (t) => t === 'biozid' || t === 'biocide');

    // Kostenkontrolle: Lookup läuft NUR wenn mindestens ein Ziel-Attribut
    // wirklich leer ist. Alles lokal vorhanden → Repair submitted Bestand,
    // kein Gemini-/Fetch-Call.
    const needHazmat = buckets.has('hazmat') && (!hasSignalwort || !hasHSaetze || !hasPSaetze || !hasSds);
    const needBiozid = buckets.has('biozid') && !hasBiozid;

    if (needHazmat || needBiozid) {
      tasks.push((async () => {
        try {
          // Lazy require (Muster gpsr-gemini-lookup) — Modul zieht Firestore-
          // Client + gemini3-client erst beim ersten echten Call hoch.
          const hazmatLookup = require('../lib/hazmat-gemini-lookup');
          const ean = safeString(enriched.details?.identifiers?.ean || enriched.identification?.ean);
          const result = await withTimeout(
            hazmatLookup.getOrFetchHazmat({
              ean,
              brand,
              title,
              requestedFields: needBiozid ? ['biozid'] : [],
            }),
            Math.max(fieldTimeoutMs, HAZMAT_LOOKUP_TIMEOUT_MS),
            'hazmat-gemini'
          );

          if (!result) {
            // Transient (lookup → null, wird bewusst NICHT gecacht) —
            // nächster Sync-Lauf versucht es erneut.
            if (needHazmat) errors.push('hazmat: Lookup lieferte kein Ergebnis (transient) — keine Attribute geschrieben');
            if (needBiozid) errors.push('biozid: Lookup lieferte kein Ergebnis (transient) — Attribut nicht geschrieben');
            return;
          }

          const verified = result.verified === true;
          const signalwortAllowed = !!result.signalwort && (verified
            || (result.signalwort === 'Kein Signalwort'
              && Number(result.confidence) >= 0.8
              && Array.isArray(result.sources) && result.sources.length > 0));

          // SDS: verifizierte URL nach GCS spiegeln. getOrFetchHazmat reicht
          // den PDF-Buffer nie durch (Firestore-Cache, 1-MB-Doc-Limit) —
          // daher hier erneut laden (verifySdsUrl liefert den Buffer mit).
          let sdsUrlToWrite = null;
          if (needHazmat && !hasSds && verified && result.verifiedSdsUrl) {
            sdsUrlToWrite = result.verifiedSdsUrl;
            try {
              const fetched = await hazmatLookup.verifySdsUrl(result.verifiedSdsUrl);
              if (fetched && fetched.ok && fetched.buffer) {
                const { uploadDocumentBuffer } = require('../lib/storage');
                const productId = safeString(enriched.id || product?.id);
                const uploaded = await uploadDocumentBuffer(
                  fetched.buffer,
                  fetched.contentType || 'application/pdf',
                  productId,
                  'sicherheitsdatenblatt'
                );
                if (uploaded && uploaded.url) sdsUrlToWrite = uploaded.url;
              }
            } catch (err) {
              // Mirror-Fehler → verifizierte Original-URL bleibt (besser als nichts).
              console.warn('[kaufland-enricher] SDS-GCS-Mirror fehlgeschlagen:', err?.message || err);
            }
          }

          if (needHazmat) {
            const attrs = cloneAttrs(enriched.details);
            let wrote = false;
            if (!hasSignalwort && signalwortAllowed) {
              attrs.Signalwort = result.signalwort;
              wrote = true;
            }
            if (verified) {
              if (!hasHSaetze && Array.isArray(result.hSaetze) && result.hSaetze.length) {
                attrs.Gefahrenhinweise = result.hSaetze;
                wrote = true;
              }
              if (!hasPSaetze && Array.isArray(result.pSaetze) && result.pSaetze.length) {
                attrs['Sicherheitsinfo (P-Sätze)'] = result.pSaetze;
                wrote = true;
              }
            }
            if (sdsUrlToWrite) {
              attrs.Sicherheitsdatenblatt = sdsUrlToWrite;
              wrote = true;
            }
            if (wrote) {
              enriched.details.attributes = attrs;
              enrichedFields.push('hazmat');
            } else {
              errors.push('hazmat: kein verifiziertes Sicherheitsdatenblatt/Signalwort gefunden — Gefahrstoff-Attribute bewusst NICHT geschrieben (Operator-Prüfung nötig)');
            }
          }

          if (needBiozid) {
            const biozidValue = result.regulatory ? safeString(result.regulatory.biozid) : '';
            const biozidSources = result.regulatory && Array.isArray(result.regulatory.sources)
              ? result.regulatory.sources
              : [];
            if (biozidValue && biozidSources.length > 0) {
              const attrs = cloneAttrs(enriched.details);
              attrs.Biozid = biozidValue;
              enriched.details.attributes = attrs;
              enrichedFields.push('biozid');
            } else {
              errors.push('biozid: keine belegte Biozid-Kennzeichnung gefunden — Attribut bewusst NICHT geschrieben (Operator-Prüfung nötig)');
            }
          }
        } catch (err) {
          errors.push(`hazmat: ${err?.message || err}`);
        }
      })());
    }
  }

  // ── Bucket: picture (cannot enrich without source images — skip silently) ─
  // We log so operator can see Kaufland wants pictures but we have none.
  if (buckets.has('picture')) {
    const images = Array.isArray(enriched.details.images) ? enriched.details.images : [];
    if (!images.length) {
      errors.push('picture: no images available in products_v2 — manual fix required');
    }
  }

  if (!tasks.length) {
    return { enriched, enrichedFields, errors };
  }

  // Race ALL parallel tasks against the total timeout. Individual tasks have
  // their own per-field timeouts; this is the upper bound for the whole call.
  try {
    await withTimeout(Promise.allSettled(tasks), totalTimeoutMs, 'enrichment-total');
  } catch (err) {
    errors.push(`total: ${err?.message || err}`);
  }

  return { enriched, enrichedFields, errors };
}

module.exports = {
  enrichProductForKaufland,
  // exported for unit tests
  classifyMissingAttribute,
  classifyHazmatToken,
  mergeGpsr,
  extractContentFromText,
  parseWeightToGramsLoose,
  formatWeightForKaufland,
};
