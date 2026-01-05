/* eslint-disable no-console */
/**
 * Title policy enforcement for AI generated titles (Improve/Chat):
 * - Target length: 70–80 characters (inclusive)
 * - Never include SKU / internal IDs
 * - Do not invent facts: only reuse existing product data (attrs/identifiers/category/description/title text)
 *
 * We "coerce" a proposed title by:
 * 1) normalizing/cleaning it
 * 2) ensuring brand + product type presence when available
 * 3) padding with known tokens (mpn/oem/model/size/color/material/etc)
 * 4) as last resort, padding with keywords from existing title and short_description (not inventing)
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

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
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
  return 'generic';
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

function coerceTitleToPolicy(product, proposedTitle, { minLen = 70, maxLen = 80 } = {}) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const conditionLocked = Boolean(product?.ops?.condition_locked);

  let title = stripSkuNoise(proposedTitle || '');
  // Remove used-condition leakage unless explicitly curated by humans (condition_locked).
  if (!conditionLocked) {
    title = stripUsedCondition(title);
  }
  if (!title) {
    title = stripSkuNoise(product?.identification?.name || '');
  }
  if (!conditionLocked) {
    title = stripUsedCondition(title);
  }

  // If the provided title is too short, prefer a deterministic schema-based build from known fields.
  const schemaId = inferSchemaId(product);
  if (title.length < minLen) {
    const built = buildBaseTitleBySchema(product, schemaId);
    if (built) title = built;
  }

  // Ensure brand appears (schema expects brand leading)
  const brand = safeString(product?.identification?.brand);
  if (brand && !containsToken(title, brand)) {
    const prefixed = normalizeSpaces(`${brand} ${title}`);
    if (prefixed.length <= maxLen) {
      title = prefixed;
    }
  }

  // Ensure product type appears (if known)
  const productType =
    pickAttr(attrs, 'Produktart', 'Produkttyp', 'Produkttyp (Produktart)') ||
    normalizeSpaces(String(product?.identification?.category || '').split('>').pop() || '');
  if (productType && !containsToken(title, productType)) {
    const tentative = normalizeSpaces(`${title} ${productType}`);
    if (tentative.length <= maxLen) {
      title = tentative;
    }
  }

  // Ensure condition appears (default to NEU when not explicitly set)
  const condition = inferCondition(product);
  if (condition && !containsToken(title, condition)) {
    const tentative = normalizeSpaces(`${title} ${condition}`);
    if (tentative.length <= maxLen) {
      title = tentative;
    }
  }

  title = normalizeSpaces(title);
  if (title.length > maxLen) {
    title = truncateToMax(title, maxLen);
  }

  if (title.length >= minLen && title.length <= maxLen) {
    return title;
  }

  // Pad with structured tokens first
  const tokens = collectPaddingTokens(product);
  title = appendTokens(title, tokens, { minLen, maxLen });

  // If still short, pad with keywords from proposed title + existing title + category + short description
  if (title.length < minLen) {
    const categoryText = normalizeSpaces(String(product?.identification?.category || ''));
    const shortDesc = safeString(product?.details?.short_description || '');
    let fallbackWords = [
      ...extractWords(proposedTitle || ''),
      ...extractWords(product?.identification?.name || ''),
      ...extractWords(categoryText, { max: 160 }),
      ...extractWords(shortDesc, { max: 120 }),
    ];
    if (!conditionLocked) {
      fallbackWords = fallbackWords.filter((w) => !isUsedWordToken(w));
    }
    title = appendTokens(title, fallbackWords, { minLen, maxLen });
  }

  // If STILL short, add last-resort safe category segments (derived facts).
  if (title.length < minLen) {
    const segments = String(product?.identification?.category || '')
      .split('>')
      .map((s) => normalizeSpaces(s))
      .filter(Boolean)
      .slice(-4);
    title = appendTokens(title, segments, { minLen, maxLen });
  }

  // Absolute fallback: append generic but non-factual fillers to hit minLen (rare).
  if (title.length < minLen) {
    const fillers = ['Artikel', 'Produkt'].filter((t) => t && !containsToken(title, t));
    title = appendTokens(title, fillers, { minLen, maxLen });
  }

  // Final clamp
  title = normalizeSpaces(title);
  if (title.length > maxLen) {
    title = truncateToMax(title, maxLen);
  }

  // Hard guarantee: if we couldn't reach minLen, keep appending safe extracted words from the full category + description.
  // This avoids returning short titles which the UI considers invalid for Improve/Chat.
  if (title.length < minLen) {
    const categoryAll = safeString(product?.identification?.category || '');
    const shortDesc = safeString(product?.details?.short_description || '');
    let rescue = [...extractWords(categoryAll, { max: 200 }), ...extractWords(shortDesc, { max: 200 })];
    if (!conditionLocked) {
      rescue = rescue.filter((w) => !isUsedWordToken(w));
    }
    title = appendTokens(title, rescue, { minLen, maxLen });
    title = normalizeSpaces(title);
    if (title.length > maxLen) title = truncateToMax(title, maxLen);
  }

  return title;
}

module.exports = {
  coerceTitleToPolicy,
};
