function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeBreadcrumb(value) {
  const raw = safeString(value).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const segments = raw
    .split('>')
    .map((segment) => safeString(segment))
    .filter(Boolean);
  return segments.join(' > ');
}

function normalizeObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input;
}

function findKategorieValue(details = {}) {
  const attrs = normalizeObject(details.attributes);
  if (attrs.Kategorie != null) {
    return normalizeBreadcrumb(attrs.Kategorie);
  }
  const key = Object.keys(attrs).find((k) => safeString(k).toLowerCase() === 'kategorie') || null;
  if (!key) return '';
  return normalizeBreadcrumb(attrs[key]);
}

function collectBaselinkerCategoryCandidates(details = {}) {
  const out = [];
  const push = (source, value) => {
    const normalized = normalizeBreadcrumb(value);
    if (!normalized) return;
    out.push({ source, value: normalized });
  };

  const legacy = normalizeObject(details.baselinkerCategories);
  // Canonical source priority for single-inventory mode:
  // 1) legacy key 78659 (authoritative inventory taxonomy)
  // 2) explicit baselinkerCategoryPath
  // 3) remaining legacy keys / attribute fallback
  if (legacy['78659'] != null) {
    push('details.baselinkerCategories.78659', legacy['78659']);
  }
  push('details.baselinkerCategoryPath', details.baselinkerCategoryPath);
  if (legacy['91387'] != null) {
    push('details.baselinkerCategories.91387', legacy['91387']);
  }
  Object.keys(legacy)
    .filter((key) => key !== '78659' && key !== '91387')
    .sort((a, b) => a.localeCompare(b, 'de-DE'))
    .forEach((key) => {
      push(`details.baselinkerCategories.${key}`, legacy[key]);
    });

  push('details.attributes.Kategorie', findKategorieValue(details));
  return out;
}

function resolveBaselinkerCategory(details = {}) {
  const candidates = collectBaselinkerCategoryCandidates(details);
  const selected = candidates.length ? candidates[0] : null;
  const distinctValues = Array.from(new Set(candidates.map((entry) => entry.value)));
  return {
    value: selected ? selected.value : '',
    source: selected ? selected.source : 'missing',
    candidates,
    distinctValues,
    hasConflict: distinctValues.length > 1,
  };
}

function buildBaselinkerCategoryDetails(details = {}) {
  const normalizedDetails = normalizeObject(details);
  const resolved = resolveBaselinkerCategory(normalizedDetails);
  if (!resolved.value) {
    return {
      details: normalizedDetails,
      changed: false,
      ...resolved,
    };
  }

  const next = { ...normalizedDetails };
  let changed = false;

  const currentPath = normalizeBreadcrumb(next.baselinkerCategoryPath);
  if (currentPath !== resolved.value) {
    next.baselinkerCategoryPath = resolved.value;
    changed = true;
  }

  const legacy = normalizeObject(next.baselinkerCategories);
  const current78659 = normalizeBreadcrumb(legacy['78659']);
  if (current78659 !== resolved.value) {
    next.baselinkerCategories = {
      ...legacy,
      '78659': resolved.value,
    };
    changed = true;
  }

  return {
    details: next,
    changed,
    ...resolved,
  };
}

module.exports = {
  normalizeBreadcrumb,
  collectBaselinkerCategoryCandidates,
  resolveBaselinkerCategory,
  buildBaselinkerCategoryDetails,
};
