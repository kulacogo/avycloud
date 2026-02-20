import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  bulkApplyEbayGapActions,
  bulkPrepareEbayItemSpecifics,
  bulkPrepareEbayMissingSpecifics,
  fetchEbayGaps,
  fetchEbayLiveListingDetail,
  fetchEbayLiveListings,
  fetchEbayTradingStatus,
  generateEbayReports,
  rebuildEbayGaps,
  rebuildEbayListingLinks,
  runEbaySyncApply,
  runEbaySyncDryRun,
  syncEbayLiveListings,
} from '../../api/client';
import { EbayListingDetail, EbayListingRow, EbaySyncApplyResult, EbaySyncDryRunResult } from '../../types';

/* ═══════════════════════════════════════════════════════════
   Utility helpers (pure functions, no rendering)
   ═══════════════════════════════════════════════════════════ */

const safeString = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim();
  }
  if (value instanceof Error) {
    return safeString(value.message || value.name);
  }
  if (typeof value === 'object') {
    const nestedMessage = safeString((value as Record<string, any>)?.message);
    if (nestedMessage) return nestedMessage;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value).trim();
    }
  }
  return String(value).trim();
};

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  deg: '\u00B0',
  euro: '\u20AC',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  middot: '\u00B7',
  micro: '\u00B5',
  plusmn: '\u00B1',
  sup2: '\u00B2',
  sup3: '\u00B3',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  times: '\u00D7',
  divide: '\u00F7',
  Auml: '\u00C4',
  auml: '\u00E4',
  Ouml: '\u00D6',
  ouml: '\u00F6',
  Uuml: '\u00DC',
  uuml: '\u00FC',
  szlig: '\u00DF',
};

const decodeEntityToken = (token: string): string => {
  if (Object.prototype.hasOwnProperty.call(HTML_ENTITY_MAP, token)) {
    return HTML_ENTITY_MAP[token];
  }
  if (/^#x[0-9a-f]+$/i.test(token)) {
    const codePoint = Number.parseInt(token.slice(2), 16);
    if (Number.isFinite(codePoint) && codePoint > 0) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return `&${token};`;
      }
    }
  }
  if (/^#[0-9]+$/.test(token)) {
    const codePoint = Number.parseInt(token.slice(1), 10);
    if (Number.isFinite(codePoint) && codePoint > 0) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return `&${token};`;
      }
    }
  }
  return `&${token};`;
};

const decodeHtmlEntities = (value: any): string => {
  let current = safeString(value);
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(/&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g, (_, token: string) =>
      decodeEntityToken(token)
    );
    if (next === current) break;
    current = next;
  }
  return current;
};

const toDisplayValue = (value: any): string => {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) {
    return value
      .map((entry) => decodeHtmlEntities(safeString(entry)))
      .filter(Boolean)
      .join(', ') || '-';
  }
  if (typeof value === 'string') {
    const plain = decodeHtmlEntities(value);
    return plain || '-';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return decodeHtmlEntities(safeString(value)) || '-';
};

const isTechnicalCategoryKey = (key: any): boolean => {
  const normalized = safeString(key).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!normalized) return false;
  return (
    normalized === 'ebaycategoryid' ||
    normalized === 'ebaycategorypath' ||
    normalized === 'categoryid' ||
    normalized === 'categorypath' ||
    normalized === 'categorybreadcrumb' ||
    normalized === 'category' ||
    normalized.endsWith('categoryid') ||
    normalized.endsWith('categorypath')
  );
};

const toUiErrorMessage = (error: any, fallback: string): string => {
  const fromMessage = safeString(error?.message);
  if (fromMessage) return fromMessage;
  const fromError = safeString(error);
  return fromError || fallback;
};

const formatDateTime = (value?: any): string => {
  if (value == null || value === '') return '-';
  if (typeof value?.toDate === 'function') {
    try {
      const date = value.toDate();
      if (date instanceof Date && Number.isFinite(date.getTime())) {
        return new Intl.DateTimeFormat('de-DE', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date);
      }
    } catch {
      // fall through to generic conversion
    }
  }
  const iso = safeString(value);
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const extractProductSpecifics = (product: Record<string, any> | null | undefined): Record<string, string> => {
  if (!product) return {};
  const out: Record<string, string> = {};

  const applyObject = (obj: Record<string, any>) => {
    Object.entries(obj).forEach(([rawKey, rawValue]) => {
      const key = safeString(rawKey);
      if (!key) return;
      if (isTechnicalCategoryKey(key)) return;
      const value = toDisplayValue(rawValue);
      if (value && value !== '-') out[key] = value;
    });
  };

  const applyArray = (arr: any[]) => {
    arr.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const key = safeString(entry.name || entry.key || entry.attribute);
      if (!key) return;
      const value = toDisplayValue(entry.value || entry.values || entry.val);
      if (value && value !== '-') out[key] = value;
    });
  };

  const candidates = [
    product.details?.attributes,
    product.details?.identifiers,
    product.details?.itemSpecifics,
    product.classification?.attributes,
    product.identifiers,
    product.marketplace?.ebay?.itemSpecifics,
    product.marketplace?.ebay?.identifiers,
    product.itemSpecifics,
  ];

  candidates.forEach((candidate) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
      applyArray(candidate);
      return;
    }
    if (typeof candidate === 'object') {
      applyObject(candidate as Record<string, any>);
    }
  });

  return out;
};

