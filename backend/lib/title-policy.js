/* eslint-disable no-console */
/**
 * STRICT eBay title policy enforcement (Identify / Improve / Chat / Imports).
 *
 * 🔒 Non‑negotiable rules (mobile-first + SEO):
 * - Mobile-first: first ~55–60 chars matter. Priority A MUST be inside first 60 chars:
 *   - Brand
 *   - Product type
 *   - Model / MPN / Part number
 * - Fixed order (always):
 *   [BRAND] [PRODUCT TYPE] [MODEL/MPN] [CORE SPEC] [VARIANT] [CONDITION]
 * - No marketing fluff, no emojis, no duplicates.
 * - Length:
 *   - Optimal: 65–75 chars
 *   - Hard max (eBay): 80 chars
 *
 * LLM output is treated only as a hint-source for specs; final titles are built deterministically here.
 */

const STOP_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einer', 'eines', 'einen',
  'und', 'oder', 'für', 'mit', 'ohne', 'im', 'in', 'am', 'an', 'auf', 'aus',
  'von', 'vom', 'zur', 'zum', 'bei', 'als', 'auch', 'nur', 'sehr', 'mehr',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden',
]);

const SHORT_OK_WORDS = new Set([
  'xs',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'xxxl',
  'ps5',
  'ps4',
  'ps3',
  'xbox',
  'dvd',
  'blu-ray',
  'bluray',
  '4k',
  'uhd',
]);

// Marketing / fluff words that must not appear in titles (especially not early).
// We keep this conservative to avoid removing meaningful technical tokens.
const MARKETING_WORDS = new Set([
  'hochwertig',
  'robust',
  'vielseitig',
  'nachhaltig',
  'stilvoll',
  'stylish',
  'premium',
  'top',
  'super',
  'mega',
  'perfekt',
  'ideal',
  'sale',
  'angebot',
  'original',
]);

const DEFAULT_TITLE_MAX_LEN = 80;
const DEFAULT_TITLE_SOFT_MAX_LEN = 75;
const DEFAULT_TITLE_TARGET_MIN_LEN = 65;
const DEFAULT_TITLE_MOBILE_PRIORITY_MAX_LEN = 60;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function stripEmojis(text = '') {
  // Remove emojis/pictographic symbols (mobile titles must be clean).
  return String(text || '').replace(/\p{Extended_Pictographic}/gu, ' ');
}

function stripLeadingNonAlnum(text = '') {
  // No bullets/emojis/dashes/special chars at the beginning.
  return String(text || '').replace(/^[^\p{L}\p{N}]+/gu, '');
}

