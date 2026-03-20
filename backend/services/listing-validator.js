/**
 * listing-validator.js — Pre-Listing Validation Engine (VAL-001)
 *
 * Validates product data against marketplace-specific requirements.
 * Supports eBay DE and Kaufland profiles.
 *
 * Usage:
 *   const { validateForMarketplace, validateProduct, validateBatch } = require('./listing-validator');
 *   const result = validateProduct(product, ['ebay', 'kaufland']);
 */

const {
  getRequiredAspects,
  isKnownEbayCategoryId,
  getCategoryAspectCatalog,
  findEbayCategory,
} = require('../lib/ebay-taxonomy');
const { isBannedEbayBreadcrumb } = require('../lib/ebay-category-governance');

// ── Helpers ──────────────────────────────────────────────────────────

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function countAttributes(attrs) {
  if (!attrs) return 0;
  if (Array.isArray(attrs)) return attrs.filter((x) => x && x.key && x.value).length;
  if (typeof attrs === 'object') {
    return Object.keys(attrs).filter(
      (k) => k && attrs[k] != null && String(attrs[k]).trim() !== ''
    ).length;
  }
  return 0;
}

function getImages(product) {
  const imgs = product?.details?.images;
  if (!Array.isArray(imgs)) return [];
  return imgs.filter((img) => img && (img.url_or_base64 || img.url || img.href));
}

function getAttributeMap(product) {
  const raw = product?.details?.attributes;
  if (!raw || typeof raw !== 'object') return {};
  if (Array.isArray(raw)) {
    const out = {};
    raw.forEach((entry) => {
      const key = entry && typeof entry === 'object' ? safeString(entry.key) : '';
      const value = entry && typeof entry === 'object' ? safeString(String(entry.value ?? '')) : '';
      if (key && value) out[key] = value;
    });
    return out;
  }
  return raw;
}

function getEan(product) {
  const ids = product?.details?.identifiers || {};
  const barcodes = product?.identification?.barcodes || [];
  return safeString(ids.ean) || safeString(ids.gtin) || (barcodes[0] ? safeString(barcodes[0]) : '');
}

function isValidEan(ean) {
  if (!ean) return false;
  return /^\d{8}$|^\d{12,14}$/.test(ean);
}

