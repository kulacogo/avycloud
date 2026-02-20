const crypto = require('crypto');

const DEFAULT_ALIAS_LIMIT = 64;
const STOPWORDS = new Set([
  'und',
  'oder',
  'mit',
  'inkl',
  'inklusive',
  'fur',
  'für',
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einer',
  'von',
  'vom',
  'zur',
  'zum',
  'für',
  'for',
  'the',
  'new',
  'neu',
  'city',
  'stadt',
  'schnell',
  'schnelle',
  'schneller',
  'diagnose',
  'funktion',
  'funktionskontrolle',
  'messgerät',
  'geraet',
  'gerät',
  'pruefgeraet',
  'prüfgerät',
  'tester',
  'set',
]);

function normalizePart(value) {
  if (!value) return '';
  return value
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeIdentityValue(value) {
  const normalized = normalizePart(value);
  return normalized || null;
}

function tokenize(value) {
  const normalized = sanitizeIdentityValue(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function normalizeAliasToken(token) {
  if (!token) return null;
  let normalized = token;
  if (/roller$/.test(normalized) || /scooter$/.test(normalized)) {
    normalized = 'roller';
  }
  if (/motor(rad|bike|cycle)s?$/.test(normalized)) {
    normalized = 'motorrad';
  }
  if (/tester$/.test(normalized)) {
    normalized = 'tester';
  }
  if (/geraet$/.test(normalized) || /gerät$/.test(normalized)) {
    normalized = 'geraet';
  }
  if (/diagnose$/.test(normalized)) {
    normalized = 'diagnose';
  }
  return normalized;
}

function expandAlphaNumericToken(token) {
  if (!token) return [];
  const variants = [];
  const letters = token.replace(/[^a-z]+/g, '');
  const digits = token.replace(/[^0-9]+/g, '');
  if (letters && letters.length >= 2) {
    variants.push(letters);
  }
  if (digits && digits.length >= 2) {
    variants.push(digits);
  }
  return variants;
}

function stripBrandPrefix(name, brand) {
  if (!name || !brand) return name;
  if (name.startsWith(`${brand} `)) {
    return name.slice(brand.length).trim();
  }
  return name;
}

function buildIdentityAliasSet(product = {}, { limit = DEFAULT_ALIAS_LIMIT } = {}) {
  const aliases = new Set();
  const addAlias = (value) => {
    const normalized = sanitizeIdentityValue(value);
    if (normalized) {
      aliases.add(normalized);
    }
  };

  addAlias(product?.id);
  addAlias(product?.identification?.sku);
  addAlias(product?.details?.identifiers?.sku);
  addAlias(product?.details?.identifiers?.ean);
  addAlias(product?.details?.identifiers?.gtin);
  addAlias(product?.details?.identifiers?.upc);
  addAlias(product?.details?.identifiers?.mpn);

  if (Array.isArray(product?.identification?.barcodes)) {
    product.identification.barcodes.forEach(addAlias);
  }

  const brand = sanitizeIdentityValue(product?.identification?.brand);
  const name = sanitizeIdentityValue(product?.identification?.name);
  const category = sanitizeIdentityValue(product?.identification?.category);

  if (brand) aliases.add(brand);
  if (category) aliases.add(category);

  const nameWithoutBrand = stripBrandPrefix(name, brand);
  if (nameWithoutBrand) {
    aliases.add(nameWithoutBrand);
    if (brand) {
      aliases.add(`${brand}::${nameWithoutBrand}`);
    }
  }

  const tokens = tokenize(nameWithoutBrand || name);
  if (tokens.length) {
    const normalizedTokens = tokens
      .map((token) => normalizeAliasToken(token))
      .filter(Boolean);
    const filteredTokens = normalizedTokens.filter((token) => !STOPWORDS.has(token));
    if (filteredTokens.length) {
      aliases.add(filteredTokens.join(' '));
      aliases.add(filteredTokens.slice(0, 4).join(' '));
      aliases.add([...filteredTokens].sort().join('-'));
      filteredTokens.forEach((token) => {
        addAlias(token);
        expandAlphaNumericToken(token).forEach(addAlias);
      });
    }
  }

  const final = Array.from(aliases).filter(Boolean);
  return final.slice(0, limit);
}

function computeProductIdentityKey(product = {}) {
  const name = normalizePart(product?.identification?.name);
  const brand = normalizePart(product?.identification?.brand);
  const mpn = normalizePart(product?.details?.identifiers?.mpn);
  const manufacturerSku = normalizePart(product?.details?.identifiers?.sku);
  const baseId = product?.ops?.base_product_id ? String(product.ops.base_product_id).trim() : null;

  if (baseId) {
    return `base:${baseId}`;
  }

  if (product?.identification?.barcodes?.length || product?.details?.identifiers?.ean || product?.details?.identifiers?.gtin || product?.details?.identifiers?.upc) {
    return null;
  }

  const parts = [brand, name, mpn, manufacturerSku].filter(Boolean);
  if (!parts.length) {
    return null;
  }

  const raw = parts.join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `identity:${hash}`;
}

module.exports = {
  computeProductIdentityKey,
  buildIdentityAliasSet,
  sanitizeIdentityValue,
};


