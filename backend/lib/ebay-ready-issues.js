function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

const EBAY_SOURCE_URLS = {
  bestMatch: 'https://www.ebay.de/help/selling/listings/listing-tips/optimising-listings-best-match?id=4166',
  seo: 'https://www.ebay.de/verkaeuferportal/angebote/optimieren/seo',
  itemSpecifics: 'https://www.ebay.de/verkaeuferportal/angebote/optimieren/artikelmerkmale',
  category: 'https://www.ebay.de/help/selling/listings/creating-managing-listings/adding-category-listing?id=4149',
  searchBrowseManipulation:
    'https://www.ebay.de/help/policies/listing-policies/search-browse-manipulation-policy?id=4243',
  pictures: 'https://www.ebay.de/help/selling/listings/bilder-zu-angeboten-hinzufgen?id=4148&ra=true',
  scriptsPolicy: 'https://www.ebay.de/help/policies/listing-policies/grundsatz-zur-verwendung-von-skriptsprachen?id=4247',
  contentPolicy:
    'https://www.ebay.de/help/policies/listing-policies/grundsatz-zur-nutzung-von-bildern-videos-und-anderen-inhalten?id=4240',
  pricing: 'https://www.ebay.de/help/selling/getting-started-selling/pricing-items?id=4133&ra=true',
  listingCreate: 'https://www.ebay.de/help/selling/listings/ein-angebot-erstellen?id=4105',
  taxonomyGetItemAspects:
    'https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getItemAspectsForCategory',
  browseSearch: 'https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search',
};

function normalizeCode(code) {
  const c = safeString(code);
  return c;
}

function isMissingRequiredAspectsCode(code = '') {
  return typeof code === 'string' && code.toLowerCase().startsWith('missing_required_aspects:');
}

