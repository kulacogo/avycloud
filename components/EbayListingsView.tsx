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
} from '../api/client';
import { EbayListingDetail, EbayListingRow, EbaySyncApplyResult, EbaySyncDryRunResult } from '../types';

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

const toDisplayValue = (value: any): string => {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.map((entry) => safeString(entry)).filter(Boolean).join(', ') || '-';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return safeString(value) || '-';
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

const statusBadgeClass = (status?: string | null): string => {
  const key = safeString(status).toLowerCase();
  if (key === 'matched' || key === 'synced') return 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40';
  if (key === 'ready_to_sync' || key === 'reviewed') return 'bg-sky-500/20 text-sky-200 border-sky-500/40';
  if (key === 'new' || key === 'warn') return 'bg-amber-500/20 text-amber-100 border-amber-500/40';
  if (key === 'critical' || key === 'failed' || key === 'unmatched') return 'bg-rose-500/20 text-rose-100 border-rose-500/40';
  if (key === 'ignored') return 'bg-slate-600/30 text-slate-200 border-slate-500/50';
  return 'bg-slate-700/40 text-slate-200 border-slate-500/40';
};

const extractProductSpecifics = (product: Record<string, any> | null | undefined): Record<string, string> => {
  if (!product) return {};
  const out: Record<string, string> = {};

  const applyObject = (obj: Record<string, any>) => {
    Object.entries(obj).forEach(([rawKey, rawValue]) => {
      const key = safeString(rawKey);
      if (!key) return;
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

const buildSpecificsText = (specifics: Record<string, any> | null | undefined): string => {
  if (!specifics || typeof specifics !== 'object') return '-';
  const rows = Object.entries(specifics)
    .map(([name, value]) => `${name}: ${toDisplayValue(value)}`)
    .sort((a, b) => a.localeCompare(b));
  return rows.length ? rows.join('\n') : '-';
};

const normalizeKeyToken = (value: any): string =>
  safeString(value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');

const normalizeSpecificKeyToken = (value: any): string => {
  const token = normalizeKeyToken(value);
  if (!token) return '';
  if (token === 'groesse' || token === 'size') return 'size';
  // eBay and product feeds may use EAN or GTIN for the same identifier.
  if (token === 'ean' || token === 'gtin') return 'gtin';
  return token;
};

const normalizeCompareText = (value: any): string => safeString(value).toLowerCase().replace(/\s+/g, ' ').trim();

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

  // eBay may expose identifiers in ProductListingDetails instead of ItemSpecifics.
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
  status: 'match' | 'different' | 'missing_ebay' | 'missing_avy';
};

const buildSpecificsComparisonRows = (
  ebaySpecifics: Record<string, any>,
  avySpecifics: Record<string, any>
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
    else if (!hasEbay && hasAvy) status = 'missing_ebay';
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
    different: 1,
    missing_avy: 2,
    match: 3,
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
  return `${raw.slice(0, maxLength)}…`;
};

const toValueArray = (value: any): string[] => {
  if (Array.isArray(value)) return value.map((entry) => safeString(entry)).filter(Boolean);
  const str = safeString(value);
  return str ? [str] : [];
};

const hasAnyValue = (value: any): boolean => toValueArray(value).length > 0;

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

export const EbayListingsView: React.FC = () => {
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

  const selectedListing = useMemo(
    () => listings.find((entry) => entry.itemId === selectedItemId) || null,
    [listings, selectedItemId]
  );

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
  const ebayViewItemUrl = safeString(listing?.viewItemUrl || listingNormalized?.viewItemUrl);

  const product = detail?.product || null;
  const productSpecifics = useMemo(() => extractProductSpecifics(product), [product]);
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
  const productDescription = safeString(product?.details?.description || product?.description);
  const specificsComparisonRows = useMemo(
    () => buildSpecificsComparisonRows(listingSpecifics, productSpecifics),
    [listingSpecifics, productSpecifics]
  );
  const specificsStats = useMemo(() => {
    const base = { match: 0, different: 0, missing_ebay: 0, missing_avy: 0 };
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
        ebayValue: clipText(ebayDescription, 220),
        avyValue: clipText(productDescription, 220),
        equal:
          normalizeCompareText(clipText(ebayDescription, 500)) ===
          normalizeCompareText(clipText(productDescription, 500)),
      },
    ];
    return rows;
  }, [
    ebayCategoryId,
    ebayCategoryText,
    ebayDescription,
    ebaySubtitle,
    ebayTitle,
    productCategoryId,
    productDescription,
    productSubtitle,
    productTitle,
  ]);
  const gapList = Array.isArray(detail?.gaps?.gaps) ? detail.gaps.gaps : [];
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

  return (
    <div className="w-full max-w-[1800px] mx-auto px-2 lg:px-4 space-y-4">
      <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-white">eBay Listings</h1>
            <p className="text-sm text-slate-400">
              Audit fuer Kategorie, Item Specifics und Content. Gap-Workflow mit kontrolliertem Sync zu eBay.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-lg border px-2 py-1 text-xs ${statusBadgeClass(tradingStatus?.connected ? 'synced' : 'failed')}`}>
              Trading API: {tradingStatus?.connected ? 'verbunden' : 'offline'}
            </span>
            <span className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300">
              Mode: {safeString(tradingStatus?.mode) || '-'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-4">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Suche nach Item ID, SKU oder Titel"
              className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-white"
            />
          </div>
          <div className="lg:col-span-2">
            <select
              value={matchStatus}
              onChange={(event) => setMatchStatus(event.target.value as any)}
              className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-3 text-white"
            >
              <option value="all">Match: Alle</option>
              <option value="matched">Matched</option>
              <option value="ambiguous">Ambiguous</option>
              <option value="unmatched">Unmatched</option>
            </select>
          </div>
          <div className="lg:col-span-2 flex items-center">
            <label className="inline-flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
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
              className="rounded-xl bg-sky-600 hover:bg-sky-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
              className="rounded-xl border border-emerald-600/70 bg-emerald-900/25 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-800/35 disabled:opacity-50"
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
              className="rounded-xl border border-emerald-500/60 bg-emerald-900/30 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-800/40 disabled:opacity-50"
            >
              Sync Apply{' '}
              {selectedListingIdList.length ? `(${selectedListingIdList.length} Auswahl)` : selectedItemId ? '(Auswahl)' : '(alle ready)'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/35 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Weitere Aktionen</span>
          <select
            value={advancedAction}
            onChange={(event) => setAdvancedAction(event.target.value as AdvancedActionKey)}
            className="rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white min-w-[220px]"
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
            className="rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Ausfuehren
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-700 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
          {safeString(error)}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-700 bg-emerald-900/30 px-4 py-3 text-sm text-emerald-50">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-4">
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-100">
              Listings ({filteredSortedListings.length}/{listings.length})
            </p>
            {loadingListings && <p className="text-xs text-slate-400">Lade...</p>}
          </div>
          <div className="space-y-2 mb-3">
            <input
              value={listingListSearch}
              onChange={(event) => setListingListSearch(event.target.value)}
              placeholder="In Liste filtern (Item ID, SKU, Titel)"
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={listingListFilter}
                onChange={(event) => setListingListFilter(event.target.value as ListingListFilter)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-2 text-xs text-white"
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
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-2 text-xs text-white"
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
                className="rounded border border-slate-600 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
              >
                {allVisibleListingsSelected ? 'Sichtbare abwaehlen' : 'Sichtbare markieren'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedListingIds({})}
                disabled={selectedListingIdList.length === 0}
                className="rounded border border-slate-600 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
              >
                Auswahl leeren
              </button>
              <span className="text-[11px] text-slate-300">
                Multi-Auswahl: {selectedListingIdList.length}
              </span>
            </div>
          </div>
          <div className="max-h-[72vh] overflow-auto space-y-2 pr-1">
            {filteredSortedListings.map((row) => {
              const active = row.itemId === selectedItemId;
              const checked = Boolean(selectedListingIds[row.itemId]);
              return (
                <div
                  key={row.itemId}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    active ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-300">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setSelectedListingIds((prev) => ({
                            ...prev,
                            [row.itemId]: event.target.checked,
                          }))
                        }
                        className="accent-sky-500"
                      />
                      Auswaehlen
                    </label>
                    <button
                      type="button"
                      onClick={() => setSelectedItemId(row.itemId)}
                      className="rounded border border-slate-600 bg-slate-900/60 px-2 py-0.5 text-[10px] text-slate-100 hover:bg-slate-800/70"
                    >
                      Details
                    </button>
                  </div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-slate-400 truncate">Item ID: {row.itemId}</p>
                      <p className="text-sm font-semibold text-white truncate">{safeString(row.title) || '-'}</p>
                      <p className="text-xs text-slate-400 truncate">SKU: {safeString(row.sku) || '-'}</p>
                    </div>
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(row.matchStatus)}`}>
                      {safeString(row.matchStatus) || 'n/a'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300">
                      Gaps: {row.gapCount ?? 0}
                    </span>
                    <span className="rounded border border-rose-700/70 px-1.5 py-0.5 text-[10px] text-rose-200">
                      Crit: {row.gapCriticalCount ?? 0}
                    </span>
                    <span className="rounded border border-sky-700/70 px-1.5 py-0.5 text-[10px] text-sky-200">
                      Ready: {row.gapReadyCount ?? 0}
                    </span>
                  </div>
                </div>
              );
            })}
            {!loadingListings && filteredSortedListings.length === 0 && (
              <p className="rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-3 text-sm text-slate-400">
                Keine Listings fuer die aktuellen Filter gefunden.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 space-y-4">
          {!selectedItemId ? (
            <p className="text-sm text-slate-400">Bitte ein Listing auswaehlen.</p>
          ) : loadingDetail ? (
            <p className="text-sm text-slate-400">Lade Listing-Details...</p>
          ) : !detail ? (
            <p className="text-sm text-slate-400">Keine Detaildaten verfuegbar.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 space-y-1">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Listing</p>
                  <p className="text-sm text-white font-semibold">{ebayTitle || '-'}</p>
                  <p className="text-xs text-slate-300">Item ID: {safeString(detail.listing?.itemId) || '-'}</p>
                  <p className="text-xs text-slate-300">SKU: {safeString(detail.listing?.sku) || '-'}</p>
                  <p className="text-xs text-slate-300">Kategorie: {ebayCategoryText}</p>
                  <p className="text-xs text-slate-400">Zuletzt aktualisiert: {formatDateTime(detail.listing?.updatedAt)}</p>
                  {ebayViewItemUrl && (
                    <a
                      href={ebayViewItemUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-md border border-sky-700/70 bg-sky-900/20 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-800/30"
                    >
                      Auf eBay oeffnen
                    </a>
                  )}
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 space-y-1">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Linking</p>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(detail.link?.status)}`}>
                      {safeString(detail.link?.status) || 'n/a'}
                    </span>
                    <span className="text-xs text-slate-300">Method: {safeString(detail.link?.method) || '-'}</span>
                  </div>
                  <p className="text-xs text-slate-300">Product ID: {safeString(detail.link?.productId) || '-'}</p>
                  <p className="text-xs text-slate-300">Confidence: {toDisplayValue(detail.link?.confidence)}</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100">Direktvergleich (eBay vs AvyCloud)</p>
                  <p className="text-xs text-slate-400">Kernaussagen auf einen Blick</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {fieldComparisonRows.map((row) => (
                    <div
                      key={row.key}
                      className={`rounded-lg border p-2 ${
                        row.equal
                          ? 'border-emerald-700/60 bg-emerald-900/15'
                          : 'border-amber-700/60 bg-amber-900/15'
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-100">{row.label}</p>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                            row.equal
                              ? 'border-emerald-600/70 text-emerald-200'
                              : 'border-amber-600/70 text-amber-200'
                          }`}
                        >
                          {row.equal ? 'gleich' : 'abweichung'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-[11px]">
                        <div className="rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-slate-200">
                          <span className="text-slate-400">eBay: </span>
                          {row.ebayValue}
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-slate-200">
                          <span className="text-slate-400">AvyCloud: </span>
                          {row.avyValue}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100">Item Specifics Vergleich ({specificsComparisonRows.length})</p>
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    <span className="rounded border border-rose-700/70 px-1.5 py-0.5 text-rose-200">
                      Fehlt auf eBay: {specificsStats.missing_ebay}
                    </span>
                    <span className="rounded border border-amber-700/70 px-1.5 py-0.5 text-amber-200">
                      Unterschiedlich: {specificsStats.different}
                    </span>
                    <span className="rounded border border-slate-600 px-1.5 py-0.5 text-slate-200">
                      Nur eBay: {specificsStats.missing_avy}
                    </span>
                    <span className="rounded border border-emerald-700/70 px-1.5 py-0.5 text-emerald-200">
                      Gleich: {specificsStats.match}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/45 px-2.5 py-2">
                  <span className="text-[11px] font-semibold text-slate-300">Direktaktion:</span>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('missing_ebay', 'Fehlende Item Specifics')}
                    disabled={itemSpecificGapModes.missing_ebay.length === 0 || Boolean(busyAction)}
                    className="rounded border border-rose-600/70 bg-rose-900/20 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-800/30 disabled:opacity-50"
                  >
                    Fehlende auf eBay syncen ({itemSpecificGapModes.missing_ebay.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('different', 'Abweichende Item Specifics')}
                    disabled={itemSpecificGapModes.different.length === 0 || Boolean(busyAction)}
                    className="rounded border border-amber-600/70 bg-amber-900/20 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-800/30 disabled:opacity-50"
                  >
                    Abweichungen syncen ({itemSpecificGapModes.different.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => void runItemSpecificSyncFlow('all', 'Alle Item Specifics')}
                    disabled={itemSpecificGapModes.all.length === 0 || Boolean(busyAction)}
                    className="rounded border border-emerald-600/70 bg-emerald-900/20 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-800/30 disabled:opacity-50"
                  >
                    Alle Item Specifics syncen ({itemSpecificGapModes.all.length})
                  </button>
                </div>

                <div className="max-h-[34vh] overflow-auto rounded-lg border border-slate-700">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 z-10 bg-slate-900/95 text-slate-300">
                      <tr>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Attribut</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Status</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">eBay</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">AvyCloud</th>
                      </tr>
                    </thead>
                    <tbody>
                      {specificsComparisonRows.map((row) => (
                        <tr key={row.keyToken} className="odd:bg-slate-950/25">
                          <td className="border-b border-slate-800 px-2 py-1.5 text-slate-100">{row.keyLabel}</td>
                          <td className="border-b border-slate-800 px-2 py-1.5">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                                row.status === 'match'
                                  ? 'border-emerald-600/70 text-emerald-200'
                                  : row.status === 'missing_ebay'
                                    ? 'border-rose-600/70 text-rose-200'
                                    : row.status === 'missing_avy'
                                      ? 'border-slate-500/70 text-slate-200'
                                      : 'border-amber-600/70 text-amber-200'
                              }`}
                            >
                              {row.status === 'match'
                                ? 'gleich'
                                : row.status === 'missing_ebay'
                                  ? 'fehlt auf ebay'
                                  : row.status === 'missing_avy'
                                    ? 'nur ebay'
                                    : 'abweichend'}
                            </span>
                          </td>
                          <td className="border-b border-slate-800 px-2 py-1.5 text-slate-200">{clipText(row.ebayValue, 180)}</td>
                          <td className="border-b border-slate-800 px-2 py-1.5 text-slate-200">{clipText(row.avyValue, 180)}</td>
                        </tr>
                      ))}
                      {specificsComparisonRows.length === 0 && (
                        <tr>
                          <td className="px-3 py-2 text-slate-400" colSpan={4}>
                            Keine Item Specifics zum Vergleichen vorhanden.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100">
                    Gaps ({filteredGapList.length}/{gapList.length})
                  </p>
                  <p className="text-xs text-slate-400">
                    Letztes Audit: {formatDateTime(detail.gaps?.updatedAtIso || (detail.gaps?.updatedAt as any))}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <select
                    value={gapStatusFilter}
                    onChange={(event) => {
                      setGapStatusFilter(event.target.value as GapStatusFilter);
                      setGapVisibleCount(25);
                    }}
                    className="rounded-lg bg-slate-950 border border-slate-700 px-2 py-2 text-xs text-slate-100"
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
                    className="rounded-lg bg-slate-950 border border-slate-700 px-2 py-2 text-xs text-slate-100"
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
                    className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-100"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/45 px-2.5 py-2">
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
                    className="rounded border border-slate-600 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
                  >
                    {allVisibleSelected ? 'Sichtbare abwaehlen' : 'Sichtbare markieren'}
                  </button>
                  <span className="text-[11px] text-slate-300">
                    Ausgewaehlt: {selectedVisibleGapIds.length}/{selectableGapCount}
                  </span>
                  <select
                    value={gapBulkAction}
                    onChange={(event) => setGapBulkAction(event.target.value as GapBulkAction)}
                    className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] text-slate-100"
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
                    className="rounded border border-sky-600/70 bg-sky-900/25 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-800/35 disabled:opacity-50"
                  >
                    Aktion auf Auswahl ausfuehren
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedGapIds({})}
                    disabled={!selectedVisibleGapIds.length}
                    className="rounded border border-slate-600 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
                  >
                    Auswahl leeren
                  </button>
                </div>

                <div className="max-h-[42vh] overflow-auto rounded-lg border border-slate-700">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 z-10 bg-slate-900/95 text-slate-300">
                      <tr>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium w-8">#</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Feld</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Status</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Severity</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">Typ</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">eBay</th>
                        <th className="border-b border-slate-700 px-2 py-1.5 text-left font-medium">AvyCloud</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGapList.map((gap, index) => {
                        const gapId = safeString(gap.id);
                        const rowKey = gapId || `gap-${index}`;
                        return (
                          <tr key={rowKey} className="odd:bg-slate-950/25">
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top">
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
                                  className="accent-sky-500"
                                />
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top text-slate-100">
                              <p className="font-semibold">{safeString(gap.field) || '-'}</p>
                              {safeString(gap.message) && <p className="text-[10px] text-slate-400 mt-0.5">{clipText(gap.message, 140)}</p>}
                            </td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top">
                              <span className={`rounded border px-1.5 py-0.5 uppercase ${statusBadgeClass(gap.status)}`}>
                                {safeString(gap.status) || '-'}
                              </span>
                            </td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top">
                              <span className={`rounded border px-1.5 py-0.5 uppercase ${statusBadgeClass(gap.severity)}`}>
                                {safeString(gap.severity) || '-'}
                              </span>
                            </td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top text-slate-300">{safeString(gap.type) || '-'}</td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top text-slate-200">
                              {clipText(toDisplayValue(gap.listingValue), 120)}
                            </td>
                            <td className="border-b border-slate-800 px-2 py-1.5 align-top text-slate-200">
                              {clipText(toDisplayValue(gap.avyValue), 120)}
                            </td>
                          </tr>
                        );
                      })}
                      {filteredGapList.length === 0 && (
                        <tr>
                          <td className="px-3 py-2 text-slate-400" colSpan={7}>
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
                    className="w-full rounded border border-slate-600 bg-slate-900/50 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70"
                  >
                    Mehr laden ({hiddenGapCount} weitere Gaps)
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {(dryRunResult || applyResult) && (
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 space-y-3">
          {dryRunResult && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-100">Dry-Run Ergebnis</p>
              <p className="text-xs text-slate-300">
                Total: {dryRunResult.summary.total} | Ready: {dryRunResult.summary.ready} | Blocked:{' '}
                {dryRunResult.summary.blocked}
              </p>
              <div className="max-h-48 overflow-auto space-y-1">
                {dryRunResult.items.map((item) => (
                  <div key={item.itemId} className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-200">
                    {item.itemId} | {item.canApply ? 'ready' : 'blocked'} | {item.blockers.join('; ') || '-'}
                  </div>
                ))}
              </div>
            </div>
          )}
          {applyResult && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-100">Apply Ergebnis</p>
              <p className="text-xs text-slate-300">
                Total: {applyResult.summary.total} | Success: {applyResult.summary.success} | Failed:{' '}
                {applyResult.summary.failed} | Skipped: {applyResult.summary.skipped}
              </p>
              <div className="max-h-48 overflow-auto space-y-1">
                {applyResult.results.map((item) => (
                  <div key={item.itemId} className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-200">
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