const normalizeKeyToken = (value: any): string =>
  decodeHtmlEntities(value)
    .toLowerCase()
    .replace(/\u00E4/g, 'ae')
    .replace(/\u00F6/g, 'oe')
    .replace(/\u00FC/g, 'ue')
    .replace(/\u00DF/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');

const normalizeSpecificKeyToken = (value: any): string => {
  const token = normalizeKeyToken(value);
  if (!token) return '';
  if (token === 'groesse' || token === 'size') return 'size';
  if (
    token === 'hoehe' ||
    token === 'height' ||
    token === 'dicke' ||
    token === 'staerke' ||
    token === 'materialstaerke' ||
    token === 'thickness'
  ) {
    return 'hoehe';
  }
  if (
    token === 'marke' ||
    token === 'brand' ||
    token === 'hersteller' ||
    token === 'manufacturer' ||
    token === 'herstellername' ||
    token === 'manufacturername'
  ) {
    return 'brand';
  }
  if (token === 'ean' || token === 'gtin') return 'gtin';
  if (token.includes('fahrradtyp')) return 'fahrradtyp';
  if (token.includes('fahrradgroesse') || token.includes('fahrradsize')) return 'fahrradgroesse';
  return token;
};

const normalizeCompareText = (value: any): string => safeString(value).toLowerCase().replace(/\s+/g, ' ').trim();

const stripHtmlToText = (value: any): string =>
  safeString(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const normalizeRichTextForCompare = (value: any): string =>
  normalizeCompareText(decodeHtmlEntities(stripHtmlToText(value)));

const normalizeHighlightLine = (value: any): string =>
  decodeHtmlEntities(stripHtmlToText(value))
    .replace(/^[\u2022\u00B7*\-\u2013\u2014]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeHighlightList = (values: any[] = []): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  values.forEach((entry) => {
    const line = normalizeHighlightLine(entry);
    if (!line) return;
    const key = normalizeCompareText(line);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  });
  return out;
};

const parseListItemsFromHtml = (html: any): string[] => {
  const source = safeString(html);
  if (!source) return [];
  const items: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match = re.exec(source);
  while (match) {
    const line = normalizeHighlightLine(match[1]);
    if (line) items.push(line);
    match = re.exec(source);
  }
  return normalizeHighlightList(items);
};

type EbayTemplateDescriptionParts = {
  isTemplate: boolean;
  descriptionRaw: string;
  descriptionText: string;
  highlights: string[];
};

const extractEbayTemplateDescriptionParts = (descriptionHtml: any): EbayTemplateDescriptionParts => {
  const raw = safeString(descriptionHtml);
  const out: EbayTemplateDescriptionParts = {
    isTemplate: /START TrendOcean eBay Listing Template/i.test(raw),
    descriptionRaw: raw,
    descriptionText: normalizeRichTextForCompare(raw),
    highlights: [],
  };
  if (!raw) return out;

  const highlightsMatch = raw.match(
    /<div[^>]*class=["'][^"']*section-title[^"']*["'][^>]*>\s*Produkt-Highlights\s*<\/div>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i
  );
  if (highlightsMatch && highlightsMatch[1]) {
    out.highlights = parseListItemsFromHtml(highlightsMatch[1]);
  }

  const descriptionHeaderMatch = raw.match(
    /<div[^>]*class=["'][^"']*section-title[^"']*["'][^>]*>\s*Produktbeschreibung\s*<\/div>/i
  );
  if (descriptionHeaderMatch && typeof descriptionHeaderMatch.index === 'number') {
    const start = descriptionHeaderMatch.index + descriptionHeaderMatch[0].length;
    const afterHeader = raw.slice(start);
    const beforeCta = afterHeader.split(/<div[^>]*class=["'][^"']*cta[^"']*["'][^>]*>/i)[0] || afterHeader;
    const innerDiv = beforeCta.match(/<div[^>]*>([\s\S]*?)<\/div>/i);
    out.descriptionRaw = safeString(innerDiv ? innerDiv[1] : beforeCta);
    out.descriptionText = normalizeRichTextForCompare(out.descriptionRaw);
  }

  return out;
};

const extractProductHighlights = (product: Record<string, any> | null): string[] => {
  if (!product) return [];
  const details = product?.details || {};
  const lines: string[] = [];
  const listCandidates = [details?.key_features, details?.highlights, product?.key_features, product?.highlights];
  const textCandidates = [details?.key_features_text, details?.highlights_text];

  listCandidates.forEach((candidate) => {
    (Array.isArray(candidate) ? candidate : []).forEach((entry) => {
      const line = normalizeHighlightLine(entry);
      if (line) lines.push(line);
    });
  });
  textCandidates.forEach((candidate) => {
    const raw = safeString(candidate);
    if (!raw) return;
    raw
      .split(/\r?\n|\|/)
      .map((line) => normalizeHighlightLine(line))
      .filter(Boolean)
      .forEach((line) => lines.push(line));
  });

  return normalizeHighlightList(lines);
};

const valueToComparableSet = (value: any): string[] => {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .map((entry) => {
      if (entry == null) return '';
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        return normalizeCompareText(entry);
      }
      return normalizeCompareText(toDisplayValue(entry));
    })
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
};

const mergeSpecificsMaps = (...maps: Array<Record<string, any> | null | undefined>): Record<string, any> => {
  const merged: Record<string, any> = {};
  maps.forEach((map) => {
    if (!map || typeof map !== 'object') return;
    Object.entries(map).forEach(([rawKey, rawValue]) => {
      const key = safeString(rawKey);
      if (!key) return;
      if (merged[key] === undefined) {
        merged[key] = rawValue;
      }
    });
  });
  return merged;
};

const extractListingSpecifics = (listing: Record<string, any>, listingNormalized: Record<string, any>): Record<string, any> => {
  const merged = mergeSpecificsMaps(
    (listing?.itemSpecifics as Record<string, any>) || {},
    (listingNormalized?.specifics as Record<string, any>) || {}
  );
  const listingPld =
    listing?.productListingDetails && typeof listing.productListingDetails === 'object'
      ? (listing.productListingDetails as Record<string, any>)
      : {};
  const normalizedPld =
    listingNormalized?.productListingDetails && typeof listingNormalized.productListingDetails === 'object'
      ? (listingNormalized.productListingDetails as Record<string, any>)
      : {};

  const append = (name: string, value: any) => {
    const key = safeString(name);
    if (!key) return;
    if (value == null || value === '') return;
    if (merged[key] !== undefined) return;
    merged[key] = value;
  };

  append('EAN', listingPld?.EAN ?? normalizedPld?.EAN);
  append('GTIN', listingPld?.GTIN ?? normalizedPld?.GTIN);
  append('UPC', listingPld?.UPC ?? normalizedPld?.UPC);
  append('ISBN', listingPld?.ISBN ?? normalizedPld?.ISBN);
  append('Brand', listingPld?.BrandMPN?.Brand ?? normalizedPld?.BrandMPN?.Brand);
  append('MPN', listingPld?.BrandMPN?.MPN ?? normalizedPld?.BrandMPN?.MPN);
  append('SKU', listing?.sku ?? listingNormalized?.sku);

  return merged;
};

type SpecificsComparisonRow = {
  keyToken: string;
  keyLabel: string;
  ebayValue: string;
  avyValue: string;
  status: 'match' | 'different' | 'missing_ebay' | 'missing_avy' | 'not_applicable' | 'missing_both';
};

const buildSpecificsComparisonRows = (
  ebaySpecifics: Record<string, any>,
  avySpecifics: Record<string, any>,
  gapList: Array<Record<string, any>>
): SpecificsComparisonRow[] => {
  const merged = new Map<
    string,
    {
      ebayLabel?: string;
      avyLabel?: string;
      ebayRaw?: any;
      avyRaw?: any;
    }
  >();
  const gapLabelByToken = new Map<string, string>();
  const gapTokens = new Set<string>();
  const actionableMissingTokens = new Set<string>();
  (Array.isArray(gapList) ? gapList : []).forEach((gap) => {
    const type = normalizeCompareText(gap?.type);
    if (type !== 'item_specific') return;
    const status = normalizeCompareText(gap?.status);
    if (status === 'ignored' || status === 'synced') return;
    const token = normalizeSpecificKeyToken(gap?.field);
    if (!token) return;
    gapTokens.add(token);
    const label = safeString(gap?.field);
    if (label && !gapLabelByToken.has(token)) {
      gapLabelByToken.set(token, label);
    }
    const hasListing = valueToComparableSet(gap?.listingValue).length > 0;
    const hasAvy = valueToComparableSet(gap?.avyValue).length > 0;
    if (!hasListing && hasAvy) actionableMissingTokens.add(token);
  });

  const upsert = (side: 'ebay' | 'avy', rawKey: string, rawValue: any) => {
    const token = normalizeSpecificKeyToken(rawKey);
    if (!token) return;
    const existing = merged.get(token) || {};
    const next = { ...existing };
    if (side === 'ebay') {
      next.ebayLabel = next.ebayLabel || safeString(rawKey);
      next.ebayRaw = rawValue;
    } else {
      next.avyLabel = next.avyLabel || safeString(rawKey);
      next.avyRaw = rawValue;
    }
    merged.set(token, next);
  };

  Object.entries(ebaySpecifics || {}).forEach(([key, value]) => upsert('ebay', key, value));
  Object.entries(avySpecifics || {}).forEach(([key, value]) => upsert('avy', key, value));
  gapTokens.forEach((token) => {
    if (merged.has(token)) return;
    const label = gapLabelByToken.get(token) || token;
    merged.set(token, { ebayLabel: label, avyLabel: label, ebayRaw: null, avyRaw: null });
  });

  const rows: SpecificsComparisonRow[] = Array.from(merged.entries()).map(([keyToken, row]) => {
    const ebayValue = toDisplayValue(row.ebayRaw);
    const avyValue = toDisplayValue(row.avyRaw);
    const hasEbay = ebayValue !== '-';
    const hasAvy = avyValue !== '-';
    const ebaySet = valueToComparableSet(row.ebayRaw);
    const avySet = valueToComparableSet(row.avyRaw);
    const valuesEqual =
      ebaySet.length === avySet.length && ebaySet.every((entry, idx) => entry === avySet[idx]);

    let status: SpecificsComparisonRow['status'] = 'different';
    if (hasEbay && hasAvy && valuesEqual) status = 'match';
    else if (!hasEbay && hasAvy) {
      status = actionableMissingTokens.has(keyToken) ? 'missing_ebay' : 'not_applicable';
    }
    else if (!hasEbay && !hasAvy) {
      status = gapTokens.has(keyToken) ? 'missing_both' : 'not_applicable';
    }
    else if (hasEbay && !hasAvy) status = 'missing_avy';

    return {
      keyToken,
      keyLabel: safeString(row.avyLabel || row.ebayLabel || keyToken),
      ebayValue,
      avyValue,
      status,
    };
  });

  const statusOrder: Record<SpecificsComparisonRow['status'], number> = {
    missing_ebay: 0,
    missing_both: 1,
    different: 2,
    missing_avy: 3,
    not_applicable: 4,
    match: 5,
  };
  rows.sort((a, b) => {
    const byStatus = statusOrder[a.status] - statusOrder[b.status];
    if (byStatus !== 0) return byStatus;
    return a.keyLabel.localeCompare(b.keyLabel);
  });
  return rows;
};

const clipText = (value: any, maxLength = 220): string => {
  const raw = safeString(value);
  if (!raw) return '-';
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\u2026`;
};

const toValueArray = (value: any): string[] => {
  if (Array.isArray(value)) return value.map((entry) => safeString(entry)).filter(Boolean);
  const str = safeString(value);
  return str ? [str] : [];
};

const hasAnyValue = (value: any): boolean => toValueArray(value).length > 0;

/* ═══════════════════════════════════════════════════════════
   Types & Constants
   ═══════════════════════════════════════════════════════════ */

type GapStatusFilter = 'actionable' | 'all' | 'new' | 'reviewed' | 'accepted' | 'ready_to_sync' | 'ignored' | 'synced' | 'failed';
type GapSeverityFilter = 'all' | 'critical' | 'warn' | 'info';
type ListingListFilter = 'all' | 'with_gaps' | 'critical_only' | 'ready_only' | 'without_gaps';
type ListingSortBy = 'critical_desc' | 'gaps_desc' | 'ready_desc' | 'updated_desc' | 'title_asc' | 'item_id_desc';
type AdvancedActionKey = 'refresh_list' | 'links:rebuild' | 'gaps:rebuild' | 'sync:dry-run' | 'reports:generate' | 'gaps:refresh';
type GapBulkAction = 'ready_to_sync' | 'accept_ebay' | 'ignore' | 'reset';

const GAP_STATUS_FILTER_OPTIONS: Array<{ id: GapStatusFilter; label: string }> = [
  { id: 'actionable', label: 'Action needed' },
  { id: 'all', label: 'Alle' },
  { id: 'new', label: 'New' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'ready_to_sync', label: 'Ready' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'synced', label: 'Synced' },
  { id: 'failed', label: 'Failed' },
];

const GAP_SEVERITY_FILTER_OPTIONS: Array<{ id: GapSeverityFilter; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'critical', label: 'Critical' },
  { id: 'warn', label: 'Warn' },
  { id: 'info', label: 'Info' },
];

const LISTING_FILTER_OPTIONS: Array<{ id: ListingListFilter; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'with_gaps', label: 'Nur mit Gaps' },
  { id: 'critical_only', label: 'Nur kritisch' },
  { id: 'ready_only', label: 'Nur ready' },
  { id: 'without_gaps', label: 'Ohne Gaps' },
];

const LISTING_SORT_OPTIONS: Array<{ id: ListingSortBy; label: string }> = [
  { id: 'critical_desc', label: 'Sort: Kritisch absteigend' },
  { id: 'gaps_desc', label: 'Sort: Gaps absteigend' },
  { id: 'ready_desc', label: 'Sort: Ready absteigend' },
  { id: 'updated_desc', label: 'Sort: Update (neu zuerst)' },
  { id: 'title_asc', label: 'Sort: Titel A-Z' },
  { id: 'item_id_desc', label: 'Sort: Item ID absteigend' },
];

const ADVANCED_ACTION_OPTIONS: Array<{ id: AdvancedActionKey; label: string }> = [
  { id: 'refresh_list', label: 'Liste aktualisieren' },
  { id: 'gaps:refresh', label: 'Nur Gaps neu laden' },
  { id: 'links:rebuild', label: 'Linking neu berechnen' },
  { id: 'gaps:rebuild', label: 'Gap Audit neu berechnen' },
  { id: 'sync:dry-run', label: 'Dry-Run (Vorschau)' },
  { id: 'reports:generate', label: 'Reports generieren' },
];

const GAP_ACTIONABLE_STATUSES = new Set(['new', 'reviewed', 'accepted', 'ready_to_sync']);
const GAP_BULK_ACTION_OPTIONS: Array<{ id: GapBulkAction; label: string }> = [
  { id: 'ready_to_sync', label: 'Avy auf eBay syncen (ready)' },
  { id: 'accept_ebay', label: 'eBay-Wert behalten' },
  { id: 'ignore', label: 'Ignorieren' },
  { id: 'reset', label: 'Zuruecksetzen' },
];

/* ═══════════════════════════════════════════════════════════
   v2.1 Design-system badge helper
   ═══════════════════════════════════════════════════════════ */

const statusBadgeClass = (status?: string | null): string => {
  const key = safeString(status).toLowerCase();
  if (key === 'matched' || key === 'synced') return 'text-[var(--success)] bg-[var(--success-bg)]';
  if (key === 'ready_to_sync' || key === 'reviewed') return 'text-[var(--info)] bg-[var(--info-bg)]';
  if (key === 'new' || key === 'warn') return 'text-[var(--warning)] bg-[var(--warning-bg)]';
  if (key === 'critical' || key === 'failed' || key === 'unmatched') return 'text-[var(--error)] bg-[var(--error-bg)]';
  if (key === 'ignored') return 'text-[var(--text-tertiary)] bg-[var(--surface-secondary)]';
  return 'text-[var(--text-secondary)] bg-[var(--surface-secondary)]';
};

const specificsStatusBadgeClass = (status: SpecificsComparisonRow['status']): string => {
  if (status === 'match') return 'text-[var(--success)] bg-[var(--success-bg)]';
  if (status === 'missing_ebay') return 'text-[var(--error)] bg-[var(--error-bg)]';
  if (status === 'missing_both') return 'text-[var(--warning)] bg-[var(--warning-bg)]';
  if (status === 'missing_avy') return 'text-[var(--text-secondary)] bg-[var(--surface-secondary)]';
  if (status === 'not_applicable') return 'text-[var(--info)] bg-[var(--info-bg)]';
  return 'text-[var(--warning)] bg-[var(--warning-bg)]';
};

const specificsStatusLabel = (status: SpecificsComparisonRow['status']): string => {
  if (status === 'match') return 'gleich';
  if (status === 'missing_ebay') return 'fehlt auf ebay';
  if (status === 'missing_both') return 'ebay leer + avy leer';
  if (status === 'missing_avy') return 'nur ebay';
  if (status === 'not_applicable') return 'nicht eBay-attribut';
  return 'abweichend';
};

/* ═══════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════ */

export const EbayListingsView: React.FC = () => {
  /* ─── State ─── */
  const [listings, setListings] = useState<EbayListingRow[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EbayListingDetail | null>(null);
  const [search, setSearch] = useState('');
  const [matchStatus, setMatchStatus] = useState<'all' | 'matched' | 'ambiguous' | 'unmatched'>('all');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tradingStatus, setTradingStatus] = useState<{ connected: boolean; mode?: string | null } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<EbaySyncDryRunResult | null>(null);
  const [applyResult, setApplyResult] = useState<EbaySyncApplyResult | null>(null);
  const [gapStatusFilter, setGapStatusFilter] = useState<GapStatusFilter>('all');
  const [gapSeverityFilter, setGapSeverityFilter] = useState<GapSeverityFilter>('all');
  const [gapSearch, setGapSearch] = useState('');
  const [gapVisibleCount, setGapVisibleCount] = useState(25);
  const [selectedGapIds, setSelectedGapIds] = useState<Record<string, boolean>>({});
  const [gapBulkAction, setGapBulkAction] = useState<GapBulkAction>('ready_to_sync');
  const [listingListFilter, setListingListFilter] = useState<ListingListFilter>('all');
  const [listingSortBy, setListingSortBy] = useState<ListingSortBy>('critical_desc');
  const [listingListSearch, setListingListSearch] = useState('');
  const [selectedListingIds, setSelectedListingIds] = useState<Record<string, boolean>>({});
  const [advancedAction, setAdvancedAction] = useState<AdvancedActionKey>('gaps:refresh');

  /* ─── Derived ─── */
  const selectedListing = useMemo(
    () => listings.find((entry) => entry.itemId === selectedItemId) || null,
    [listings, selectedItemId]
  );

  /* ─── Callbacks ─── */
  const runAction = useCallback(async (actionKey: string, action: () => Promise<void>) => {
    setBusyAction(actionKey);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err: any) {
      setError(toUiErrorMessage(err, 'Aktion fehlgeschlagen'));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const loadTradingStatus = useCallback(async () => {
    try {
      const status = await fetchEbayTradingStatus();
      setTradingStatus(status);
    } catch (err: any) {
      setTradingStatus({ connected: false, mode: null });
      setError(toUiErrorMessage(err, 'Trading Status konnte nicht geladen werden'));
    }
  }, []);

  const loadListings = useCallback(async () => {
    setLoadingListings(true);
    setError(null);
    try {
      const rows = await fetchEbayLiveListings({
        limit: 500,
        search: search.trim() || undefined,
        matchStatus: matchStatus === 'all' ? undefined : matchStatus,
        includeInactive,
      });
      setListings(rows);
      setSelectedItemId((prev) => {
        if (prev && rows.some((row) => row.itemId === prev)) return prev;
        return rows[0]?.itemId || null;
      });
    } catch (err: any) {
      setError(toUiErrorMessage(err, 'Listings konnten nicht geladen werden'));
      setListings([]);
      setSelectedItemId(null);
    } finally {
      setLoadingListings(false);
    }
  }, [includeInactive, matchStatus, search]);

  const loadDetail = useCallback(async (itemId: string) => {
    if (!itemId) return;
    setLoadingDetail(true);
    try {
      const data = await fetchEbayLiveListingDetail(itemId);
      setDetail(data);
    } catch (err: any) {
      setDetail(null);
      setError(toUiErrorMessage(err, 'Detail konnte nicht geladen werden'));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  /* ─── Effects ─── */
  useEffect(() => {
    void loadTradingStatus();
    void loadListings();
  }, [loadListings, loadTradingStatus]);

  useEffect(() => {
    if (!selectedItemId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedItemId);
  }, [selectedItemId, loadDetail]);

  useEffect(() => {
    setGapVisibleCount(25);
    setGapSearch('');
    setSelectedGapIds({});
  }, [selectedItemId]);

  const updateListingGapCounters = useCallback(
    (summary: any) => {
      if (!selectedItemId || !summary) return;
      setListings((prev) =>
        prev.map((row) => {
          if (row.itemId !== selectedItemId) return row;
          return {
            ...row,
            gapCount: Number(summary.total || 0),
            gapCriticalCount: Number(summary.critical || 0),
            gapReadyCount: Number(summary?.byStatus?.ready_to_sync || 0),
          };
        })
      );
    },
    [selectedItemId]
  );

  const executeSelectedGapBulkAction = useCallback(
    async (gapIds: string[], action: GapBulkAction) => {
      if (!selectedItemId || !gapIds.length) return;
      await runAction(`gaps:bulk:${action}`, async () => {
        const out = await bulkApplyEbayGapActions(selectedItemId, { gapIds, action });
        const docs = await fetchEbayGaps({ itemId: selectedItemId, limit: 1 });
        const refreshed = docs[0] || null;
        if (refreshed) {
          setDetail((prev) => (prev ? { ...prev, gaps: refreshed } : prev));
          updateListingGapCounters(refreshed.summary || out?.summary);
        } else {
          updateListingGapCounters(out?.summary);
        }
        setSelectedGapIds((prev) => {
          const next = { ...prev };
          gapIds.forEach((id) => {
            delete next[id];
          });
          return next;
        });
        setNotice(`${gapIds.length} Gap(s) mit Aktion "${action}" aktualisiert.`);
      });
    },
    [runAction, selectedItemId, updateListingGapCounters]
  );

  const runItemSpecificSyncFlow = useCallback(
    async (mode: 'missing_ebay' | 'different' | 'all', label: string) => {
      await runAction(`specifics:bulk:${mode}`, async () => {
        const itemIds = selectedItemId ? [selectedItemId] : undefined;
        const prepared =
          mode === 'missing_ebay'
            ? await bulkPrepareEbayMissingSpecifics(itemIds)
            : await bulkPrepareEbayItemSpecifics(itemIds, mode);
        const payload = await runEbaySyncApply(itemIds);
        setApplyResult(payload);
        await loadListings();
        if (selectedItemId) await loadDetail(selectedItemId);
        setNotice(
          `${label}: vorbereitet ${prepared?.gapsPrepared ?? 0}, Sync Apply -> Success ${payload?.summary?.success ?? 0}, Failed ${
            payload?.summary?.failed ?? 0
          }, Skipped ${payload?.summary?.skipped ?? 0}.`
        );
      });
    },
    [loadDetail, loadListings, runAction, selectedItemId]
  );

  const executeAdvancedAction = useCallback(async () => {
    if (advancedAction === 'refresh_list') {
      await loadListings();
      setNotice('Liste aktualisiert.');
      return;
    }
    if (advancedAction === 'links:rebuild') {
      const res = await rebuildEbayListingLinks({});
      await loadListings();
      setNotice(`Linking aktualisiert (${res?.matched ?? 0} matched, ${res?.unmatched ?? 0} unmatched).`);
      return;
    }
    if (advancedAction === 'gaps:rebuild') {
      const res = await rebuildEbayGaps({});
      await loadListings();
      setNotice(`Gap Audit aktualisiert (${res?.totalListings ?? 0} Listings, ${res?.totalGaps ?? 0} Gaps).`);
      return;
    }
    if (advancedAction === 'sync:dry-run') {
      const payload = await runEbaySyncDryRun(selectedItemId ? [selectedItemId] : undefined);
      setDryRunResult(payload);
      setNotice('Dry-Run abgeschlossen.');
      return;
    }
    if (advancedAction === 'reports:generate') {
      const reports = await generateEbayReports();
      setNotice(`Reports erstellt (${reports?.reportId || 'n/a'}).`);
      return;
    }
    if (advancedAction === 'gaps:refresh') {
      const docs = await fetchEbayGaps({ itemId: selectedItemId || undefined, limit: selectedItemId ? 1 : 20 });
      if (selectedItemId && docs.length) {
        setDetail((prev) => (prev ? { ...prev, gaps: docs[0] } : prev));
      }
      setNotice(`Gaps geladen (${docs.length}).`);
    }
  }, [advancedAction, loadListings, selectedItemId]);

  /* ─── Derived detail data ─── */
  const listing = (detail?.listing && typeof detail.listing === 'object' ? detail.listing : {}) as Record<string, any>;
  const listingNormalized =
    listing?.normalized && typeof listing.normalized === 'object' ? (listing.normalized as Record<string, any>) : {};
  const listingSpecifics = useMemo(() => extractListingSpecifics(listing, listingNormalized), [listing, listingNormalized]);
  const ebayCategoryId = safeString(
    listing?.primaryCategoryId || listingNormalized?.primaryCategoryId || listing?.categoryId || listingNormalized?.categoryId
  );
  const ebayCategoryName = safeString(listing?.primaryCategoryName || listingNormalized?.primaryCategoryName);
  const ebayCategoryText = [ebayCategoryId, ebayCategoryName].filter(Boolean).join(' | ') || '-';
  const ebayTitle = safeString(listing?.title || listingNormalized?.title);
  const ebaySubtitle = safeString(listing?.subtitle || listingNormalized?.subtitle);
  const ebayDescription = safeString(listing?.description || listingNormalized?.description);
  const ebayDescriptionParts = useMemo(() => extractEbayTemplateDescriptionParts(ebayDescription), [ebayDescription]);
  const ebayViewItemUrl = safeString(listing?.viewItemUrl || listingNormalized?.viewItemUrl);

  const product = detail?.product || null;
  const productSpecifics = useMemo(() => extractProductSpecifics(product), [product]);
  const productHighlights = useMemo(() => extractProductHighlights(product), [product]);
  const productCategoryId = safeString(
    product?.details?.category?.id ||
      product?.details?.categoryId ||
      product?.details?.ebayCategoryId ||
      product?.classification?.ebayCategoryId ||
      product?.marketplace?.ebay?.categoryId ||
      product?.categoryId
  );
  const productTitle = safeString(product?.identification?.name || product?.details?.title || product?.title);
  const productSubtitle = safeString(product?.details?.subtitle || product?.subtitle);
  const productDescription = safeString(product?.details?.short_description || product?.details?.description || product?.description);
  const productDescriptionText = useMemo(() => normalizeRichTextForCompare(productDescription), [productDescription]);
  const ebayDescriptionText = useMemo(
    () => normalizeRichTextForCompare(ebayDescriptionParts.descriptionRaw || ebayDescription),
    [ebayDescription, ebayDescriptionParts.descriptionRaw]
  );
  const gapList = Array.isArray(detail?.gaps?.gaps) ? detail.gaps.gaps : [];
  const descriptionMatches = useMemo(() => {
    if (!productDescriptionText && !ebayDescriptionText) return true;
    if (!productDescriptionText || !ebayDescriptionText) return false;
    if (productDescriptionText === ebayDescriptionText) return true;
    if (
      productDescriptionText.length > 120 &&
      ebayDescriptionText.length > 120 &&
      (productDescriptionText.includes(ebayDescriptionText) || ebayDescriptionText.includes(productDescriptionText))
    ) {
      return true;
    }
    return false;
  }, [ebayDescriptionText, productDescriptionText]);
  const highlightsMatch = useMemo(() => {
    const left = normalizeHighlightList(productHighlights).slice().sort((a, b) => a.localeCompare(b));
    const right = normalizeHighlightList(ebayDescriptionParts.highlights).slice().sort((a, b) => a.localeCompare(b));
    if (!left.length && !right.length) return true;
    if (left.length !== right.length) return false;
    return left.every((entry, idx) => entry === right[idx]);
  }, [ebayDescriptionParts.highlights, productHighlights]);
  const specificsComparisonRows = useMemo(
    () => buildSpecificsComparisonRows(listingSpecifics, productSpecifics, gapList),
    [listingSpecifics, productSpecifics, gapList]
  );
  const specificsStats = useMemo(() => {
    const base = { match: 0, different: 0, missing_ebay: 0, missing_avy: 0, not_applicable: 0, missing_both: 0 };
    specificsComparisonRows.forEach((row) => {
      base[row.status] += 1;
    });
    return base;
  }, [specificsComparisonRows]);
  const fieldComparisonRows = useMemo(() => {
    const rows = [
      {
        key: 'category',
        label: 'Kategorie',
        ebayValue: ebayCategoryText,
        avyValue: productCategoryId || '-',
        equal: normalizeCompareText(ebayCategoryId) === normalizeCompareText(productCategoryId),
      },
      {
        key: 'title',
        label: 'Titel',
        ebayValue: ebayTitle || '-',
        avyValue: productTitle || '-',
        equal: normalizeCompareText(ebayTitle) === normalizeCompareText(productTitle),
      },
      {
        key: 'subtitle',
        label: 'Untertitel',
        ebayValue: ebaySubtitle || '-',
        avyValue: productSubtitle || '-',
        equal: normalizeCompareText(ebaySubtitle) === normalizeCompareText(productSubtitle),
      },
      {
        key: 'description',
        label: 'Beschreibung',
        ebayValue: clipText(normalizeHighlightLine(ebayDescriptionParts.descriptionRaw || ebayDescription), 220),
        avyValue: clipText(normalizeHighlightLine(productDescription), 220),
        equal: descriptionMatches && highlightsMatch,
      },
      {
        key: 'highlights',
        label: 'Highlights',
        ebayValue: clipText(ebayDescriptionParts.highlights.join(' | ') || '-', 220),
        avyValue: clipText(productHighlights.join(' | ') || '-', 220),
        equal: highlightsMatch,
      },
    ];
    return rows;
  }, [
    ebayCategoryId,
    ebayCategoryText,
    ebayDescription,
    ebayDescriptionParts.descriptionRaw,
    ebayDescriptionParts.highlights,
    ebaySubtitle,
    ebayTitle,
    descriptionMatches,
    highlightsMatch,
    productHighlights,
    productCategoryId,
    productDescription,
    productSubtitle,
    productTitle,
  ]);

  useEffect(() => {
    const allowedIds = new Set(gapList.map((gap) => safeString(gap.id)).filter(Boolean));
    setSelectedGapIds((prev) => {
      const next: Record<string, boolean> = {};
      Object.keys(prev).forEach((id) => {
        if (allowedIds.has(id)) next[id] = true;
      });
      return next;
    });
  }, [gapList]);

  const filteredGapList = useMemo(() => {
    const searchNeedle = normalizeCompareText(gapSearch);
    return gapList
      .filter((gap) => {
        const status = normalizeCompareText(gap?.status);
        if (gapStatusFilter !== 'all') {
          if (gapStatusFilter === 'actionable') {
            if (!GAP_ACTIONABLE_STATUSES.has(status)) return false;
          } else if (status !== gapStatusFilter) {
            return false;
          }
        }
        const severity = normalizeCompareText(gap?.severity);
        if (gapSeverityFilter !== 'all' && severity !== gapSeverityFilter) return false;
        if (!searchNeedle) return true;
        const hay = [
          gap?.id,
          gap?.type,
          gap?.field,
          gap?.message,
          toDisplayValue(gap?.listingValue),
          toDisplayValue(gap?.avyValue),
        ]
          .map((entry) => normalizeCompareText(entry))
          .join(' ');
        return hay.includes(searchNeedle);
      })
      .sort((a, b) => {
        const severityWeight = (value: any) => {
          const key = normalizeCompareText(value);
          if (key === 'critical') return 0;
          if (key === 'warn') return 1;
          return 2;
        };
        const statusWeight = (value: any) => {
          const key = normalizeCompareText(value);
          if (key === 'ready_to_sync') return 0;
          if (key === 'new') return 1;
          if (key === 'reviewed') return 2;
          if (key === 'accepted') return 3;
          if (key === 'failed') return 4;
          if (key === 'ignored') return 5;
          if (key === 'synced') return 6;
          return 7;
        };
        const bySeverity = severityWeight(a?.severity) - severityWeight(b?.severity);
        if (bySeverity !== 0) return bySeverity;
        const byStatus = statusWeight(a?.status) - statusWeight(b?.status);
        if (byStatus !== 0) return byStatus;
        return safeString(a?.field).localeCompare(safeString(b?.field));
      });
  }, [gapList, gapSearch, gapSeverityFilter, gapStatusFilter]);

  const visibleGapList = useMemo(() => filteredGapList.slice(0, gapVisibleCount), [filteredGapList, gapVisibleCount]);
  const hiddenGapCount = Math.max(0, filteredGapList.length - visibleGapList.length);
  const visibleGapIds = useMemo(
    () => visibleGapList.map((gap) => safeString(gap.id)).filter(Boolean),
    [visibleGapList]
  );
  const selectedVisibleGapIds = useMemo(
    () => visibleGapIds.filter((id) => Boolean(selectedGapIds[id])),
    [selectedGapIds, visibleGapIds]
  );
  const allVisibleSelected = visibleGapIds.length > 0 && selectedVisibleGapIds.length === visibleGapIds.length;
  const selectableGapCount = visibleGapIds.length;
  const itemSpecificGapModes = useMemo(() => {
    const base = {
      missing_ebay: [] as string[],
      different: [] as string[],
      all: [] as string[],
    };
    gapList.forEach((gap) => {
      if (normalizeCompareText(gap?.type) !== 'item_specific') return;
      const status = normalizeCompareText(gap?.status);
      if (status === 'ignored' || status === 'synced') return;
      const id = safeString(gap?.id);
      if (!id) return;
      const hasListing = hasAnyValue(gap?.listingValue);
      const hasAvy = hasAnyValue(gap?.avyValue);
      if (!hasAvy) return;
      const listingSet = valueToComparableSet(gap?.listingValue);
      const avySet = valueToComparableSet(gap?.avyValue);
      const differs =
        listingSet.length !== avySet.length || listingSet.some((entry, idx) => entry !== avySet[idx]);
      base.all.push(id);
      if (!hasListing) {
        base.missing_ebay.push(id);
      } else if (differs) {
        base.different.push(id);
      }
    });
    return base;
  }, [gapList]);

  const filteredSortedListings = useMemo(() => {
    const normalizedListSearch = normalizeCompareText(listingListSearch);
    const parseTs = (row: EbayListingRow): number => {
      const raw = safeString(row.gapDocUpdatedAt || row.updatedAt);
      if (!raw) return 0;
      const ts = Date.parse(raw);
      return Number.isFinite(ts) ? ts : 0;
    };
    const parseItemId = (row: EbayListingRow): number => {
      const numeric = Number(safeString(row.itemId));
      return Number.isFinite(numeric) ? numeric : 0;
    };

    const rows = listings.filter((row) => {
      const gapCount = Number(row.gapCount || 0);
      const criticalCount = Number(row.gapCriticalCount || 0);
      const readyCount = Number(row.gapReadyCount || 0);

      if (listingListFilter === 'with_gaps' && gapCount <= 0) return false;
      if (listingListFilter === 'critical_only' && criticalCount <= 0) return false;
      if (listingListFilter === 'ready_only' && readyCount <= 0) return false;
      if (listingListFilter === 'without_gaps' && gapCount > 0) return false;

      if (!normalizedListSearch) return true;
      const haystack = normalizeCompareText(`${safeString(row.itemId)} ${safeString(row.sku)} ${safeString(row.title)}`);
      return haystack.includes(normalizedListSearch);
    });

    rows.sort((left, right) => {
      if (listingSortBy === 'critical_desc') {
        const byCritical = Number(right.gapCriticalCount || 0) - Number(left.gapCriticalCount || 0);
        if (byCritical !== 0) return byCritical;
        return Number(right.gapCount || 0) - Number(left.gapCount || 0);
      }
      if (listingSortBy === 'gaps_desc') {
        return Number(right.gapCount || 0) - Number(left.gapCount || 0);
      }
      if (listingSortBy === 'ready_desc') {
        return Number(right.gapReadyCount || 0) - Number(left.gapReadyCount || 0);
      }
      if (listingSortBy === 'updated_desc') {
        return parseTs(right) - parseTs(left);
      }
      if (listingSortBy === 'title_asc') {
        return safeString(left.title).localeCompare(safeString(right.title), 'de');
      }
      if (listingSortBy === 'item_id_desc') {
        return parseItemId(right) - parseItemId(left);
      }
      return 0;
    });

    return rows;
  }, [listingListFilter, listingListSearch, listingSortBy, listings]);

  const selectedListingIdList = useMemo(
    () =>
      Object.keys(selectedListingIds)
        .filter((itemId) => Boolean(selectedListingIds[itemId]))
        .filter((itemId) => listings.some((row) => row.itemId === itemId)),
    [listings, selectedListingIds]
  );
  const selectedSyncItemIds = useMemo(() => {
    if (selectedListingIdList.length) return selectedListingIdList;
    if (selectedItemId) return [selectedItemId];
    return undefined;
  }, [selectedItemId, selectedListingIdList]);
  const visibleListingIds = useMemo(() => filteredSortedListings.map((row) => row.itemId), [filteredSortedListings]);
  const selectedVisibleListingIds = useMemo(
    () => visibleListingIds.filter((itemId) => Boolean(selectedListingIds[itemId])),
    [selectedListingIds, visibleListingIds]
  );
  const allVisibleListingsSelected =
    visibleListingIds.length > 0 && selectedVisibleListingIds.length === visibleListingIds.length;

  useEffect(() => {
    if (!filteredSortedListings.length) return;
    if (!selectedItemId || !filteredSortedListings.some((row) => row.itemId === selectedItemId)) {
      setSelectedItemId(filteredSortedListings[0].itemId);
    }
  }, [filteredSortedListings, selectedItemId]);

  useEffect(() => {
    const validIds = new Set(listings.map((row) => row.itemId));
    setSelectedListingIds((prev) => {
      const next: Record<string, boolean> = {};
      Object.keys(prev).forEach((id) => {
        if (validIds.has(id) && prev[id]) next[id] = true;
      });
      return next;
    });
  }, [listings]);

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */

  return (
    <div className="w-full max-w-[1800px] mx-auto px-2 lg:px-4 space-y-5">

      {/* ─── Header Card ─── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">eBay Listings</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              Audit fuer Kategorie, Item Specifics und Content. Gap-Workflow mit kontrolliertem Sync zu eBay.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold inline-flex items-center gap-1.5 ${statusBadgeClass(tradingStatus?.connected ? 'synced' : 'failed')}`}>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tradingStatus?.connected ? 'bg-[var(--success)]' : 'bg-[var(--error)]'}`} />
              Trading API: {tradingStatus?.connected ? 'verbunden' : 'offline'}
            </span>
            <span className="rounded-full px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)] bg-[var(--surface-secondary)]">
              Mode: {safeString(tradingStatus?.mode) || '-'}
            </span>
          </div>
        </div>

        {/* Filters Row */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-4">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Suche nach Item ID, SKU oder Titel"
              className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
            />
          </div>
          <div className="lg:col-span-2">
            <select
              value={matchStatus}
              onChange={(event) => setMatchStatus(event.target.value as any)}
              className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] appearance-none cursor-pointer transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
            >
              <option value="all">Match: Alle</option>
              <option value="matched">Matched</option>
              <option value="ambiguous">Ambiguous</option>
              <option value="unmatched">Unmatched</option>
            </select>
          </div>
          <div className="lg:col-span-2 flex items-center">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
                className="accent-[var(--avy-purple)] w-4 h-4 rounded"
              />
              Inaktive anzeigen
            </label>
          </div>
          <div className="lg:col-span-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                void runAction('sync:listings', async () => {
                  const res = await syncEbayLiveListings({});
                  await loadListings();
                  setNotice(`Live Sync + Audit abgeschlossen (${res?.fetched ?? 0} Listings, ${res?.gaps ?? 0} Gap-Dokumente).`);
                })
              }
              disabled={busyAction === 'sync:listings'}
              className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3.5 py-2 text-[13px] bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] hover:translate-y-[-1px] hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Live Sync + Audit
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('gaps:bulk-missing', async () => {
                  const prepared = await bulkPrepareEbayMissingSpecifics(selectedSyncItemIds);
                  const payload = await runEbaySyncApply(selectedSyncItemIds);
                  setApplyResult(payload);
                  await loadListings();
                  if (selectedItemId) await loadDetail(selectedItemId);
                  setNotice(
                    `Bulk fehlende Parameter vorbereitet (${prepared?.gapsPrepared ?? 0}) und Sync Apply gestartet. Success: ${
                      payload?.summary?.success ?? 0
                    }, Failed: ${payload?.summary?.failed ?? 0}, Skipped: ${payload?.summary?.skipped ?? 0}.`
                  );
                })
              }
              disabled={busyAction === 'gaps:bulk-missing'}
              className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3.5 py-2 text-[13px] bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Bulk fehlende Parameter{' '}
              {selectedListingIdList.length ? `(${selectedListingIdList.length} Auswahl)` : selectedItemId ? '(Auswahl)' : '(alle)'}
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('sync:apply', async () => {
                  const payload = await runEbaySyncApply(selectedSyncItemIds);
                  setApplyResult(payload);
                  await loadListings();
                  if (selectedItemId) await loadDetail(selectedItemId);
                  setNotice('Sync Apply abgeschlossen.');
                })
              }
              disabled={busyAction === 'sync:apply'}
              className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3.5 py-2 text-[13px] bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Sync Apply{' '}
              {selectedListingIdList.length ? `(${selectedListingIdList.length} Auswahl)` : selectedItemId ? '(Auswahl)' : '(alle ready)'}
            </button>
          </div>
        </div>

        {/* Advanced Actions */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Weitere Aktionen</span>
          <select
            value={advancedAction}
            onChange={(event) => setAdvancedAction(event.target.value as AdvancedActionKey)}
            className="px-2.5 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] appearance-none cursor-pointer min-w-[220px] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
          >
            {ADVANCED_ACTION_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void runAction(`advanced:${advancedAction}`, executeAdvancedAction)}
            disabled={Boolean(busyAction && busyAction.startsWith('advanced:'))}
            className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-2.5 py-1.5 text-xs bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] hover:shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Ausfuehren
          </button>
        </div>
      </div>

      {/* ─── Alerts ─── */}
      {error && (
        <div className="rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)]">
          {safeString(error)}
        </div>
      )}
      {notice && (
        <div className="rounded-lg bg-[var(--success-bg)] border border-[var(--success-border)] px-4 py-3 text-sm text-[var(--success)]">
          {notice}
        </div>
      )}

      {/* ─── Main Two-Column Layout ─── */}
      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-5">

        {/* ── Sidebar: Listing List ── */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Listings ({filteredSortedListings.length}/{listings.length})
            </p>
            {loadingListings && (
              <div className="w-4 h-4 border-2 border-[var(--border)] border-t-[var(--avy-purple)] rounded-full animate-spin" />
            )}
          </div>

          {/* Sidebar Filters */}
          <div className="space-y-2 mb-3">
            <input
              value={listingListSearch}
              onChange={(event) => setListingListSearch(event.target.value)}
              placeholder="In Liste filtern (Item ID, SKU, Titel)"
              className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={listingListFilter}
                onChange={(event) => setListingListFilter(event.target.value as ListingListFilter)}
                className="w-full px-2.5 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] appearance-none cursor-pointer transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
              >
                {LISTING_FILTER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={listingSortBy}
                onChange={(event) => setListingSortBy(event.target.value as ListingSortBy)}
                className="w-full px-2.5 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] appearance-none cursor-pointer transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
              >
                {LISTING_SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setSelectedListingIds((prev) => {
                    if (allVisibleListingsSelected) {
                      const next = { ...prev };
                      visibleListingIds.forEach((id) => {
                        delete next[id];
                      });
                      return next;
                    }
                    const next = { ...prev };
                    visibleListingIds.forEach((id) => {
                      next[id] = true;
                    });
                    return next;
                  })
                }
                disabled={visibleListingIds.length === 0}
                className="rounded-lg px-2 py-1 text-2xs font-semibold bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-all duration-200 disabled:opacity-50"
              >
                {allVisibleListingsSelected ? 'Sichtbare abwaehlen' : 'Sichtbare markieren'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedListingIds({})}
                disabled={selectedListingIdList.length === 0}
                className="rounded-lg px-2 py-1 text-2xs font-semibold bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-all duration-200 disabled:opacity-50"
              >
                Auswahl leeren
              </button>
              <span className="text-2xs text-[var(--text-tertiary)]">
                Multi-Auswahl: {selectedListingIdList.length}
              </span>
            </div>
          </div>

          {/* Listing Cards */}
          <div className="max-h-[72vh] overflow-auto space-y-2 pr-1">
            {filteredSortedListings.map((row) => {
              const active = row.itemId === selectedItemId;
              const checked = Boolean(selectedListingIds[row.itemId]);
              return (
                <div
                  key={row.itemId}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ${
                    active
                      ? 'border-[var(--avy-purple)] bg-[var(--avy-purple-glow)] shadow-sm'
                      : 'border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-hover)]'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-2xs text-[var(--text-secondary)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setSelectedListingIds((prev) => ({
                            ...prev,
                            [row.itemId]: event.target.checked,
                          }))
                        }
                        className="accent-[var(--avy-purple)] w-3.5 h-3.5 rounded"
                      />
                      Auswaehlen
                    </label>
                    <button
                      type="button"
                      onClick={() => setSelectedItemId(row.itemId)}
                      className="rounded-md px-2 py-0.5 text-2xs font-semibold text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
                    >
                      Details
                    </button>
                  </div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-[var(--text-tertiary)] truncate">Item ID: {row.itemId}</p>
                      <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{safeString(row.title) || '-'}</p>
                      <p className="text-xs text-[var(--text-tertiary)] truncate">SKU: {safeString(row.sku) || '-'}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide whitespace-nowrap ${statusBadgeClass(row.matchStatus)}`}>
                      {safeString(row.matchStatus) || 'n/a'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--text-secondary)] bg-[var(--surface-secondary)]">
                      Gaps: {row.gapCount ?? 0}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--error)] bg-[var(--error-bg)]">
                      Crit: {row.gapCriticalCount ?? 0}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--info)] bg-[var(--info-bg)]">
                      Ready: {row.gapReadyCount ?? 0}
                    </span>
                  </div>
                </div>
              );
            })}
            {!loadingListings && filteredSortedListings.length === 0 && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-4 text-sm text-[var(--text-tertiary)] text-center">
                Keine Listings fuer die aktuellen Filter gefunden.
              </p>
            )}
          </div>
        </div>

        {/* ── Main Content: Detail Panel ── */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 space-y-5">
          {!selectedItemId ? (
            <p className="text-sm text-[var(--text-tertiary)]">Bitte ein Listing auswaehlen.</p>
          ) : loadingDetail ? (
            <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
              <div className="w-4 h-4 border-2 border-[var(--border)] border-t-[var(--avy-purple)] rounded-full animate-spin" />
              Lade Listing-Details...
            </div>
          ) : !detail ? (
            <p className="text-sm text-[var(--text-tertiary)]">Keine Detaildaten verfuegbar.</p>
          ) : (
            <>
              {/* Listing + Link Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Listing</p>
                  <p className="text-sm text-[var(--text-primary)] font-semibold">{ebayTitle || '-'}</p>
                  <p className="text-xs text-[var(--text-secondary)]">Item ID: {safeString(detail.listing?.itemId) || '-'}</p>
                  <p className="text-xs text-[var(--text-secondary)]">SKU: {safeString(detail.listing?.sku) || '-'}</p>
                  <p className="text-xs text-[var(--text-secondary)]">Kategorie: {ebayCategoryText}</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Zuletzt aktualisiert: {formatDateTime(detail.listing?.updatedAt)}</p>
                  {ebayViewItemUrl && (
                    <a
                      href={ebayViewItemUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-md px-2.5 py-1 text-2xs font-semibold text-[var(--avy-purple)] bg-[var(--avy-purple-glow)] hover:text-[var(--avy-purple-hover)] transition-colors duration-150 mt-1"
                    >
                      Auf eBay oeffnen
                    </a>
                  )}
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Linking</p>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ${statusBadgeClass(detail.link?.status)}`}>
                      {safeString(detail.link?.status) || 'n/a'}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">Method: {safeString(detail.link?.method) || '-'}</span>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">Product ID: {safeString(detail.link?.productId) || '-'}</p>
                  <p className="text-xs text-[var(--text-secondary)]">Confidence: {toDisplayValue(detail.link?.confidence)}</p>
                </div>
              </div>

              {/* Direct Comparison */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Direktvergleich (eBay vs AvyCloud)</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Kernaussagen auf einen Blick</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {fieldComparisonRows.map((row) => (
                    <div
                      key={row.key}
                      className={`rounded-lg border p-3 ${
                        row.equal
                          ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
                          : 'border-[var(--warning-border)] bg-[var(--warning-bg)]'
                      }`}
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-[var(--text-primary)]">{row.label}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${
                            row.equal
                              ? 'text-[var(--success)] bg-[var(--success-bg)]'
                              : 'text-[var(--warning)] bg-[var(--warning-bg)]'
                          }`}
                        >
                          {row.equal ? 'gleich' : 'abweichung'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-2xs">
                        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[var(--text-secondary)]">
                          <span className="text-[var(--text-tertiary)]">eBay: </span>
                          {row.ebayValue}
                        </div>
                        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[var(--text-secondary)]">
                          <span className="text-[var(--text-tertiary)]">AvyCloud: </span>
                          {row.avyValue}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Item Specifics Comparison */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Item Specifics Vergleich ({specificsComparisonRows.length})</p>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--error)] bg-[var(--error-bg)]">
                      Fehlt auf eBay: {specificsStats.missing_ebay}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--warning)] bg-[var(--warning-bg)]">
                      eBay leer + Avy leer: {specificsStats.missing_both}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--warning)] bg-[var(--warning-bg)]">
                      Unterschiedlich: {specificsStats.different}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--info)] bg-[var(--info-bg)]">
                      Nicht eBay-Attribut: {specificsStats.not_applicable}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--text-secondary)] bg-[var(--surface-secondary)]">
                      Nur eBay: {specificsStats.missing_avy}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-2xs font-semibold text-[var(--success)] bg-[var(--success-bg)]">
                      Gleich: {specificsStats.match}
                    </span>
                  </div>
                </div>

                {/* Specifics Direct Actions */}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
                  <span className="text-2xs font-semibold text-[var(--text-secondary)]">Direktaktion:</span>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('missing_ebay', 'Fehlende Item Specifics')}
                    disabled={itemSpecificGapModes.missing_ebay.length === 0 || Boolean(busyAction)}
                    className="rounded-lg px-2.5 py-1 text-2xs font-semibold bg-[var(--error-bg)] text-[var(--error)] border border-[var(--error-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50"
                  >
                    Fehlende auf eBay syncen ({itemSpecificGapModes.missing_ebay.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('different', 'Abweichende Item Specifics')}
                    disabled={itemSpecificGapModes.different.length === 0 || Boolean(busyAction)}
                    className="rounded-lg px-2.5 py-1 text-2xs font-semibold bg-[var(--warning-bg)] text-[var(--warning)] border border-[var(--warning-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50"
                  >
                    Abweichungen syncen ({itemSpecificGapModes.different.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('all', 'Alle Item Specifics')}
                    disabled={itemSpecificGapModes.all.length === 0 || Boolean(busyAction)}
                    className="rounded-lg px-2.5 py-1 text-2xs font-semibold bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50"
                  >
                    Alle Item Specifics syncen ({itemSpecificGapModes.all.length})
                  </button>
                </div>

                {/* Specifics Table */}
                <div className="max-h-[34vh] overflow-auto rounded-lg border border-[var(--border)]">
                  <table className="w-full border-collapse text-2xs">
                    <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                      <tr>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Attribut</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Status</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">eBay</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">AvyCloud</th>
                      </tr>
                    </thead>
                    <tbody>
                      {specificsComparisonRows.map((row) => (
                        <tr key={row.keyToken} className="border-b border-[var(--border)] last:border-b-0 transition-colors duration-100 hover:bg-[var(--surface-hover)]">
                          <td className="py-2 px-3 text-[var(--text-primary)] font-medium">{row.keyLabel}</td>
                          <td className="py-2 px-3">
                            <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${specificsStatusBadgeClass(row.status)}`}>
                              {specificsStatusLabel(row.status)}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-[var(--text-secondary)]">{clipText(row.ebayValue, 180)}</td>
                          <td className="py-2 px-3 text-[var(--text-secondary)]">{clipText(row.avyValue, 180)}</td>
                        </tr>
                      ))}
                      {specificsComparisonRows.length === 0 && (
                        <tr>
                          <td className="py-8 px-3 text-sm text-[var(--text-tertiary)] text-center" colSpan={4}>
                            Keine Item Specifics zum Vergleichen vorhanden.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Gaps Section */}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    Gaps ({filteredGapList.length}/{gapList.length})
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    Letztes Audit: {formatDateTime(detail.gaps?.updatedAtIso || (detail.gaps?.updatedAt as any))}
                  </p>
                </div>

                {/* Gap Filters */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <select
                    value={gapStatusFilter}
                    onChange={(event) => {
                      setGapStatusFilter(event.target.value as GapStatusFilter);
                      setGapVisibleCount(25);
                    }}
                    className="px-2.5 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] appearance-none cursor-pointer transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
                  >
                    {GAP_STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        Status: {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={gapSeverityFilter}
                    onChange={(event) => {
                      setGapSeverityFilter(event.target.value as GapSeverityFilter);
                      setGapVisibleCount(25);
                    }}
                    className="px-2.5 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] appearance-none cursor-pointer transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
                  >
                    {GAP_SEVERITY_FILTER_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        Severity: {option.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={gapSearch}
                    onChange={(event) => {
                      setGapSearch(event.target.value);
                      setGapVisibleCount(25);
                    }}
                    placeholder="Gap suchen (Feld, Text, Wert)"
                    className="px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
                  />
                </div>

                {/* Gap Bulk Actions */}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedGapIds((prev) => {
                        if (allVisibleSelected) {
                          const next = { ...prev };
                          visibleGapIds.forEach((id) => {
                            delete next[id];
                          });
                          return next;
                        }
                        const next = { ...prev };
                        visibleGapIds.forEach((id) => {
                          next[id] = true;
                        });
                        return next;
                      })
                    }
                    disabled={selectableGapCount === 0}
                    className="rounded-lg px-2 py-1 text-2xs font-semibold bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-all duration-200 disabled:opacity-50"
                  >
                    {allVisibleSelected ? 'Sichtbare abwaehlen' : 'Sichtbare markieren'}
                  </button>
                  <span className="text-2xs text-[var(--text-tertiary)]">
                    Ausgewaehlt: {selectedVisibleGapIds.length}/{selectableGapCount}
                  </span>
                  <select
                    value={gapBulkAction}
                    onChange={(event) => setGapBulkAction(event.target.value as GapBulkAction)}
                    className="px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-2xs text-[var(--text-primary)] appearance-none cursor-pointer"
                  >
                    {GAP_BULK_ACTION_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void executeSelectedGapBulkAction(selectedVisibleGapIds, gapBulkAction)}
                    disabled={!selectedVisibleGapIds.length || Boolean(busyAction)}
                    className="rounded-lg px-2.5 py-1 text-2xs font-semibold bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Aktion auf Auswahl ausfuehren
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedGapIds({})}
                    disabled={!selectedVisibleGapIds.length}
                    className="rounded-lg px-2 py-1 text-2xs font-semibold bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] transition-all duration-200 disabled:opacity-50"
                  >
                    Auswahl leeren
                  </button>
                </div>

                {/* Gaps Table */}
                <div className="max-h-[42vh] overflow-auto rounded-lg border border-[var(--border)]">
                  <table className="w-full border-collapse text-2xs">
                    <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                      <tr>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left w-8">#</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Feld</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Status</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Severity</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">Typ</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">eBay</th>
                        <th className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide py-2.5 px-3 border-b border-[var(--border)] text-left">AvyCloud</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGapList.map((gap, index) => {
                        const gapId = safeString(gap.id);
                        const rowKey = gapId || `gap-${index}`;
                        return (
                          <tr key={rowKey} className="border-b border-[var(--border)] last:border-b-0 transition-colors duration-100 hover:bg-[var(--surface-hover)]">
                            <td className="py-2 px-3 align-top">
                              {gapId ? (
                                <input
                                  type="checkbox"
                                  checked={Boolean(selectedGapIds[gapId])}
                                  onChange={(event) =>
                                    setSelectedGapIds((prev) => ({
                                      ...prev,
                                      [gapId]: event.target.checked,
                                    }))
                                  }
                                  className="accent-[var(--avy-purple)] w-3.5 h-3.5 rounded"
                                />
                              ) : (
                                <span className="text-[var(--text-tertiary)]">-</span>
                              )}
                            </td>
                            <td className="py-2 px-3 align-top text-[var(--text-primary)]">
                              <p className="font-semibold">{safeString(gap.field) || '-'}</p>
                              {safeString(gap.message) && (
                                <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">{clipText(gap.message, 140)}</p>
                              )}
                            </td>
                            <td className="py-2 px-3 align-top">
                              <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${statusBadgeClass(gap.status)}`}>
                                {safeString(gap.status) || '-'}
                              </span>
                            </td>
                            <td className="py-2 px-3 align-top">
                              <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${statusBadgeClass(gap.severity)}`}>
                                {safeString(gap.severity) || '-'}
                              </span>
                            </td>
                            <td className="py-2 px-3 align-top text-[var(--text-secondary)]">{safeString(gap.type) || '-'}</td>
                            <td className="py-2 px-3 align-top text-[var(--text-secondary)]">
                              {clipText(toDisplayValue(gap.listingValue), 120)}
                            </td>
                            <td className="py-2 px-3 align-top text-[var(--text-secondary)]">
                              {clipText(toDisplayValue(gap.avyValue), 120)}
                            </td>
                          </tr>
                        );
                      })}
                      {filteredGapList.length === 0 && (
                        <tr>
                          <td className="py-8 px-3 text-sm text-[var(--text-tertiary)] text-center" colSpan={7}>
                            Keine Gaps fuer diese Filter gefunden.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {hiddenGapCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setGapVisibleCount((prev) => prev + 25)}
                    className="w-full rounded-lg px-3 py-2.5 text-xs font-semibold bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] hover:shadow-sm transition-all duration-200"
                  >
                    Mehr laden ({hiddenGapCount} weitere Gaps)
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── Dry-Run / Apply Results ─── */}
      {(dryRunResult || applyResult) && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 space-y-4">
          {dryRunResult && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">Dry-Run Ergebnis</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Total: {dryRunResult.summary.total} | Ready: {dryRunResult.summary.ready} | Blocked:{' '}
                {dryRunResult.summary.blocked}
              </p>
              <div className="max-h-48 overflow-auto space-y-1.5">
                {dryRunResult.items.map((item) => (
                  <div
                    key={item.itemId}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      item.canApply
                        ? 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]'
                        : 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error)]'
                    }`}
                  >
                    {item.itemId} | {item.canApply ? 'ready' : 'blocked'} | {item.blockers.join('; ') || '-'}
                  </div>
                ))}
              </div>
            </div>
          )}
          {applyResult && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">Apply Ergebnis</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Total: {applyResult.summary.total} | Success: {applyResult.summary.success} | Failed:{' '}
                {applyResult.summary.failed} | Skipped: {applyResult.summary.skipped}
              </p>
              <div className="max-h-48 overflow-auto space-y-1.5">
                {applyResult.results.map((item) => (
                  <div
                    key={item.itemId}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      item.ok
                        ? 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]'
                        : item.skipped
                          ? 'border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]'
                          : 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error)]'
                    }`}
                  >
                    {item.itemId} | {item.ok ? 'ok' : item.skipped ? 'skipped' : 'failed'} | {safeString(item.message) || '-'}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