function normalizeForSearch(text = '') {
  // Similar to normalizeMatch but keeps spaces to allow rough order checks.
  return safeString(text)
    .toLowerCase()
    .replace(/[\-_/.,:;()\\[\]{}'"`´’“”!?+*=<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactUnitToken(value = '') {
  // Make common patterns more compact: "120 x 30 cm" -> "120x30cm", "314 mm" -> "314mm"
  let s = safeString(value);
  if (!s) return '';
  s = s
    .replace(/×/g, 'x')
    .replace(/\s*x\s*/gi, 'x')
    .replace(/(\d)\s+(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function stripMarketingWords(text = '') {
  const raw = safeString(text);
  if (!raw) return '';
  const words = raw.split(/\s+/g);
  const kept = [];
  const roots = ['hochwert', 'robust', 'vielseit', 'nachhalt', 'stilvoll', 'stylish', 'premium', 'angebot', 'original'];
  for (const w of words) {
    const cleaned = String(w).toLowerCase().replace(/[^a-z0-9äöüß\-]/gi, '');
    if (!cleaned) continue;
    if (MARKETING_WORDS.has(cleaned)) continue;
    if (roots.some((r) => cleaned.startsWith(r))) continue;
    kept.push(w);
  }
  return normalizeSpaces(kept.join(' '));
}

function normalizeTitleToken(token = '') {
  let t = safeString(token);
  if (!t) return '';
  t = stripEmojis(t);
  t = stripMarkdownDecorations(t);
  t = stripMarketingWords(t);
  // Remove bullet-like chars inside tokens (keep dots/hyphens for MPNs).
  t = t.replace(/[•·]/g, ' ');
  // Convert decimal comma to dot (avoid "8 5cm" after comma removal).
  t = t.replace(/(\d),(\d)/g, '$1.$2');
  // Replace comma/semicolon separators with spaces to avoid CSV-breaking punctuation and trailing commas
  t = t.replace(/[,;]+/g, ' ');
  // Replace ampersands with spaces (no marketing style "X & Y")
  t = t.replace(/&/g, ' ');
  // Trim separators at ends (ASCII + Unicode punctuation/symbols)
  t = t.replace(/^[-–—,:;|]+/g, '').replace(/[-–—,:;|]+$/g, '');
  t = t.replace(/^[\p{P}\p{S}]+/gu, '').replace(/[\p{P}\p{S}]+$/gu, '');
  t = normalizeSpaces(t);
  return t;
}

function isSkuLikeToken(token = '') {
  const t = safeString(token);
  if (!t) return false;
  if (/\bSKU[\s\-_]?\d+\b/i.test(t)) return true;
  if (/^sku[\s\-_]?\d+/i.test(t)) return true;
  return false;
}

function isPureBarcodeToken(token = '') {
  const digits = safeString(token).replace(/[^\d]/g, '');
  if (!digits) return false;
  if (!/^\d+$/.test(digits)) return false;
  return digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14;
}

function extractModelCandidatesFromText(text = '') {
  const raw = safeString(text);
  if (!raw) return [];
  const parts = raw
    .split(/\s+/g)
    .map((p) => p.replace(/^[("'“”‘’`]+|[)"'“”‘’`,.]+$/g, ''))
    .filter(Boolean);
  const candidates = [];
  for (const part of parts) {
    const p = safeString(part);
    if (!p) continue;
    if (isSkuLikeToken(p)) continue;
    if (isPureBarcodeToken(p)) continue;
    // Exclude obvious dimension tokens like 120x30cm
    if (/\b\d{1,4}x\d{1,4}(?:x\d{1,4})?\s*(mm|cm|m)\b/i.test(p)) continue;
    if (/^\d{1,5}(?:[.,]\d+)?(mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb)\b/i.test(p)) continue;
    // Keep tokens that look like model/mpn (letters+digits and/or separators)
    if (/^[a-z0-9][a-z0-9._\-\/]{3,}$/i.test(p) && (/[a-z]/i.test(p) || /[._\-\/]/.test(p))) {
      candidates.push(p);
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = normalizeMatch(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 6);
}

function extractSpecTokensFromText(text = '') {
  const raw = safeString(text);
  if (!raw) return [];
  const s = stripEmojis(raw);
  const found = [];

  const push = (val) => {
    const t = normalizeTitleToken(compactUnitToken(val));
    if (!t) return;
    if (isSkuLikeToken(t)) return;
    if (isPureBarcodeToken(t)) return;
    uniqPush(found, t);
  };

  // Dimensions like 120x30cm or 120 x 30 x 40 cm
  const dimRe = /\b\d{1,4}\s*(?:x|×)\s*\d{1,4}(?:\s*(?:x|×)\s*\d{1,4})?\s*(?:mm|cm|m)\b/gi;
  let m;
  while ((m = dimRe.exec(s)) !== null) {
    push(m[0]);
  }

  // Numeric units
  const unitRe =
    /\b\d{1,5}(?:[.,]\d+)?\s*(?:mm|cm|m|l|ml|kg|g|w|kw|v|mah|gb|tb|mhz|ghz|rpm)\b/gi;
  while ((m = unitRe.exec(s)) !== null) {
    push(m[0]);
  }

  // Common tech keywords that matter for search
  const keywordTokens = [
    'm.2',
    'pcie',
    'gen3',
    'gen4',
    'ddr3',
    'ddr4',
    'ddr5',
    'sata',
    'nvme',
    'wifi',
    'bluetooth',
    'gps',
    'uhd',
    '4k',
  ];
  const lower = s.toLowerCase();
  keywordTokens.forEach((kw) => {
    if (lower.includes(kw)) {
      push(kw);
    }
  });

  return found.slice(0, 10);
}

function stripMarkdownDecorations(text = '') {
  let t = normalizeSpaces(text);
  if (!t) return '';

  // Remove wrapping quotes/backticks
  t = t.replace(/^`(.+)`$/s, '$1');
  t = t.replace(/^["“”](.+)["“”]$/s, '$1');

  // Remove common markdown bold/italic wrappers (only if they wrap the whole string)
  t = t.replace(/^\*{1,3}(.+?)\*{1,3}$/s, '$1');
  t = t.replace(/^_{1,3}(.+?)_{1,3}$/s, '$1');

  // Remove any remaining decoration markers
  t = t.replace(/\*\*/g, '').replace(/__/g, '');
  return normalizeSpaces(t);
}

function stripSkuNoise(text = '') {
  return stripMarkdownDecorations(text)
    .replace(/\bSKU[\s\-_]?\d+\b/gi, '')
    .replace(/\bSKU\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripUsedCondition(text = '') {
  return normalizeSpaces(
    safeString(text).replace(
      /\b(gebraucht|used|pre[-\s]?owned|second hand|b-ware|refurb(?:ished)?|renewed)\b/gi,
      ' '
    )
  );
}

function normalizeMatch(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/[\s\-_/.,:;()\\[\]{}'"`´’“”!?+*=<>|]/g, '');
}

function containsToken(haystack, token) {
  const h = normalizeMatch(haystack);
  const t = normalizeMatch(token);
  if (!h || !t) return false;
  return h.includes(t);
}

function uniqPush(list, value) {
  const v = normalizeSpaces(value);
  if (!v) return;
  const key = normalizeMatch(v);
  if (!key) return;
  if (list.some((e) => normalizeMatch(e) === key)) return;
  list.push(v);
}

function truncateToMax(title, maxLen) {
  const t = normalizeSpaces(title);
  if (t.length <= maxLen) return t;
  // Try cutting at last space before maxLen
  const cut = t.slice(0, maxLen);
  const idx = cut.lastIndexOf(' ');
  if (idx > 40) return cut.slice(0, idx).trim();
  return cut.trim();
}

function extractWords(text = '', { max = 60 } = {}) {
  const raw = safeString(text);
  if (!raw) return [];
  const cleaned = raw
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s\-+./]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+/g).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const w = part.trim();
    if (!w) continue;
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    // Keep short but meaningful tokens (sizes, model codes like i5/4K/PS5).
    if (lower.length < 3 && !/^\d+$/.test(lower) && !/\d/.test(lower) && !SHORT_OK_WORDS.has(lower)) {
      continue;
    }
    const key = normalizeMatch(lower);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function isUsedWordToken(word = '') {
  const w = safeString(word);
  if (!w) return false;
  return /\b(gebraucht|used|pre[-\s]?owned|secondhand|second|hand|b-ware|refurb(?:ished)?|renewed)\b/i.test(w);
}

function pickAttr(attrs, ...keys) {
  for (const key of keys) {
    const val = attrs?.[key];
    const s = safeString(val);
    if (!s) continue;
    if (/^unknown|unbekannt$/i.test(s)) continue;
    return s;
  }
  return '';
}

function collectPaddingTokens(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const tokens = [];
  uniqPush(tokens, safeString(product?.identification?.brand));

  // Product type (prefer explicit attribute, fallback to last category segment)
  const productType =
    pickAttr(attrs, 'Produktart', 'Produkttyp', 'Produkttyp (Produktart)') ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  uniqPush(tokens, productType);

  // MPN / manufacturer number
  uniqPush(tokens, safeString(product?.details?.identifiers?.mpn));
  uniqPush(tokens, pickAttr(attrs, 'Herstellernummer'));

  // OEM reference
  uniqPush(tokens, pickAttr(attrs, 'OE/OEM Referenznummer(n)', 'Referenznummer(n) OEM', 'Referenznummer', 'OEM-Referenznummer'));

  // Model
  uniqPush(tokens, pickAttr(attrs, 'Modell', 'Model', 'Model Number'));

  // Category-specific common keys
  uniqPush(tokens, pickAttr(attrs, 'Farbe', 'Color'));
  const size =
    pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size', 'Breite', 'Höhe', 'Länge', 'Durchmesser');
  if (size) {
    // Prefer "Gr." prefix only if it looks like a size
    if (/\b(gr\.?|größe)\b/i.test(String(size))) {
      uniqPush(tokens, size);
    } else {
      uniqPush(tokens, `Gr. ${size}`);
    }
  }
  uniqPush(tokens, pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial'));

  // Auto parts / compatibility hints
  uniqPush(tokens, pickAttr(attrs, 'Einbauposition', 'Position'));
  uniqPush(tokens, pickAttr(attrs, 'Bremsscheibenart'));
  uniqPush(tokens, pickAttr(attrs, 'Lochkreis'));
  uniqPush(tokens, pickAttr(attrs, 'Einbaugröße'));
  uniqPush(tokens, pickAttr(attrs, 'Betriebssystem'));
  uniqPush(tokens, pickAttr(attrs, 'Bildschirmgröße'));
  uniqPush(tokens, pickAttr(attrs, 'Wiedergabeformate'));
  uniqPush(tokens, pickAttr(attrs, 'Anschlüsse'));
  uniqPush(tokens, pickAttr(attrs, 'Anzahl der Kanäle'));
  uniqPush(tokens, pickAttr(attrs, 'Besonderheiten'));
  uniqPush(tokens, pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller'));
  uniqPush(tokens, pickAttr(attrs, 'Fahrzeugmodell', 'Modell'));
  uniqPush(tokens, pickAttr(attrs, 'Baureihe'));
  uniqPush(tokens, pickAttr(attrs, 'Universelle Kompatibilität'));

  // Books/media
  uniqPush(tokens, pickAttr(attrs, 'Autor', 'Künstler'));
  uniqPush(tokens, pickAttr(attrs, 'Buchtitel', 'Titel'));
  uniqPush(tokens, pickAttr(attrs, 'Buchreihe', 'Serie', 'Thema'));
  uniqPush(tokens, pickAttr(attrs, 'Format', 'Einband'));
  uniqPush(tokens, pickAttr(attrs, 'Sprache'));
  uniqPush(tokens, pickAttr(attrs, 'Erscheinungsjahr', 'Herstellungsjahr', 'Baujahr'));
  uniqPush(tokens, pickAttr(attrs, 'Edition', 'Ausgabe'));

  // Condition (only if explicitly present)
  const explicitCondition = pickAttr(attrs, 'Zustand');
  if (explicitCondition) {
    // IMPORTANT: Do not allow "used/gebraucht" to leak into titles unless condition is explicitly locked by humans.
    // inferCondition() already enforces that rule.
    uniqPush(tokens, inferCondition(product));
  }

  return tokens.filter(Boolean);
}

function inferCondition(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const explicit = pickAttr(attrs, 'Zustand');
  if (explicit) {
    const normalized = explicit.toString().trim().toLowerCase();
    if (/ovp|originalverpack/.test(normalized)) return 'NEU OVP';
    if (/\bneu\b|\bnew\b/.test(normalized)) return 'NEU';
    if (/\bgebraucht\b|\bused\b|\bpre[-\s]?owned\b|\bsecond hand\b|\bb-ware\b|\brefurb/.test(normalized)) {
      // User requirement: "Gebraucht" only when explicitly curated by humans.
      const locked = Boolean(product?.ops?.condition_locked);
      return locked ? 'Gebraucht' : 'NEU';
    }
    return explicit;
  }
  return 'NEU';
}

function inferSchemaId(product) {
  const category = safeString(product?.identification?.category).toLowerCase();
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const leaf = normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '').toLowerCase();

  if (pickAttr(attrs, 'Autor') || pickAttr(attrs, 'Buchtitel') || category.includes('bücher') || category.includes('buch')) {
    return 'books';
  }
  if (pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße') || category.includes('schuhe') || /sneaker|schuh/.test(leaf)) {
    return 'shoes';
  }
  if (category.includes('kleidung') || category.includes('bekleidung') || /hoodie|shirt|pullover|jacke|hose|sweat/.test(leaf)) {
    return 'clothing';
  }
  if (category.includes('auto') || category.includes('kfz') || category.includes('motorrad') || category.includes('autoteile')) {
    // Split mech vs accessory
    if (
      pickAttr(attrs, 'OE/OEM Referenznummer(n)', 'Referenznummer(n) OEM', 'Herstellernummer') ||
      pickAttr(attrs, 'Bremsscheibenart', 'Einbauposition', 'Lochkreis')
    ) {
      return 'auto_mech';
    }
    return 'auto_accessory';
  }
  if (category.includes('elektronik') || pickAttr(attrs, 'Betriebssystem', 'Bildschirmgröße')) {
    return 'electronics';
  }
  if (category.includes('smartphone') || category.includes('handy')) return 'smartphones';
  if (category.includes('laptop') || category.includes('notebook')) return 'laptops';
  if (category.includes('pc') || category.includes('hardware')) return 'pc_hardware';
  if (category.includes('spiel') && category.includes('konsole')) return 'consoles';
  if (category.includes('spielzeug')) return 'toys';
  if (category.includes('brettspiel') || category.includes('gesellschaftsspiel')) return 'boardgames';
  if (category.includes('film') || category.includes('blu-ray') || category.includes('dvd')) return 'movies';
  if (category.includes('musik') || category.includes('vinyl') || category.includes('cd')) return 'music';
  if (category.includes('küche') || category.includes('tafel') || category.includes('haushaltsger')) return 'kitchen';
  if (category.includes('möbel') || category.includes('wohnen') || category.includes('haushalt')) return 'home';
  if (category.includes('garten') || category.includes('bau') || category.includes('werkzeug')) return 'tools';
  if (category.includes('tier') || category.includes('haustier')) return 'pet';
  if (category.includes('beauty') || category.includes('gesundheit')) return 'beauty';
  if (category.includes('sport') || category.includes('fitness')) return 'sport';
  if (category.includes('outdoor') || category.includes('camping')) return 'outdoor';
  if (category.includes('büro') || category.includes('schreibwaren')) return 'office';
  return 'generic';
}

function buildTitlePlanBySchema(product, schemaId, { proposedTitle = '' } = {}) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const brand =
    normalizeTitleToken(safeString(product?.identification?.brand)) ||
    normalizeTitleToken(pickAttr(attrs, 'Marke', 'Brand')) ||
    '';

  const productTypeRaw =
    pickAttr(
      attrs,
      'Produktart',
      'Produkttyp',
      'Produkttyp (Produktart)',
      // Common real-world variants across categories (Beauty/Tech/Tools/Auto)
      'Gerätetyp',
      'Artikeltyp',
      'Artikel-Typ',
      'Bauteil',
      'Komponente',
      'Werkzeugart',
      'Schuhart'
    ) ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  const productType = normalizeTitleToken(productTypeRaw);

  const mpn =
    normalizeTitleToken(safeString(product?.details?.identifiers?.mpn)) ||
    normalizeTitleToken(pickAttr(attrs, 'Herstellernummer', 'MPN')) ||
    '';
  const model = normalizeTitleToken(pickAttr(attrs, 'Modell', 'Model', 'Model Number'));
  const oem = normalizeTitleToken(
    pickAttr(attrs, 'OE/OEM Referenznummer(n)', 'Referenznummer(n) OEM', 'Referenznummer', 'OEM-Referenznummer')
  );

  const hintText = [proposedTitle, product?.identification?.name, product?.details?.short_description]
    .map((x) => safeString(x))
    .filter(Boolean)
    .join(' ');
  const extractedCodes = extractModelCandidatesFromText(hintText);
  const modelOrMpn = mpn || model || oem || normalizeTitleToken(extractedCodes[0] || '');

  const condition = normalizeTitleToken(inferCondition(product));

  const color = normalizeTitleToken(pickAttr(attrs, 'Farbe', 'Color'));
  const sizeRaw = pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size');
  const size = sizeRaw ? (/\b(gr\.?|größe)\b/i.test(sizeRaw) ? sizeRaw : `Gr. ${sizeRaw}`) : '';
  const normSize = normalizeTitleToken(compactUnitToken(size));
  const material = normalizeTitleToken(pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial'));

  const vehicleMake = normalizeTitleToken(pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller'));
  const vehicleModel = normalizeTitleToken(pickAttr(attrs, 'Fahrzeugmodell'));
  const vehicleSeries = normalizeTitleToken(pickAttr(attrs, 'Baureihe'));
  const position = normalizeTitleToken(pickAttr(attrs, 'Einbauposition', 'Position'));

  const measure = normalizeTitleToken(
    compactUnitToken(
      pickAttr(attrs, 'Maße', 'Abmessungen', 'Durchmesser', 'Länge', 'Breite', 'Höhe', 'Tiefe', 'Lochkreis', 'Einbaugröße')
    )
  );
  const capacity = normalizeTitleToken(
    compactUnitToken(pickAttr(attrs, 'Fassungsvermögen gesamt', 'Fassungsvermögen', 'Volumen', 'Kapazität', 'Speicherkapazität', 'Speicher'))
  );
  const power = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Leistung', 'Power')));
  const voltage = normalizeTitleToken(compactUnitToken(pickAttr(attrs, 'Spannung', 'Volt', 'Voltage')));
  const audience = normalizeTitleToken(pickAttr(attrs, 'Abteilung', 'Zielgruppe', 'Geschlecht'));

  const specsFromText = extractSpecTokensFromText(
    [proposedTitle, product?.identification?.name, productTypeRaw, modelOrMpn].filter(Boolean).join(' ')
  );

  const a = [];
  uniqPush(a, brand);
  uniqPush(a, productType);
  uniqPush(a, modelOrMpn);

  const b = [];
  const c = [];

  const pushB = (v) => uniqPush(b, normalizeTitleToken(compactUnitToken(v)));
  const pushC = (v) => uniqPush(c, normalizeTitleToken(compactUnitToken(v)));

  switch (schemaId) {
    case 'auto_mech': {
      // Priority B: vehicle always BEFORE measures/specs
      pushB(vehicleMake);
      pushB(vehicleModel);
      pushB(vehicleSeries);
      pushB(position);
      pushB(measure);
      specsFromText.forEach((t) => pushB(t));
      // Priority C
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'auto_accessory': {
      pushB(vehicleMake);
      pushB(vehicleModel);
      pushB(vehicleSeries);
      pushB(position);
      pushB(measure);
      specsFromText.forEach((t) => pushB(t));
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'shoes':
    case 'clothing': {
      // Fashion: gender/department + size after model/mpn; color last.
      pushB(audience);
      pushB(normSize);
      pushB(material);
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'electronics':
    case 'smartphones':
    case 'laptops':
    case 'pc_hardware': {
      pushB(capacity);
      pushB(power);
      pushB(voltage);
      specsFromText.forEach((t) => pushB(t));
      pushC(color);
      pushC(condition);
      return { schemaId, a, b, c };
    }
    case 'books': {
      const author = normalizeTitleToken(pickAttr(attrs, 'Autor'));
      const bookTitle =
        normalizeTitleToken(pickAttr(attrs, 'Buchtitel', 'Titel')) ||
        normalizeTitleToken(stripSkuNoise(product?.identification?.name || ''));
      const year = normalizeTitleToken(pickAttr(attrs, 'Erscheinungsjahr'));
      const binding = normalizeTitleToken(pickAttr(attrs, 'Einband', 'Format'));
      const a2 = [];
      uniqPush(a2, author ? `${author} – ${bookTitle}` : bookTitle);
      const b2 = [];
      uniqPush(b2, year);
      uniqPush(b2, binding);
      const c2 = [];
      uniqPush(c2, condition);
      return { schemaId, a: a2, b: b2, c: c2 };
    }
    default: {
      // Generic master schema
      pushB(measure);
      pushB(capacity);
      pushB(power);
      pushB(voltage);
      pushB(audience);
      pushB(normSize);
      pushB(material);
      specsFromText.forEach((t) => pushB(t));
      pushC(color);
      pushC(condition);
      return { schemaId: schemaId || 'generic', a, b, c };
    }
  }
}

function assembleTitleFromPlan(plan, { targetMinLen, softMaxLen, maxLen } = {}) {
  const hardMax = Number.isFinite(maxLen) ? maxLen : DEFAULT_TITLE_MAX_LEN;
  const softMax = Number.isFinite(softMaxLen) ? softMaxLen : DEFAULT_TITLE_SOFT_MAX_LEN;
  const targetMin = Number.isFinite(targetMinLen) ? targetMinLen : DEFAULT_TITLE_TARGET_MIN_LEN;

  const parts = [];

  const add = (token) => {
    const t = normalizeTitleToken(token);
    if (!t) return;
    if (parts.some((p) => normalizeMatch(p) === normalizeMatch(t))) return;
    const tentative = normalizeSpaces([...parts, t].join(' '));
    if (!tentative) return;
    if (tentative.length > hardMax) return;
    parts.push(t);
  };

  // Priority A (must be first)
  (plan?.a || []).forEach((t) => add(t));

  // Priority B (reach targetMin if possible, but prefer staying <= softMax)
  for (const t of plan?.b || []) {
    const current = normalizeSpaces(parts.join(' '));
    if (current.length >= softMax && current.length >= targetMin) break;
    add(t);
  }

  // Priority C (end tokens)
  for (const t of plan?.c || []) {
    const current = normalizeSpaces(parts.join(' '));
    if (current.length >= softMax && current.length >= targetMin) break;
    add(t);
  }

  // Token-level cleanup (avoid word-level truncation artifacts)
  if (parts.length) {
    parts[0] = normalizeSpaces(stripLeadingNonAlnum(parts[0]));
  }

  // Remove repeated words across tokens, but preserve token boundaries
  const seenWords = new Set();
  const cleanedTokens = [];
  for (const token of parts) {
    const words = safeString(token).split(/\s+/g).filter(Boolean);
    const kept = [];
    for (const w of words) {
      const key = normalizeMatch(w);
      if (!key) continue;
      if (seenWords.has(key)) continue;
      seenWords.add(key);
      kept.push(w);
    }
    const rebuilt = normalizeSpaces(kept.join(' '));
    if (rebuilt) cleanedTokens.push(rebuilt);
  }

  const aCount = Array.isArray(plan?.a) ? plan.a.filter(Boolean).length : 0;

  // If > softMax, drop tail TOKENS (never drop A tokens)
  while (normalizeSpaces(cleanedTokens.join(' ')).length > softMax && cleanedTokens.length > aCount) {
    cleanedTokens.pop();
  }

  let title = normalizeSpaces(cleanedTokens.join(' '));
  if (title.length > hardMax) {
    title = truncateToMax(title, hardMax);
  }
  // Final: no trailing punctuation/symbols
  title = title.replace(/[\p{P}\p{S}]+$/gu, '').trim();
  return title;
}

function validateTitleToPolicy(
  product,
  title,
  { maxLen = DEFAULT_TITLE_MAX_LEN, mobileMaxLen = DEFAULT_TITLE_MOBILE_PRIORITY_MAX_LEN } = {}
) {
  const issues = [];
  const raw = safeString(title);
  const t = normalizeSpaces(stripEmojis(raw));

  if (!t) return ['title_missing'];
  if (t.length > maxLen) issues.push('title_too_long');

  if (raw && raw.match(/^[^\p{L}\p{N}]+/u)) {
    issues.push('title_starts_with_symbol');
  }
  const firstWord = safeString(t.split(/\s+/g)[0] || '').toLowerCase();
  if (MARKETING_WORDS.has(firstWord) || ['hochwert', 'robust', 'vielseit', 'nachhalt', 'stilvoll', 'stylish', 'premium', 'angebot', 'original'].some((r) => firstWord.startsWith(r))) {
    issues.push('title_starts_with_marketing');
  }

  const schemaId = inferSchemaId(product);
  const plan = buildTitlePlanBySchema(product, schemaId, { proposedTitle: '' });
  const aTokens = Array.isArray(plan?.a) ? plan.a.filter(Boolean) : [];

  // Books/media use a different schema; do not enforce Brand/ProductType/Model in those cases.
  if (schemaId !== 'books') {
    // Source-data presence (strict)
    if (!aTokens[0] || /^unbekannt$/i.test(aTokens[0])) issues.push('brand_missing');
    if (!aTokens[1] || /^unbekannt$/i.test(aTokens[1])) issues.push('product_type_missing');
    if (!aTokens[2] || /^unbekannt$/i.test(aTokens[2])) issues.push('model_or_mpn_missing');

    const firstN = t.slice(0, mobileMaxLen);
    for (const tok of aTokens) {
      if (!tok) continue;
      if (!containsToken(t, tok)) issues.push('priority_a_missing_in_title');
      // Mobile-first: it's enough that the token STARTS within the first ~60 chars.
      // Using the full token causes false negatives when the token crosses the 60-char boundary.
      const anchor = safeString(tok).split(/\s+/g).filter(Boolean)[0] || tok;
      if (!containsToken(firstN, anchor)) issues.push('priority_a_not_in_first_60');
    }

    // Order check (brand -> product type -> model/mpn)
    const norm = normalizeForSearch(t);
    const idx = (token) => {
      const q = normalizeForSearch(token);
      if (!q) return -1;
      return norm.indexOf(q);
    };
    const i1 = aTokens[0] ? idx(aTokens[0]) : -1;
    const i2 = aTokens[1] ? idx(aTokens[1]) : -1;
    const i3 = aTokens[2] ? idx(aTokens[2]) : -1;
    if (i1 !== -1 && i2 !== -1 && i1 > i2) issues.push('order_brand_after_producttype');
    if (i2 !== -1 && i3 !== -1 && i2 > i3) issues.push('order_producttype_after_model');
  }

  // Duplicate words
  const words = t.split(/\s+/g).filter(Boolean);
  const seenWords = new Set();
  for (const w of words) {
    const key = normalizeMatch(w);
    if (!key) continue;
    if (seenWords.has(key)) {
      issues.push('duplicate_word');
      break;
    }
    seenWords.add(key);
  }

  return Array.from(new Set(issues));
}

function buildBaseTitleBySchema(product, schemaId) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};

  const brand = safeString(product?.identification?.brand);
  const productType =
    pickAttr(attrs, 'Produktart', 'Produkttyp', 'Produkttyp (Produktart)') ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  const model = pickAttr(attrs, 'Modell', 'Model', 'Model Number');
  const color = pickAttr(attrs, 'Farbe', 'Color');
  const sizeRaw = pickAttr(attrs, 'EU-Schuhgröße', 'US-Schuhgröße', 'UK-Schuhgröße', 'Größe', 'Size');
  const size = sizeRaw ? (/\bgr\.?|größe\b/i.test(sizeRaw) ? sizeRaw : `Gr. ${sizeRaw}`) : '';
  const material = pickAttr(attrs, 'Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial');
  const condition = inferCondition(product);
  const mpn = safeString(product?.details?.identifiers?.mpn) || pickAttr(attrs, 'Herstellernummer');

  const join = (...parts) => normalizeSpaces(parts.filter(Boolean).join(' '));

  switch (schemaId) {
    case 'books': {
      const author = pickAttr(attrs, 'Autor');
      const title = pickAttr(attrs, 'Buchtitel') || stripSkuNoise(product?.identification?.name || '');
      const year = pickAttr(attrs, 'Erscheinungsjahr');
      const binding = pickAttr(attrs, 'Einband', 'Format');
      const state = condition;
      const dash = author ? `${author} – ${title}` : title;
      return join(dash, year, binding, state);
    }
    case 'shoes': {
      const audience = pickAttr(attrs, 'Abteilung', 'Zielgruppe');
      const shoeModel = model || stripSkuNoise(product?.identification?.name || '').replace(new RegExp(brand, 'i'), '').trim();
      return join(brand, shoeModel, audience, 'Sneaker', color, size, condition);
    }
    case 'clothing': {
      const audience = pickAttr(attrs, 'Abteilung', 'Zielgruppe');
      return join(brand, productType, audience, color, size, material, condition);
    }
    case 'auto_mech': {
      const vehicleMake = pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller');
      const measure = pickAttr(attrs, 'Durchmesser', 'Breite', 'Dicke', 'Bildschirmgröße', 'Lochkreis');
      const feature = pickAttr(attrs, 'Bremsscheibenart', 'Einbauposition', 'Oberflächenbeschaffenheit');
      // Keep "für" as structural keyword
      return join(brand, productType, mpn, vehicleMake ? `für ${vehicleMake}` : '', measure, feature, condition);
    }
    case 'auto_accessory': {
      const vehicleMake = pickAttr(attrs, 'Fahrzeugmarke', 'Hersteller');
      const vehicleModel = pickAttr(attrs, 'Fahrzeugmodell', 'Modell');
      const series = pickAttr(attrs, 'Baureihe');
      return join(productType, 'passgenau für', vehicleMake, vehicleModel, series, condition);
    }
    case 'electronics': {
      const variant = pickAttr(attrs, 'Variante');
      return join(brand, productType, model, variant, color, condition);
    }
    default:
      return join(brand, productType, model, mpn, color, size, material, condition);
  }
}

function appendTokens(title, tokens, { minLen, maxLen }) {
  let out = normalizeSpaces(title);
  for (const token of tokens) {
    if (!token) continue;
    if (containsToken(out, token)) continue;
    const tentative = normalizeSpaces(`${out} ${token}`);
    if (tentative.length > maxLen) continue;
    out = tentative;
    if (out.length >= minLen) break;
  }
  return out;
}

function coerceTitleToPolicy(
  product,
  proposedTitle,
  { minLen = DEFAULT_TITLE_TARGET_MIN_LEN, maxLen = DEFAULT_TITLE_MAX_LEN, softMaxLen = DEFAULT_TITLE_SOFT_MAX_LEN } = {}
) {
  const conditionLocked = Boolean(product?.ops?.condition_locked);

  // Clean the incoming title: we only use it as a hint source for specs.
  let hintTitle = stripSkuNoise(proposedTitle || '');
  hintTitle = stripEmojis(hintTitle);
  hintTitle = stripMarketingWords(hintTitle);
  if (!conditionLocked) {
    hintTitle = stripUsedCondition(hintTitle);
  }
  hintTitle = normalizeSpaces(hintTitle);

  const schemaId = inferSchemaId(product);
  const plan = buildTitlePlanBySchema(product, schemaId, { proposedTitle: hintTitle });

  let title = assembleTitleFromPlan(plan, {
    targetMinLen: Math.min(Math.max(20, Number(minLen) || DEFAULT_TITLE_TARGET_MIN_LEN), maxLen),
    softMaxLen,
    maxLen,
  });

  if (!conditionLocked) {
    title = stripUsedCondition(title);
    title = normalizeSpaces(title);
  }
  title = stripLeadingNonAlnum(title);
  title = normalizeSpaces(title);
  if (title.length > maxLen) title = truncateToMax(title, maxLen);
  return title;
}

module.exports = {
  coerceTitleToPolicy,
  validateTitleToPolicy,
};
