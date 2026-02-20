const { isValidGtin, normalizeDigits } = require('./gtin');
const { searchWeb, fetchPageText, normalizeSpaces } = require('./web-search-html');

const MARKETPLACE_HOST_RE = /(amazon\.|ebay\.|kaufland\.|aliexpress\.|temu\.|wish\.|etsy\.)/i;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function tokenizeAnchors({ brand = '', mpn = '', title = '' } = {}) {
  const anchors = [];
  const b = safeString(brand);
  const m = safeString(mpn);
  if (b) anchors.push({ type: 'brand', value: b, strong: true });
  if (m) anchors.push({ type: 'mpn', value: m, strong: true });

  // Use 2-3 stable title tokens to avoid overfitting
  const titleTokens = normalizeSpaces(title)
    .replace(/[^\p{L}\p{N}\s\-+./]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 4)
    .slice(0, 3);
  titleTokens.forEach((t) => anchors.push({ type: 'title', value: t, strong: false }));
  return anchors;
}

function findEvidenceInText({ barcode, text = '', anchors = [], host = '' }) {
  const normalizedCode = normalizeDigits(String(barcode || ''));
  if (!normalizedCode || !isValidGtin(normalizedCode)) {
    return { ok: false, reason: 'invalid_barcode', score: 0, matchedAnchors: [] };
  }
  const hay = String(text || '').toLowerCase();
  if (!hay.includes(normalizedCode)) {
    return { ok: false, reason: 'barcode_not_found', score: 0, matchedAnchors: [] };
  }

  const matched = [];
  for (const a of anchors) {
    const needle = String(a.value || '').toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) matched.push(a);
  }

  const hasStrong = matched.some((m) => m.strong);
  const marketplace = MARKETPLACE_HOST_RE.test(host || '');

  // Safety:
  // - For marketplace pages, require stronger evidence (at least one strong anchor),
  //   because listings can be wrong/mismatched.
  // - For non-marketplace pages, allow either strong anchor OR multiple weak anchors.
  const ok = marketplace ? hasStrong : hasStrong || matched.length >= 2;

  return {
    ok,
    reason: seenReason({ marketplace, hasStrong, matchedCount: matched.length }),
    score: (hasStrong ? 3 : 0) + matched.length,
    matchedAnchors: matched.map((m) => ({ type: m.type, value: m.value })),
  };
}

function seenReason({ marketplace, hasStrong, matchedCount }) {
  if (marketplace && !hasStrong) return 'marketplace_requires_strong_anchor';
  if (!marketplace && !hasStrong && matchedCount < 2) return 'insufficient_anchors';
  return 'ok';
}

function buildQuery({ barcode, brand = '', mpn = '', title = '' }) {
  const parts = [barcode, brand, mpn].filter(Boolean);
  if (!parts.length) {
    return normalizeSpaces(`${title} ${barcode}`.trim());
  }
  return normalizeSpaces(parts.join(' '));
}

async function confirmBarcodeWithWeb({
  barcode,
  brand = '',
  mpn = '',
  title = '',
  locale = 'de-DE',
  maxSearchResults = 6,
  maxPages = 4,
} = {}) {
  const code = normalizeDigits(String(barcode || ''));
  if (!code || ![8, 12, 13, 14].includes(code.length) || !isValidGtin(code)) {
    return { ok: false, barcode: code, evidence: { reason: 'invalid_or_unsupported' } };
  }

  const query = buildQuery({ barcode: code, brand, mpn, title });
  const anchors = tokenizeAnchors({ brand, mpn, title });

  const search = await searchWeb(query, { limit: Math.max(1, maxSearchResults), locale });
  const results = Array.isArray(search?.results) ? search.results : [];

  const checked = [];
  const hits = [];

  for (const r of results.slice(0, maxPages)) {
    const url = r?.url;
    if (!url) continue;
    let host = '';
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      host = '';
    }
    const page = await fetchPageText(url, { timeoutMs: 25_000 });
    const assessment = findEvidenceInText({
      barcode: code,
      text: page.ok ? page.text : '',
      anchors,
      host,
    });
    const entry = {
      url,
      host,
      ok: Boolean(page.ok),
      status: page.status,
      via: page.via,
      assessment,
    };
    checked.push(entry);
    if (page.ok && assessment.ok) {
      hits.push(entry);
    }
  }

  // Acceptance:
  // - Prefer at least one non-marketplace hit.
  // - If only marketplace hits exist, require at least 2 independent marketplace hosts.
  const nonMarket = hits.filter((h) => !MARKETPLACE_HOST_RE.test(h.host || ''));
  const uniqHosts = Array.from(new Set(hits.map((h) => h.host).filter(Boolean)));
  const ok =
    nonMarket.length >= 1 ||
    (hits.length >= 2 && uniqHosts.length >= 2 && hits.every((h) => MARKETPLACE_HOST_RE.test(h.host || '')));

  return {
    ok,
    barcode: code,
    evidence: {
      query,
      engine: search.engine,
      searchUrl: search.url,
      results: results.slice(0, maxPages).map((x) => ({ title: x.title || '', url: x.url })),
      checked,
      hits,
      accepted_by: ok ? (nonMarket.length ? 'non_marketplace_hit' : 'two_marketplace_hosts') : 'no_sufficient_evidence',
    },
  };
}

async function filterBarcodesByWebConfirm({
  barcodes = [],
  brand = '',
  mpn = '',
  title = '',
  locale = 'de-DE',
  maxCandidates = 3,
} = {}) {
  const normalized = Array.from(
    new Set(
      (barcodes || [])
        .map((b) => normalizeDigits(String(b || '')))
        .filter((c) => c && [8, 12, 13, 14].includes(c.length) && isValidGtin(c))
    )
  );
  const confirmed = [];
  const trace = [];

  for (const code of normalized.slice(0, maxCandidates)) {
    const res = await confirmBarcodeWithWeb({ barcode: code, brand, mpn, title, locale });
    trace.push(res);
    if (res.ok) confirmed.push(code);
  }

  return { confirmed, trace };
}

module.exports = {
  confirmBarcodeWithWeb,
  filterBarcodesByWebConfirm,
  findEvidenceInText,
};

