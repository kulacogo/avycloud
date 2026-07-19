'use strict';

/**
 * weight-derive.js — PURE Helpers zur Ableitung eines realistischen
 * VERSANDGEWICHTS (kg) aus vorhandenen Produktdaten. Kein I/O, kein Firestore.
 *
 * Kontext (Gewichts-Backfill 2026-07-19): 262 von 770 Bestand≥1-Produkten
 * hatten kein numerisch lesbares Gewicht — viele davon aber verwertbare
 * Signale (Attribut-Strings wie 'ca. 16 kg', Volumen-Literale '20L' im Titel,
 * Flächengewicht g/m² + Maße). Diese Helpers heben solche Signale in die
 * kanonische Form (kg als Number, siehe firestore.js Weight-Invariante).
 *
 * Einheiten-Konvention (CLAUDE.md / firestore.js):
 *   - details.weight + Attribut-Kopien = KG als NUMBER
 *   - LLM-/Web-Kontrakte (weight_grams) = GRAMM als INTEGER
 *
 * ACHTUNG parseWeightKg-Falle (firestore.js): nackte Zahlen > 50 werden dort
 * als GRAMM interpretiert (÷1000). Deshalb schreibt der Backfill NIE Werte
 * > MAX_PLAUSIBLE_KG — clampShippingKg() liefert dann null (skip + Report).
 */

// Plausibilitätsfenster für Versandgewichte (kg). Unter 20 g verschickt hier
// niemand etwas; über 50 kg kollidiert es mit der Gramm-Heuristik des
// Save-Parsers und ist Speditionsware — beides raus.
const MIN_PLAUSIBLE_KG = 0.02;
const MAX_PLAUSIBLE_KG = 50;

// Exakte Alias-Keys aus firestore.js (enforceEbayAspects Alias-Map) — nur
// diese Keys gelten als "das ist das Versand-/Artikelgewicht". Bewusst OHNE
// Flächengewicht o. Ä.
const WEIGHT_ALIAS_KEYS = new Set([
  'gewicht',
  'gewicht(kg)',
  'gewicht (kg)',
  'bruttogewicht',
  'brutto gewicht',
  'nettogewicht',
  'netto gewicht',
  'gross weight',
  'net weight',
  'eigengewicht',
  'eigengewicht(kg)',
  'eigengewicht (kg)',
  'artikelgewicht',
  'versandgewicht',
  'shipping weight',
  'weight',
]);

function normalizeKeyLower(key) {
  return String(key == null ? '' : key).trim().toLowerCase();
}

function isWeightAliasKey(key) {
  return WEIGHT_ALIAS_KEYS.has(normalizeKeyLower(key));
}

/**
 * Deutsche Zahl-Strings robust zu Number: '1.300' (Tausender) -> 1300,
 * '5,07' -> 5.07, '1.234,56' -> 1234.56, '16' -> 16.
 */
function parseGermanNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let t = s;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  t = t.replace(',', '.');
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Einheit 'gr' bewusst NICHT dabei — kollidiert mit Größen-Angaben
// ('US 12,5 Gr. 48' würde sonst als 12,5 Gramm geparst).
const WEIGHT_UNIT_RE = /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*\+?\s*(kg|kilogramm|kilo|g|gramm|oz|unzen?|lbs?|pfund)\b\s*(\/?\s*m[²2]?)?/i;

/**
 * Lenient-Parser für Gewichts-Strings ('ca. 16 kg', '5,07 kg (pro Stück)',
 * 'ca. 360 g', '14 Unzen', '15+ kg'). Liefert kg oder null.
 * Flächengewichte ('35 g/m²') und einheitenlose Werte ('ca. 0,25') -> null.
 *
 * opts.minKg: Untergrenze für Treffer — für TITEL-Parsing nötig, weil
 * Modell-/Chassis-Codes wie 'Audi A6 C7 4G' sonst als '4 Gramm' durchgehen.
 */
function parseLenientWeightKg(value, opts = {}) {
  const minKg = Number.isFinite(opts.minKg) ? opts.minKg : 0.001;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value >= minKg ? value : null;
  }
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const m = WEIGHT_UNIT_RE.exec(s);
  if (!m) return null;
  // Flächengewicht ('g/m²', 'g / m2') ist KEIN Versandgewicht.
  if (m[3] && m[3].includes('/')) return null;
  const n = parseGermanNumber(m[1]);
  if (n == null || n <= 0) return null;
  const unit = m[2].toLowerCase();
  let kg;
  if (unit === 'kg' || unit === 'kilogramm' || unit === 'kilo') kg = n;
  else if (unit === 'g' || unit === 'gramm') kg = n / 1000;
  else if (unit === 'oz' || unit === 'unze' || unit === 'unzen') kg = n * 0.02835;
  else kg = n * 0.4536; // lb/lbs/pfund
  if (kg < minKg || kg > MAX_PLAUSIBLE_KG) return null;
  return kg;
}

