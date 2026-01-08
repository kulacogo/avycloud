const { normalizeSpaces } = require('./web-search-html');

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

/**
 * Evaluate whether a product is "eBay-ready" for AvyCloud.
 * This is intentionally stricter than "minimal identification".
 */
function evaluateEbayReady(product) {
  const issues = [];

  const title = safeString(product?.identification?.name);
  const desc = safeString(product?.details?.short_description || product?.details?.description);
  const category = safeString(product?.identification?.category);
  const features = Array.isArray(product?.details?.key_features) ? product.details.key_features.filter(Boolean) : [];
  const attrsCount = countAttributes(product?.details?.attributes);

  // eBay title policy in this system: 70–80 chars
  if (!title) issues.push('title_missing');
  else {
    if (title.length < 70) issues.push('title_too_short');
    if (title.length > 80) issues.push('title_too_long');
  }

  // Text quality (from review rules)
  if (!desc) issues.push('description_missing');
  else if (desc.length < 260) issues.push('description_too_short');

  if (features.length < 5) issues.push('highlights_too_few');

  // Category breadcrumb required (>=2 levels)
  if (!category || !category.includes('>')) issues.push('category_not_breadcrumb');

  if (!hasImages(product)) issues.push('images_missing');

  if (attrsCount < 5) issues.push('attributes_too_few');

  return {
    ok: issues.length === 0,
    issues,
    snapshot: {
      title_len: title.length,
      desc_len: desc.length,
      features: features.length,
      attrs: attrsCount,
      category: normalizeSpaces(category).slice(0, 120),
    },
  };
}

module.exports = {
  evaluateEbayReady,
};