function hasActiveContent(text) {
  const s = String(text || '');
  return (
    /<\s*script\b/i.test(s) ||
    /javascript\s*:/i.test(s) ||
    /<\s*iframe\b/i.test(s) ||
    /<\s*form\b/i.test(s) ||
    /\bon\w+\s*=\s*["']/i.test(s)
  );
}

function hasOffEbayLinks(text) {
  const s = String(text || '');
  if (/\bhttps?:\/\/\S+/i.test(s)) return true;
  if (/\bwww\.[^\s<]+/i.test(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
  return false;
}

function makeIssue(code, severity, message, fields, suggestion) {
  return { code, severity, message, fields: fields || [], suggestion: suggestion || null };
}

// ── eBay Validation Profile ──────────────────────────────────────────

function validateEbay(product) {
  const errors = [];
  const warnings = [];
  const info = [];

  const title = safeString(product?.identification?.name);
  const desc = safeString(
    product?.details?.short_description || product?.details?.description
  );
  const images = getImages(product);
  const categoryId = safeString(product?.details?.categoryId);
  const attrs = getAttributeMap(product);
  const attrCount = countAttributes(attrs);
  const ean = getEan(product);
  const brand = safeString(product?.identification?.brand);
  const price = product?.details?.pricing;
  const sellPrice = price?.sellPrice;
  const lowestPrice = price?.lowest_price?.amount;

  // ── ERRORS (blocking) ──

  // Title
  if (!title) {
    errors.push(makeIssue(
      'title_missing', 'error',
      'Titel fehlt. Ein Titel ist fuer eBay-Listings zwingend erforderlich.',
      ['identification.name'],
      'Geben Sie einen aussagekraeftigen Produkttitel ein.'
    ));
  } else if (title.length > 80) {
    errors.push(makeIssue(
      'title_too_long', 'error',
      `Titel ist ${title.length} Zeichen lang. eBay erlaubt maximal 80 Zeichen.`,
      ['identification.name'],
      'Kuerzen Sie den Titel auf maximal 80 Zeichen.'
    ));
  }

  // Images
  if (images.length === 0) {
    errors.push(makeIssue(
      'images_missing', 'error',
      'Keine Bilder vorhanden. eBay erfordert mindestens 1 Bild.',
      ['details.images'],
      'Laden Sie mindestens ein Produktbild hoch.'
    ));
  }

  // Category
  if (!categoryId) {
    errors.push(makeIssue(
      'category_missing', 'error',
      'Keine eBay-Kategorie zugeordnet.',
      ['details.categoryId'],
      'Waehlen Sie eine passende eBay-Kategorie aus.'
    ));
  } else {
    const isKnown = isKnownEbayCategoryId(categoryId);
    if (!isKnown) {
      errors.push(makeIssue(
        'category_unknown', 'error',
        `Kategorie-ID "${categoryId}" ist nicht in der eBay-Taxonomie bekannt.`,
        ['details.categoryId'],
        'Waehlen Sie eine gueltige eBay-Kategorie aus dem Kategoriebaum.'
      ));
    } else {
      const cat = findEbayCategory(categoryId);
      const breadcrumb = cat?.breadcrumb ? String(cat.breadcrumb) : '';
      if (breadcrumb && isBannedEbayBreadcrumb(breadcrumb)) {
        errors.push(makeIssue(
          'category_banned', 'error',
          'Diese Kategorie ist in AvyCloud gesperrt.',
          ['details.categoryId'],
          'Waehlen Sie eine andere Kategorie.'
        ));
      }
    }

    // Required aspects
    const required = getRequiredAspects(categoryId);
    if (required.length > 0) {
      const attrsLower = {};
      for (const [k, v] of Object.entries(attrs)) {
        const key = safeString(k).toLowerCase();
        const val = v == null ? '' : String(v).trim();
        if (key && val) attrsLower[key] = val;
      }

      const missing = required.filter((aspect) => {
        const direct = attrs[aspect];
        if (direct != null && String(direct).trim() !== '') return false;
        const lowerVal = attrsLower[safeString(aspect).toLowerCase()];
        return !lowerVal;
      });

      if (missing.length > 0) {
        const preview = missing.slice(0, 10);
        const suffix = missing.length > 10 ? ` (+${missing.length - 10} weitere)` : '';
        errors.push(makeIssue(
          'missing_required_aspects', 'error',
          `${missing.length} Pflicht-Artikelmerkmal(e) fehlen: ${preview.join(', ')}${suffix}`,
          ['details.attributes'],
          `Ergaenzen Sie die fehlenden Artikelmerkmale: ${preview.join(', ')}${suffix}`
        ));
      }
    }
  }

  // Description — active content / off-eBay links
  if (desc && hasActiveContent(desc)) {
    errors.push(makeIssue(
      'description_active_content', 'error',
      'Beschreibung enthaelt aktiven Inhalt (Scripts/Formulare). Nicht zulaessig bei eBay.',
      ['details.short_description'],
      'Entfernen Sie alle Script-Tags, Formulare und Event-Handler aus der Beschreibung.'
    ));
  }
  if (desc && hasOffEbayLinks(desc)) {
    errors.push(makeIssue(
      'description_off_ebay_links', 'error',
      'Beschreibung enthaelt Links oder Kontaktdaten, die von eBay wegfuehren koennten.',
      ['details.short_description'],
      'Entfernen Sie externe URLs und E-Mail-Adressen aus der Beschreibung.'
    ));
  }

  // ── WARNINGS (non-blocking) ──

  // Title length (short)
  if (title && title.length < 40) {
    warnings.push(makeIssue(
      'title_short', 'warning',
      `Titel nutzt nur ${title.length} von 80 Zeichen.`,
      ['identification.name'],
      'Ergaenzen Sie relevante Suchbegriffe (Marke, Modell, Groesse, Farbe).'
    ));
  }

  // Description
  if (!desc) {
    warnings.push(makeIssue(
      'description_missing', 'warning',
      'Beschreibung fehlt. Eine gute Beschreibung erhoeht die Sichtbarkeit.',
      ['details.short_description'],
      'Fuegen Sie eine ausfuehrliche Produktbeschreibung hinzu.'
    ));
  } else if (desc.length < 100) {
    warnings.push(makeIssue(
      'description_short', 'warning',
      `Beschreibung ist nur ${desc.length} Zeichen lang.`,
      ['details.short_description'],
      'Erweitern Sie die Beschreibung mit relevanten Details.'
    ));
  }

  // EAN
  if (!ean) {
    warnings.push(makeIssue(
      'ean_missing', 'warning',
      'Keine EAN/GTIN vorhanden. In vielen eBay-Kategorien sind Produktkennzeichnungen Pflicht.',
      ['details.identifiers.ean'],
      'Ergaenzen Sie die EAN/GTIN des Produkts.'
    ));
  } else if (!isValidEan(ean)) {
    warnings.push(makeIssue(
      'ean_invalid', 'warning',
      `EAN/GTIN "${ean}" hat ein ungueltiges Format.`,
      ['details.identifiers.ean'],
      'Pruefen Sie die EAN/GTIN (8, 12, 13 oder 14 Ziffern).'
    ));
  }

  // Brand
  if (!brand) {
    warnings.push(makeIssue(
      'brand_missing', 'warning',
      'Marke fehlt. Die Marke ist fuer die meisten eBay-Kategorien ein Pflichtmerkmal.',
      ['identification.brand'],
      'Geben Sie die Marke des Produkts an.'
    ));
  }

  // Price
  if (sellPrice == null && (lowestPrice == null || lowestPrice <= 0)) {
    warnings.push(makeIssue(
      'price_missing', 'warning',
      'Kein Verkaufspreis gesetzt.',
      ['details.pricing.sellPrice'],
      'Setzen Sie einen wettbewerbsfaehigen Verkaufspreis.'
    ));
  }

  // ── INFO (best practice) ──

  // Images count
  if (images.length > 0 && images.length < 3) {
    info.push(makeIssue(
      'few_images', 'info',
      `Nur ${images.length} Bild(er). eBay erlaubt bis zu 24 Bilder.`,
      ['details.images'],
      'Mehr Bilder aus verschiedenen Perspektiven erhoehen die Conversion.'
    ));
  }

  // Attributes count
  if (attrCount < 5) {
    info.push(makeIssue(
      'few_attributes', 'info',
      `Nur ${attrCount} Artikelmerkmal(e) gepflegt.`,
      ['details.attributes'],
      'Mehr Artikelmerkmale verbessern die Auffindbarkeit ueber Filter und mobile Suche.'
    ));
  }

  // Key features
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.filter(Boolean)
    : [];
  if (features.length < 3) {
    info.push(makeIssue(
      'few_features', 'info',
      `Nur ${features.length} Highlight(s). Empfohlen sind mindestens 5.`,
      ['details.key_features'],
      'Fuegen Sie kurze, scanbare Produkt-Highlights hinzu.'
    ));
  }

  return buildResult('ebay', errors, warnings, info);
}

// ── Kaufland Validation Profile ──────────────────────────────────────

function validateKaufland(product) {
  const errors = [];
  const warnings = [];
  const info = [];

  const title = safeString(product?.identification?.name);
  const desc = safeString(
    product?.details?.short_description || product?.details?.description
  );
  const images = getImages(product);
  const ean = getEan(product);
  const brand = safeString(product?.identification?.brand);
  const attrs = getAttributeMap(product);
  const attrCount = countAttributes(attrs);
  const category = safeString(product?.identification?.category);
  const price = product?.details?.pricing;
  const sellPrice = price?.sellPrice;
  const lowestPrice = price?.lowest_price?.amount;

  // ── ERRORS ──

  // Title
  if (!title) {
    errors.push(makeIssue(
      'title_missing', 'error',
      'Titel fehlt. Ein Titel ist fuer Kaufland-Listings zwingend erforderlich.',
      ['identification.name'],
      'Geben Sie einen aussagekraeftigen Produkttitel ein.'
    ));
  }

  // Images
  if (images.length === 0) {
    errors.push(makeIssue(
      'images_missing', 'error',
      'Keine Bilder vorhanden. Kaufland erfordert mindestens 1 Bild.',
      ['details.images'],
      'Laden Sie mindestens ein Produktbild hoch.'
    ));
  }

  // EAN — Kaufland requires EAN for most categories
  if (!ean) {
    errors.push(makeIssue(
      'ean_missing', 'error',
      'Keine EAN/GTIN vorhanden. Kaufland erfordert eine EAN fuer die meisten Kategorien.',
      ['details.identifiers.ean'],
      'Ergaenzen Sie die EAN/GTIN des Produkts.'
    ));
  } else if (!isValidEan(ean)) {
    errors.push(makeIssue(
      'ean_invalid', 'error',
      `EAN/GTIN "${ean}" hat ein ungueltiges Format.`,
      ['details.identifiers.ean'],
      'Pruefen Sie die EAN/GTIN (8, 12, 13 oder 14 Ziffern).'
    ));
  }

  // ── WARNINGS ──

  // Description
  if (!desc) {
    warnings.push(makeIssue(
      'description_missing', 'warning',
      'Beschreibung fehlt.',
      ['details.short_description'],
      'Fuegen Sie eine ausfuehrliche Produktbeschreibung hinzu.'
    ));
  }

  // Brand
  if (!brand) {
    warnings.push(makeIssue(
      'brand_missing', 'warning',
      'Marke fehlt.',
      ['identification.brand'],
      'Geben Sie die Marke des Produkts an.'
    ));
  }

  // Category
  if (!category) {
    warnings.push(makeIssue(
      'category_missing', 'warning',
      'Keine Kategorie zugeordnet.',
      ['identification.category'],
      'Ordnen Sie dem Produkt eine Kategorie zu.'
    ));
  }

  // Price
  if (sellPrice == null && (lowestPrice == null || lowestPrice <= 0)) {
    warnings.push(makeIssue(
      'price_missing', 'warning',
      'Kein Verkaufspreis gesetzt.',
      ['details.pricing.sellPrice'],
      'Setzen Sie einen wettbewerbsfaehigen Verkaufspreis.'
    ));
  }

  // Title length
  if (title && title.length > 255) {
    warnings.push(makeIssue(
      'title_too_long', 'warning',
      `Titel ist ${title.length} Zeichen lang. Kaufland empfiehlt maximal 255 Zeichen.`,
      ['identification.name'],
      'Kuerzen Sie den Titel.'
    ));
  }

  // ── INFO ──

  if (attrCount < 3) {
    info.push(makeIssue(
      'few_attributes', 'info',
      `Nur ${attrCount} Attribut(e) gepflegt.`,
      ['details.attributes'],
      'Mehr Attribute verbessern die Auffindbarkeit.'
    ));
  }

  if (images.length > 0 && images.length < 3) {
    info.push(makeIssue(
      'few_images', 'info',
      `Nur ${images.length} Bild(er). Mehr Bilder erhoehen die Conversion.`,
      ['details.images'],
      'Laden Sie weitere Produktbilder hoch.'
    ));
  }

  return buildResult('kaufland', errors, warnings, info);
}

// ── Result Builder ───────────────────────────────────────────────────

function buildResult(marketplace, errors, warnings, info) {
  const totalChecks = errors.length + warnings.length + info.length;
  // Score: 100 - (errors * 15 + warnings * 5), clamped to [0, 100]
  // If no checks at all, score is 100 (nothing to complain about)
  const rawScore = totalChecks === 0
    ? 100
    : 100 - (errors.length * 15 + warnings.length * 5);
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    marketplace,
    score,
    ready: errors.length === 0,
    errors,
    warnings,
    info,
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      info: info.length,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────

const MARKETPLACE_VALIDATORS = {
  ebay: validateEbay,
  kaufland: validateKaufland,
};

const SUPPORTED_MARKETPLACES = Object.keys(MARKETPLACE_VALIDATORS);

/**
 * Validate a product against a specific marketplace profile.
 * @param {object} product — The product document
 * @param {string} marketplace — 'ebay' or 'kaufland'
 * @returns {object} Validation result
 */
function validateForMarketplace(product, marketplace) {
  const validator = MARKETPLACE_VALIDATORS[marketplace];
  if (!validator) {
    throw new Error(`Unknown marketplace: ${marketplace}`);
  }
  return validator(product);
}

/**
 * Validate a product against multiple marketplaces.
 * @param {object} product — The product document
 * @param {string[]} [marketplaces=['ebay','kaufland']] — Marketplaces to validate
 * @returns {object} { ebay: {...}, kaufland: {...} }
 */
function validateProduct(product, marketplaces) {
  const targets = Array.isArray(marketplaces) && marketplaces.length
    ? marketplaces
    : SUPPORTED_MARKETPLACES;

  const results = {};
  for (const mp of targets) {
    if (!MARKETPLACE_VALIDATORS[mp]) {
      throw new Error(`Unknown marketplace: ${mp}`);
    }
    results[mp] = validateForMarketplace(product, mp);
  }
  return results;
}

module.exports = {
  validateForMarketplace,
  validateProduct,
  SUPPORTED_MARKETPLACES,
};
