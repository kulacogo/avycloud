const { decodeHtmlEntitiesDeep } = require('./html-entities');

// Strict governance: these eBay root categories must not be used in AvyCloud.
// They are treated as "non-existent" for this app (explicit business rule).
const BANNED_EBAY_CATEGORY_ROOTS = Object.freeze([
  'Antiquitäten & Kunst',
  'Briefmarken',
  'Feinschmecker',
  'Filme & Serien',
  'Immobilien',
  'Münzen',
  'Business & Industrie',
  'Sammeln & Seltenes',
]);

// Soft roots — category is allowed but requires additional evidence (signals)
// from the product before being accepted by the resolver. Prevents accidental
// mis-categorisation into broad catch-all roots.
const EVIDENCE_REQUIRED_ROOTS = Object.freeze([
  'Bücher & Zeitschriften',
]);

const normalizeKey = (value) =>
  decodeHtmlEntitiesDeep(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const BANNED_EBAY_CATEGORY_ROOTS_KEYS = new Set(BANNED_EBAY_CATEGORY_ROOTS.map(normalizeKey));
const EVIDENCE_REQUIRED_ROOTS_KEYS = new Set(EVIDENCE_REQUIRED_ROOTS.map(normalizeKey));

function getEbayCategoryBreadcrumbRoot(breadcrumb = '') {
  const decoded = decodeHtmlEntitiesDeep(breadcrumb);
  const root = decoded
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return root ? String(root).trim() : '';
}

function isBannedEbayCategoryRoot(root = '') {
  const key = normalizeKey(root);
  if (!key) return false;
  return BANNED_EBAY_CATEGORY_ROOTS_KEYS.has(key);
}

function isBannedEbayBreadcrumb(breadcrumb = '') {
  const root = getEbayCategoryBreadcrumbRoot(breadcrumb);
  return isBannedEbayCategoryRoot(root);
}

function needsEvidenceRoot(breadcrumb = '') {
  const root = getEbayCategoryBreadcrumbRoot(breadcrumb);
  const key = normalizeKey(root);
  if (!key) return false;
  return EVIDENCE_REQUIRED_ROOTS_KEYS.has(key);
}

module.exports = {
  BANNED_EBAY_CATEGORY_ROOTS,
  EVIDENCE_REQUIRED_ROOTS,
  getEbayCategoryBreadcrumbRoot,
  isBannedEbayCategoryRoot,
  isBannedEbayBreadcrumb,
  needsEvidenceRoot,
};