function buildIssue(code, { missingRequiredAspects = null } = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const base = {
    code: normalized,
    severity: 'warn',
    message: normalized,
    fields: [],
    confidence: 0.95,
    source: 'rule',
    evidence_urls: [],
    source_url: null,
  };

  if (isMissingRequiredAspectsCode(normalized)) {
    const tail = normalized.replace(/^missing_required_aspects:\s*/i, '').trim();
    const missing = Array.isArray(missingRequiredAspects) ? missingRequiredAspects.filter(Boolean) : [];
    const list = missing.length ? missing.slice(0, 25).join(', ') : tail;
    const more = missing.length > 25 ? ` … (+${missing.length - 25} mehr)` : '';
    return {
      ...base,
      code: 'missing_required_aspects',
      severity: 'error',
      fields: [
        'details.categoryId',
        ...missing.slice(0, 25).map((k) => `details.attributes.${safeString(k)}`),
        'details.attributes',
      ],
      message: list ? `Pflicht-Artikelmerkmale (Item Specifics) fehlen/leer: ${list}${more}` : 'Pflicht-Artikelmerkmale (Item Specifics) fehlen/leer.',
      source_url: EBAY_SOURCE_URLS.itemSpecifics,
    };
  }

  // Title policy / buyer-search alignment
  const TITLE_ERROR_CODES = new Set([
    'title_missing',
    'title_too_short',
    'title_too_long',
    'priority_a_missing_in_title',
    'priority_a_source_missing',
    'brand_missing',
    'product_type_missing',
    'model_or_mpn_missing',
  ]);
  const TITLE_WARN_CODES = new Set([
    'title_starts_with_symbol',
    'title_starts_with_marketing',
    'priority_a_not_in_first_60',
    'order_priority_a',
    'order_brand_after_producttype',
    'order_producttype_after_model',
    'order_brand_after_model',
    'order_model_after_producttype',
    'duplicate_word',
  ]);

  if (TITLE_ERROR_CODES.has(normalized) || TITLE_WARN_CODES.has(normalized)) {
    const severity = TITLE_ERROR_CODES.has(normalized) ? 'error' : 'warn';
    const src = normalized === 'title_too_long' ? EBAY_SOURCE_URLS.bestMatch : EBAY_SOURCE_URLS.seo;
    return {
      ...base,
      severity,
      fields: ['identification.name'],
      message:
        severity === 'error'
          ? 'Titel ist nicht eBay-/käufergerecht (≤80 Zeichen, relevante Suchbegriffe wie Marke/Typ/Modell/Größe/Farbe).'
          : 'Titel kann für eBay-Suche verbessert werden (Mobile-first: wichtigste Suchbegriffe früh, keine irrelevanten Wörter).',
      source_url: src,
    };
  }

  // Description
  if (normalized === 'description_missing' || normalized === 'description_too_short') {
    return {
      ...base,
      severity: normalized === 'description_missing' ? 'warn' : 'info',
      fields: ['details.short_description', 'details.description'],
      message: 'Beschreibung fehlt/ist sehr kurz. Vollständige, korrekte Angaben erhöhen Sichtbarkeit und reduzieren Rückfragen.',
      source_url: EBAY_SOURCE_URLS.bestMatch,
    };
  }

  // Images
  if (normalized === 'images_missing') {
    return {
      ...base,
      severity: 'error',
      fields: ['details.images'],
      message: 'Bilder fehlen. eBay-Angebote müssen mindestens ein Bild enthalten.',
      source_url: EBAY_SOURCE_URLS.pictures,
    };
  }

  // Category breadcrumb (best practice + correctness)
  if (normalized === 'category_not_breadcrumb') {
    return {
      ...base,
      severity: 'warn',
      fields: ['identification.category', 'details.categoryId'],
      message: 'Kategorie ist kein Breadcrumb. Eine passende Kategorie verbessert Auffindbarkeit (viele Käufer filtern nach Kategorien).',
      source_url: EBAY_SOURCE_URLS.category,
    };
  }

  // Attributes quantity (best practice)
  if (normalized === 'attributes_too_few') {
    return {
      ...base,
      severity: 'info',
      fields: ['details.attributes'],
      message: 'Es sind nur wenige Attribute/Artikelmerkmale gepflegt. Vollständige Artikelmerkmale erhöhen Sichtbarkeit (Filter/Mobile).',
      source_url: EBAY_SOURCE_URLS.itemSpecifics,
    };
  }

  // Highlights (AvyCloud best practice; eBay has no explicit field)
  if (normalized === 'highlights_too_few') {
    return {
      ...base,
      severity: 'info',
      fields: ['details.key_features'],
      message: 'Zu wenige Highlights. Kurze, scanbare Vorteile helfen Käufern beim schnellen Vergleich.',
      source_url: EBAY_SOURCE_URLS.bestMatch,
    };
  }

  // Pricing (AvyCloud requirement for “eBay-ready”)
  if (normalized === 'price_missing') {
    return {
      ...base,
      severity: 'error',
      fields: ['details.pricing.lowest_price'],
      message: 'Preis fehlt. Ein wettbewerbsfähiger Preis verbessert Verkaufschancen; Vergleich mit ähnlichen/beendeten Angeboten hilft.',
      source_url: EBAY_SOURCE_URLS.pricing,
    };
  }
  if (normalized === 'price_evidence_missing') {
    return {
      ...base,
      severity: 'error',
      fields: ['details.pricing.lowest_price.sources'],
      message: 'Preis hat keine Evidence-URL(s). Für AvyCloud-Automation werden Preise nur mit Quellen gespeichert.',
      source_url: EBAY_SOURCE_URLS.browseSearch,
    };
  }

  // Description policy checks
  if (normalized === 'description_active_content') {
    return {
      ...base,
      severity: 'error',
      fields: ['details.short_description', 'details.description'],
      message: 'Beschreibung enthält aktiven Inhalt (z.B. Skripte/Formulare). Das ist in eBay-Listings nicht zulässig.',
      source_url: EBAY_SOURCE_URLS.scriptsPolicy,
    };
  }
  if (normalized === 'description_off_ebay_links') {
    return {
      ...base,
      severity: 'error',
      fields: ['details.short_description', 'details.description'],
      message: 'Beschreibung enthält Links/Kontaktinfos, die Käufer von eBay weglenken könnten (Policy). Bitte entfernen.',
      source_url: EBAY_SOURCE_URLS.contentPolicy,
    };
  }

  return base;
}

function buildEbayReadyIssuesDetailed(issueCodes = [], opts = {}) {
  const codes = Array.isArray(issueCodes) ? issueCodes : [];
  const out = [];
  for (const code of codes) {
    const issue = buildIssue(code, opts);
    if (!issue) continue;
    out.push(issue);
  }
  return out;
}

function countSeverities(issuesDetailed = []) {
  const out = { error: 0, warn: 0, info: 0 };
  const arr = Array.isArray(issuesDetailed) ? issuesDetailed : [];
  for (const i of arr) {
    const sev = safeString(i?.severity);
    if (sev === 'error') out.error += 1;
    else if (sev === 'warn') out.warn += 1;
    else if (sev === 'info') out.info += 1;
  }
  return out;
}

module.exports = {
  EBAY_SOURCE_URLS,
  buildEbayReadyIssuesDetailed,
  countSeverities,
};