const VOLUME_RE = /(?:(\d+)\s*[x×]\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(l|liter|ltr|ml|milliliter)\b/i;

// Flüssigkeits-/Gebinde-Signal im Titel — Gate für Titel-Volumen (Tier 3).
const LIQUID_TITLE_RE = /öl\b|oel\b|oil|fluid|kühl|frostschutz|reinig|clean|farbe|lack|spray|schmier|fett|additiv|konzentrat|fertiggemisch|flüssig|liquid|wasch|shampoo|politur|wachs|verdünn|chemie|säure|destill|kanister|dose|flasche|gel\b|creme|paste|leim|kleber|harz|grundier|beize|lasur|imprägnier/i;

// Inhaltsstoff-Signal im Titel — Gate für Titel-GEWICHT (Tier 2). Ohne dieses
// Gate werden Tragkraft-Angaben ('Monitorständer 20kg belastbar'),
// Widerstands-Level ('Expander 9-13,6 kg') und Papier-Grammatur
// ('Kopierpapier 80g') fälschlich als Versandgewicht geparst.
const CONTENT_WEIGHT_TITLE_RE = new RegExp(
  `${LIQUID_TITLE_RE.source}|pulver|granulat|streu|flakes|dünger|futter|sand\\b|zement|gips|erde\\b|substrat|cream|serum|lotion|balsam|salbe|butter|pigment|seife`,
  'i'
);

// Für Tier 4 ungeeignete Produkte: Rahmen/Gestell wiegt mit (Markise: 0,85 kg
// Stoff vs. ~6 kg real) bzw. Flächengewicht gilt pro BLATT (Bücher/Journals).
const AREA_WEIGHT_UNSUITABLE_TITLE_RE = /markise|rollo|paravent|pavillon|zelt\b|liege|stuhl|sessel|journal|tagebuch|notizbuch|buch\b|kalender/i;

/**
 * Volumen-Literal aus String ziehen ('20L', '2x5 L', '100 ml') -> Liter|null.
 * Multipacks ('2x5L') werden multipliziert.
 */
function extractVolumeLiters(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const m = VOLUME_RE.exec(s);
  if (!m) return null;
  const count = m[1] ? Number.parseInt(m[1], 10) : 1;
  const n = parseGermanNumber(m[2]);
  if (n == null || n <= 0 || !Number.isFinite(count) || count <= 0) return null;
  const unit = m[3].toLowerCase();
  const liters = (unit === 'ml' || unit === 'milliliter') ? n / 1000 : n;
  const total = liters * count;
  if (total <= 0 || total > 60) return null;
  return total;
}

/**
 * Flüssigkeits-Volumen -> realistisches Versandgewicht in kg
 * (Dichte ~1 kg/L + 5 % Gebinde + 100 g Verpackung).
 */
function volumeToShippingKg(liters) {
  if (!Number.isFinite(liters) || liters <= 0) return null;
  return liters * 1.05 + 0.1;
}

/**
 * Netto-Inhaltsgewicht -> Versandgewicht (Inhalt + 10 % Gebinde + 50 g).
 */
function contentToShippingKg(contentKg) {
  if (!Number.isFinite(contentKg) || contentKg <= 0) return null;
  return contentKg * 1.1 + 0.05;
}

const DIMS_CM_RE = /(\d{1,4}(?:[.,]\d+)?)\s*[x×]\s*(\d{1,4}(?:[.,]\d+)?)\s*cm\b/i;
const AREA_WEIGHT_RE = /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(g|gr|gramm)\s*\/\s*m[²2]/i;

/**
 * Flächengewicht (g/m²) + Maße (BxH cm) -> Versandgewicht kg.
 * areaWeightSource/dimsSource sind beliebige Strings (Attributwert, Titel).
 */
function areaWeightToShippingKg(areaWeightSource, dimsSource) {
  const aw = AREA_WEIGHT_RE.exec(String(areaWeightSource == null ? '' : areaWeightSource));
  if (!aw) return null;
  const gPerSqm = parseGermanNumber(aw[1]);
  if (gPerSqm == null || gPerSqm <= 0) return null;
  const dm = DIMS_CM_RE.exec(String(dimsSource == null ? '' : dimsSource));
  if (!dm) return null;
  const a = parseGermanNumber(dm[1]);
  const b = parseGermanNumber(dm[2]);
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  const sqm = (a / 100) * (b / 100);
  if (sqm <= 0 || sqm > 100) return null;
  const kg = (gPerSqm * sqm) / 1000;
  return kg * 1.1 + 0.2; // + Verpackung/Kern
}

/**
 * Kanonische NUMERISCHE Lese-Kette (Spiegel von getProductWeightBySku,
 * lib/product-store.js): details.weight -> attributes.weight ->
 * attributes['Gewicht (kg)'] -> attributes['Gewicht']. NUR Numbers.
 */
function readCanonicalWeightKg(product) {
  const details = product?.details || {};
  const attrs = details.attributes || {};
  const candidates = [details.weight, attrs.weight, attrs['Gewicht (kg)'], attrs['Gewicht']];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

function isPlausibleShippingKg(kg) {
  return Number.isFinite(kg) && kg >= MIN_PLAUSIBLE_KG && kg <= MAX_PLAUSIBLE_KG;
}

/**
 * Finaler Guard vor jedem Write: rundet auf 2 Dezimalen, hebt Mini-Werte auf
 * das 20-g-Minimum, lehnt > MAX_PLAUSIBLE_KG ab (null = nicht schreiben!).
 * NIE umgehen — Werte > 50 würden vom Save-Parser als Gramm re-interpretiert.
 */
function clampShippingKg(kg) {
  if (!Number.isFinite(kg) || kg <= 0) return null;
  if (kg > MAX_PLAUSIBLE_KG) return null;
  const floored = Math.max(kg, MIN_PLAUSIBLE_KG);
  return Math.round(floored * 100) / 100;
}

/**
 * Deterministische Ableitung aus Produktdaten (Tiers 1-4, ohne Web/LLM).
 * Reihenfolge = Vertrauensreihenfolge: expliziter Gewichts-String im
 * Gewichts-Attribut > Inhaltsgewicht im Titel > Volumen (Attribut/Titel) >
 * Flächengewicht × Maße.
 *
 * @returns {{ kg: number, method: string, detail: string }|null} kg UNgeclampt
 */
function deriveWeightHeuristic(product) {
  const details = product?.details || {};
  const attrs = (details.attributes && typeof details.attributes === 'object') ? details.attributes : {};
  const title = String(product?.identification?.name || '');

  // Tier 1: Gewichts-Alias-Attribute mit parsebarem String ('ca. 16 kg').
  for (const [key, value] of Object.entries(attrs)) {
    if (!isWeightAliasKey(key)) continue;
    const kg = parseLenientWeightKg(value);
    if (kg != null) return { kg, method: 'attr_parse', detail: `${key}=${String(value)}` };
  }

  // Tier 2: explizites Inhaltsgewicht im Titel ('Creme 100g', 'Fett 5 kg').
  // minKg 0.05: Chassis-/Modell-Codes ('A6 C7 4G') sind sonst '4 Gramm'.
  // Inhaltsstoff-Gate: nur wenn der Titel ein Füllgut beschreibt — sonst sind
  // kg-Literale meist Tragkraft/Widerstand/Grammatur (→ Gemini-Stufe).
  if (CONTENT_WEIGHT_TITLE_RE.test(title)) {
    const titleKg = parseLenientWeightKg(title, { minKg: 0.05 });
    if (titleKg != null) {
      const kg = contentToShippingKg(titleKg);
      if (kg != null) return { kg, method: 'title_weight', detail: `Titel-Inhalt ${titleKg} kg` };
    }
  }

  // Tier 3: Volumen aus Inhalt/Menge/Volumen-Attributen oder Titel ('20L').
  // Titel-Volumen NUR bei Flüssigkeits-Keywords — Autoteile-Titel enthalten
  // Hubraum-Literale ('2.0L TDI'), die KEIN Gebinde-Volumen sind.
  const volumeAttrKeys = ['Inhalt', 'Menge', 'Volumen', 'Füllmenge', 'Fassungsvermögen', 'Inhalt/Menge'];
  let liters = null;
  let volumeSource = null;
  for (const key of volumeAttrKeys) {
    if (attrs[key] == null) continue;
    liters = extractVolumeLiters(attrs[key]);
    if (liters != null) { volumeSource = `${key}=${String(attrs[key])}`; break; }
  }
  if (liters == null && LIQUID_TITLE_RE.test(title)) {
    liters = extractVolumeLiters(title);
    if (liters != null) volumeSource = 'Titel';
  }
  if (liters != null) {
    const kg = volumeToShippingKg(liters);
    if (kg != null) return { kg, method: 'volume', detail: `${liters} L (${volumeSource})` };
  }

  // Tier 4: Flächengewicht × Maße (Sichtschutz, Stoffe, Planen). NICHT für
  // Produkte mit Rahmen/Gestell (Markisen etc.) — dort wiegt das Gestell mit.
  if (!AREA_WEIGHT_UNSUITABLE_TITLE_RE.test(title)) {
    const dimsSources = [title, attrs['Maße'], attrs['Größe'], attrs['Abmessungen'], attrs['Abmessung']];
    for (const value of Object.values(attrs)) {
      if (value == null || !/g\s*\/\s*m[²2]/i.test(String(value))) continue;
      for (const dims of dimsSources) {
        const kg = areaWeightToShippingKg(value, dims);
        if (kg != null) return { kg, method: 'area_weight', detail: `${String(value)} × ${String(dims)}` };
      }
    }
  }

  return null;
}

module.exports = {
  MIN_PLAUSIBLE_KG,
  MAX_PLAUSIBLE_KG,
  WEIGHT_ALIAS_KEYS,
  isWeightAliasKey,
  parseGermanNumber,
  parseLenientWeightKg,
  extractVolumeLiters,
  volumeToShippingKg,
  contentToShippingKg,
  areaWeightToShippingKg,
  readCanonicalWeightKg,
  isPlausibleShippingKg,
  clampShippingKg,
  deriveWeightHeuristic,
};
