const { normalizeSpaces } = require('./web-search-html');
const { validateTitleToPolicy, inferTitleCategory } = require('./title-policy');
const { getRulebookConfigCached } = require('./rulebook-config');
const { getRequiredAspects } = require('./ebay-taxonomy');
const { buildEbayReadyIssuesDetailed, countSeverities } = require('./ebay-ready-issues');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function countAttributes(attrs) {
  if (!attrs) return 0;
  if (Array.isArray(attrs)) return attrs.filter((x) => x && x.key && x.value).length;
  if (typeof attrs === 'object') return Object.keys(attrs).filter((k) => k && attrs[k] != null && String(attrs[k]).trim() !== '').length;
  return 0;
}

function hasImages(product) {
  const imgs = product?.details?.images;
  return (
    Array.isArray(imgs) &&
    imgs.some((img) => img && (img.url_or_base64 || img.url || img.href))
  );
}

function extractListingText(product) {
  return safeString(product?.details?.short_description || product?.details?.description);
}

function hasActiveContent(text = '') {
  const s = String(text || '');
  return (
    /<\s*script\b/i.test(s) ||
    /javascript\s*:/i.test(s) ||
    /<\s*iframe\b/i.test(s) ||
    /<\s*form\b/i.test(s) ||
    /\bon\w+\s*=\s*["']/i.test(s)
  );
}

function hasOffEbayLinksOrContacts(text = '') {
  const s = String(text || '');
  if (/\bhttps?:\/\/\S+/i.test(s)) return true;
  if (/\bwww\.[^\s<]+/i.test(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
  return false;
}

function getPriceStatus(product) {
  const lp = product?.details?.pricing?.lowest_price;
  const amountRaw = lp?.amount;
  const amount =
    typeof amountRaw === 'number' && Number.isFinite(amountRaw)
      ? amountRaw
      : typeof amountRaw === 'string'
        ? Number(amountRaw)
        : NaN;
  const sources = Array.isArray(lp?.sources) ? lp.sources.filter(Boolean) : [];
  const hasEvidence = sources.some((s) => s && typeof s.url === 'string' && s.url.trim());
  const ok = lp && Number.isFinite(amount) && amount >= 1 && hasEvidence;
  return { ok, amount: Number.isFinite(amount) ? amount : null, hasEvidence, sourceCount: sources.length };
}

/**
 * Evaluate whether a product is "eBay-ready" for AvyCloud.
 * This is intentionally stricter than "minimal identification".
 */
function evaluateEbayReady(product, options = {}) {
  const force = Boolean(options && typeof options === 'object' && options.force === true);
  const ignorePrice = Boolean(options && typeof options === 'object' && options.ignorePrice === true);
  const enabled = (process.env.QUALITY_GATE_ENABLED || '').toString().trim().toLowerCase();
  const gateDisabled = enabled === '0' || enabled === 'false' || enabled === 'no';
  if (gateDisabled && !force) {
    // Gate explicitly disabled — return lightweight snapshot for UI.
    const title = safeString(product?.identification?.name);
    const desc = extractListingText(product);
    const category = safeString(product?.identification?.category);
    const features = Array.isArray(product?.details?.key_features) ? product.details.key_features.filter(Boolean) : [];
    const attrsCount = countAttributes(product?.details?.attributes);
    const price = getPriceStatus(product);
    return {
      ok: true,
      issues: [],
      issuesDetailed: [],
      snapshot: {
        title_len: title.length,
        desc_len: desc.length,
        features: features.length,
        attrs: attrsCount,
        category: normalizeSpaces(category).slice(0, 120),
        required_aspects_missing: 0,
        price_ok: ignorePrice ? true : Boolean(price.ok),
      },
    };
  }
  const issues = [];

  const title = safeString(product?.identification?.name);
  const desc = extractListingText(product);
  const category = safeString(product?.identification?.category);
  const features = Array.isArray(product?.details?.key_features) ? product.details.key_features.filter(Boolean) : [];
  const attrsCount = countAttributes(product?.details?.attributes);
  const price = getPriceStatus(product);

  // Title policy (Titel_Regeln.csv via rulebook config):
  // - bucket-specific minLen/softMax/maxLen
  // - mobile-first: Priority A must be inside first 60 chars
  const cfg = getRulebookConfigCached();
  const bucket = inferTitleCategory(product);
  const rule = (cfg?.title?.rulesBySchema && cfg.title.rulesBySchema[bucket]) || cfg?.title || {};
  const minLen = Number(rule?.minLen || 65);
  const maxLen = Number(rule?.maxLen || 80);
  const mobileMaxLen = Number(rule?.mobileMaxLen || 60);
  const titlePolicyIssues = validateTitleToPolicy(product, title, { minLen, maxLen, mobileMaxLen });
  titlePolicyIssues.forEach((code) => {
    if (code && !issues.includes(code)) issues.push(code);
  });
  // Keep legacy "too_short" signal only for extremely short titles.
  if (title && title.length > 0 && title.length < 20 && !issues.includes('title_too_short')) {
    issues.push('title_too_short');
  }

  // Text quality (from review rules)
  if (!desc) issues.push('description_missing');
  else if (desc.length < 260) issues.push('description_too_short');

  if (features.length < 5) issues.push('highlights_too_few');

  // Category breadcrumb required (>=2 levels)
  if (!category || !category.includes('>')) issues.push('category_not_breadcrumb');

  if (!hasImages(product)) issues.push('images_missing');

  if (attrsCount < 5) issues.push('attributes_too_few');

  // Description must not include active content or off-eBay links/contacts.
  if (desc) {
    if (hasActiveContent(desc)) issues.push('description_active_content');
    if (hasOffEbayLinksOrContacts(desc)) issues.push('description_off_ebay_links');
  }

  // Price must be present (>=1) and have evidence URLs (AvyCloud invariant).
  if (!ignorePrice) {
    if (!price.ok) {
      if (price.amount != null && price.amount >= 1 && !price.hasEvidence) issues.push('price_evidence_missing');
      else issues.push('price_missing');
    }
  }

  // Required eBay item specifics (Pflichtmerkmale) must not be empty.
  const catId = safeString(product?.details?.categoryId || product?.details?.ebayCategoryId);
  const required = catId ? getRequiredAspects(catId) : [];
  const attrsRaw =
    product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const attrs =
    attrsRaw && typeof attrsRaw === 'object' && !Array.isArray(attrsRaw) ? attrsRaw : {};
  const attrsLower = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = safeString(k).toLowerCase();
    if (!key) continue;
    const val = v == null ? '' : String(v).trim();
    if (!val) continue;
    // Prefer first non-empty value per normalized key.
    if (attrsLower[key]) continue;
    attrsLower[key] = val;
  }
  let missingRequiredCount = 0;
  let missingRequiredAspects = [];
  if (Array.isArray(required) && required.length) {
    const missing = required.filter((key) => {
      const k = typeof key === 'string' ? key.trim() : '';
      if (!k) return false;
      const direct = attrs[k];
      if (direct != null && String(direct).trim() !== '') return false;
      const lowerVal = attrsLower[String(k).trim().toLowerCase()];
      return !lowerVal;
    });
    if (missing.length) {
      missingRequiredCount = missing.length;
      missingRequiredAspects = missing.slice(0, 80);
      const preview = missing.slice(0, 15);
      const suffix = missing.length > preview.length ? ` … (+${missing.length - preview.length} mehr)` : '';
      issues.push(`missing_required_aspects: ${preview.join(', ')}${suffix}`);
    }
  }

  const issuesDetailed = buildEbayReadyIssuesDetailed(issues, { missingRequiredAspects });
  const severity = countSeverities(issuesDetailed);

  return {
    ok: severity.error === 0,
    issues,
    issuesDetailed,
    snapshot: {
      title_len: title.length,
      desc_len: desc.length,
      features: features.length,
      attrs: attrsCount,
      category: normalizeSpaces(category).slice(0, 120),
      required_aspects_missing: missingRequiredCount,
      price_ok: ignorePrice ? true : Boolean(price.ok),
      issue_counts: severity,
    },
    missingRequiredAspects,
  };
}

module.exports = {
  evaluateEbayReady,
  getPriceStatus,
};

