import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyEbayGapAction,
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
import { EbayGap, EbayListingDetail, EbayListingRow, EbaySyncApplyResult, EbaySyncDryRunResult } from '../types';

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

const statusBadgeV2Class = (status?: string | null): string => {
  const key = safeString(status).toLowerCase();
  if (key === 'matched' || key === 'synced') return 'status-badge synced';
  if (key === 'ready_to_sync' || key === 'reviewed') return 'status-badge processing';
  if (key === 'new' || key === 'warn') return 'status-badge warning';
  if (key === 'critical' || key === 'failed' || key === 'unmatched') return 'status-badge error';
  if (key === 'ignored') return 'status-badge draft';
  return 'status-badge draft';
};

const gapBadgeClass = (severity?: string | null): string => {
  const key = safeString(severity).toLowerCase();
  if (key === 'critical' || key === 'failed') return 'gap-badge critical';
  if (key === 'warn' || key === 'warning' || key === 'new') return 'gap-badge warning';
  if (key === 'match' || key === 'synced' || key === 'matched') return 'gap-badge match';
  return 'gap-badge';
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
    product.details?.itemSpecifics,
    product.classification?.attributes,
    product.marketplace?.ebay?.itemSpecifics,
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

const normalizeKeyToken = (value: any): string => safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');

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
    const token = normalizeKeyToken(rawKey);
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
  return `${raw.slice(0, maxLength)}...`;
};

const GAP_ACTIONS = [
  { id: 'review', label: 'Review' },
  { id: 'accept_avy', label: 'Avy uebernehmen' },
  { id: 'accept_ebay', label: 'eBay behalten' },
  { id: 'ready_to_sync', label: 'Ready to Sync' },
  { id: 'ignore', label: 'Ignore' },
  { id: 'reset', label: 'Reset' },
] as const;

const ITEMS_PER_PAGE = 20;

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
  const [currentPage, setCurrentPage] = useState(1);
  const [showDetailPanel, setShowDetailPanel] = useState(false);

  const selectedListing = useMemo(
    () => listings.find((entry) => entry.itemId === selectedItemId) || null,
    [listings, selectedItemId]
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(listings.length / ITEMS_PER_PAGE));
  const paginatedListings = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return listings.slice(start, start + ITEMS_PER_PAGE);
  }, [listings, currentPage]);

  // KPI stats
  const kpiStats = useMemo(() => {
    const matched = listings.filter((r) => safeString(r.matchStatus).toLowerCase() === 'matched').length;
    const unmatched = listings.filter((r) => safeString(r.matchStatus).toLowerCase() === 'unmatched').length;
    const totalGaps = listings.reduce((sum, r) => sum + (r.gapCount ?? 0), 0);
    const totalCritical = listings.reduce((sum, r) => sum + (r.gapCriticalCount ?? 0), 0);
    return { total: listings.length, matched, unmatched, totalGaps, totalCritical };
  }, [listings]);

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
        limit: 300,
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

  const handleGapAction = useCallback(
    async (gap: EbayGap, action: string) => {
      if (!selectedItemId) return;
      await runAction(`gap:${gap.id}:${action}`, async () => {
        const alias =
          action === 'rename_alias'
            ? {
              [safeString(gap.suggestion?.from)]: safeString(gap.suggestion?.to),
            }
            : undefined;
        await applyEbayGapAction(selectedItemId, {
          gapId: gap.id,
          action,
          alias,
        });
        await loadDetail(selectedItemId);
        await loadListings();
        setNotice(`Gap ${gap.id} -> ${action}`);
      });
    },
    [selectedItemId, loadDetail, loadListings, runAction]
  );

  const handleRowClick = useCallback((itemId: string) => {
    setSelectedItemId(itemId);
    setShowDetailPanel(true);
  }, []);

  const listing = (detail?.listing && typeof detail.listing === 'object' ? detail.listing : {}) as Record<string, any>;
  const listingNormalized =
    listing?.normalized && typeof listing.normalized === 'object' ? (listing.normalized as Record<string, any>) : {};
  const listingSpecifics = mergeSpecificsMaps(
    (listing?.itemSpecifics as Record<string, any>) || {},
    (listingNormalized?.specifics as Record<string, any>) || {}
  );
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

  // Build page numbers for pagination
  const pageNumbers = useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('ellipsis');
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 2) pages.push('ellipsis');
      pages.push(totalPages);
    }
    return pages;
  }, [currentPage, totalPages]);

  return (
    <div className="content">
      {/* ===== PAGE HEADER ===== */}
      <div className="page-header">
        <div>
          <h1>eBay Listings</h1>
          <div className="page-header-sub">Synchronisation &amp; Listing-Verwaltung</div>
        </div>
        <div className="page-header-actions">
          <span className={`status-badge ${tradingStatus?.connected ? 'synced' : 'error'}`}>
            <span className="status-dot" />
            Trading API: {tradingStatus?.connected ? 'verbunden' : 'offline'}
          </span>
          <span className="status-badge draft">
            <span className="status-dot" />
            Mode: {safeString(tradingStatus?.mode) || '-'}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              void runAction('gaps:rebuild', async () => {
                const res = await rebuildEbayGaps({});
                await loadListings();
                setNotice(`Gap Audit aktualisiert (${res?.totalListings ?? 0} Listings, ${res?.totalGaps ?? 0} Gaps).`);
              })
            }
            disabled={busyAction === 'gaps:rebuild'}
          >
            Gap-Analyse
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void runAction('sync:listings', async () => {
                const res = await syncEbayLiveListings({});
                await loadListings();
                setNotice(`Sync abgeschlossen (${res?.fetched ?? 0} Listings, ${res?.gaps ?? 0} Gap-Dokumente).`);
              })
            }
            disabled={busyAction === 'sync:listings'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 7a5 5 0 01-5 5M2 7a5 5 0 015-5" />
              <path d="M9 4l2-2 2 2M5 10l-2 2-2-2" />
            </svg>
            Sync starten
          </button>
        </div>
      </div>

      {/* ===== ALERTS ===== */}
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-4)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
          </svg>
          {safeString(error)}
        </div>
      )}
      {notice && (
        <div className="alert alert-info" style={{ marginBottom: 'var(--space-4)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6" />
            <path d="M5.5 8l2 2 3-3" />
          </svg>
          {notice}
        </div>
      )}

      {/* ===== KPI CARDS ===== */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="var(--success)" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M5.5 8l2 2 3-3" />
              </svg>
              Gesamt Listings
            </div>
          </div>
          <div className="kpi-value" style={{ color: 'var(--success)' }}>{kpiStats.total}</div>
          <span className="kpi-change up">Matched: {kpiStats.matched}</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M6 6l4 4M10 6l-4 4" />
              </svg>
              Unmatched
            </div>
          </div>
          <div className="kpi-value">{kpiStats.unmatched}</div>
          <span className="kpi-change neutral">Bereit zum Matching</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="var(--warning)" strokeWidth="1.5">
                <path d="M8 2l6.5 11H1.5z" strokeLinejoin="round" />
                <path d="M8 6.5v3M8 11.5v.5" strokeLinecap="round" />
              </svg>
              Gaps
            </div>
          </div>
          <div className="kpi-value" style={{ color: 'var(--warning)' }}>{kpiStats.totalGaps}</div>
          <span className="kpi-change warn">Abweichungen erkannt</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="var(--error)" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
              </svg>
              Kritisch
            </div>
          </div>
          <div className="kpi-value" style={{ color: 'var(--error)' }}>{kpiStats.totalCritical}</div>
          <span className="kpi-change down">Sofortige Pruefung noetig</span>
        </div>
      </div>

      {/* ===== TABLE CARD ===== */}
      <div className="table-card">
        {/* Filter Bar */}
        <div className="filter-bar">
          <div className="filter-search">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M11 11l3 3" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Suche nach Item ID, SKU oder Titel..."
            />
          </div>
          <div className="filter-pills">
            <button
              type="button"
              className={`filter-pill ${matchStatus === 'all' ? 'active' : ''}`}
              onClick={() => setMatchStatus('all')}
            >
              Alle <span className="pill-count">{kpiStats.total}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${matchStatus === 'matched' ? 'active' : ''}`}
              onClick={() => setMatchStatus('matched')}
            >
              Matched
            </button>
            <button
              type="button"
              className={`filter-pill ${matchStatus === 'ambiguous' ? 'active' : ''}`}
              onClick={() => setMatchStatus('ambiguous')}
            >
              Ambiguous
            </button>
            <button
              type="button"
              className={`filter-pill ${matchStatus === 'unmatched' ? 'active' : ''}`}
              onClick={() => setMatchStatus('unmatched')}
            >
              Unmatched
            </button>
          </div>
          <label className="filter-pill" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              style={{ accentColor: 'var(--avy-purple)', marginRight: 4 }}
            />
            Inaktive
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void loadListings()}
              disabled={loadingListings}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 7a5 5 0 01-5 5M2 7a5 5 0 015-5" />
              </svg>
              Reload
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void runAction('links:rebuild', async () => {
                  const res = await rebuildEbayListingLinks({});
                  await loadListings();
                  setNotice(`Linking aktualisiert (${res?.matched ?? 0} matched, ${res?.unmatched ?? 0} unmatched).`);
                })
              }
              disabled={busyAction === 'links:rebuild'}
            >
              Linking
            </button>
          </div>
        </div>

        {/* Listings Table */}
        <div className="table-wrap">
          <table className="product-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>Nr.</th>
                <th>Produkt / SKU</th>
                <th>eBay Titel</th>
                <th>Match</th>
                <th style={{ textAlign: 'center' }}>Gaps</th>
                <th style={{ textAlign: 'center' }}>Kritisch</th>
                <th style={{ textAlign: 'center' }}>Ready</th>
                <th>Status</th>
                <th>Aktualisierung</th>
                <th style={{ width: 100 }}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {loadingListings && listings.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-tertiary)' }}>
                    Lade Listings...
                  </td>
                </tr>
              )}
              {!loadingListings && listings.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-tertiary)' }}>
                    Keine Listings gefunden.
                  </td>
                </tr>
              )}
              {paginatedListings.map((row, idx) => {
                const isSelected = row.itemId === selectedItemId;
                const rowIndex = (currentPage - 1) * ITEMS_PER_PAGE + idx + 1;
                return (
                  <tr
                    key={row.itemId}
                    className={isSelected ? 'selected' : ''}
                    onClick={() => handleRowClick(row.itemId)}
                  >
                    <td style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{rowIndex}</td>
                    <td>
                      <div className="product-cell">
                        <div className="product-info">
                          <div className="product-name">{safeString(row.title) || '-'}</div>
                          <div className="product-sku">
                            {safeString(row.sku) || '-'} | {row.itemId}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: 12, maxWidth: 220, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {safeString(row.title) || '-'}
                      </span>
                    </td>
                    <td>
                      <span className={statusBadgeV2Class(row.matchStatus)}>
                        <span className="status-dot" />
                        {safeString(row.matchStatus) || 'n/a'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={`gap-badge ${(row.gapCount ?? 0) > 0 ? 'warning' : 'match'}`}>
                        {row.gapCount ?? 0}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={`gap-badge ${(row.gapCriticalCount ?? 0) > 0 ? 'critical' : 'match'}`}>
                        {row.gapCriticalCount ?? 0}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className="gap-badge match">
                        {row.gapReadyCount ?? 0}
                      </span>
                    </td>
                    <td>
                      <span className={`ebay-badge ${safeString(row.matchStatus).toLowerCase() === 'matched' ? 'listed' : 'unlisted'}`}>
                        <span className="status-dot" />
                        {safeString(row.matchStatus).toLowerCase() === 'matched' ? 'Gelistet' : 'Offen'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {formatDateTime((row as any).updatedAt)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void runAction(`sync:single:${row.itemId}`, async () => {
                              const payload = await runEbaySyncApply([row.itemId]);
                              setApplyResult(payload);
                              await loadListings();
                              setNotice(`Sync fuer ${row.itemId} abgeschlossen.`);
                            });
                          }}
                          title="Sync"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M12 7a5 5 0 01-5 5M2 7a5 5 0 015-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRowClick(row.itemId);
                          }}
                          title="Detail"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M10 2l2 2-8 8H2v-2z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="pagination-bar">
          <div className="pagination-info">
            Zeige {listings.length === 0 ? 0 : (currentPage - 1) * ITEMS_PER_PAGE + 1}&ndash;{Math.min(currentPage * ITEMS_PER_PAGE, listings.length)} von {listings.length} Listings
          </div>
          <div className="pagination-buttons">
            <button
              type="button"
              className="page-btn"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            >
              &larr;
            </button>
            {pageNumbers.map((p, i) =>
              p === 'ellipsis' ? (
                <span key={`ell-${i}`} className="page-ellipsis">...</span>
              ) : (
                <button
                  key={p}
                  type="button"
                  className={`page-btn ${p === currentPage ? 'active' : ''}`}
                  onClick={() => setCurrentPage(p)}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              className="page-btn"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            >
              &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* ===== ACTION TOOLBAR ===== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 'var(--space-5)' }}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() =>
            void runAction('sync:dry-run', async () => {
              const payload = await runEbaySyncDryRun(selectedItemId ? [selectedItemId] : undefined);
              setDryRunResult(payload);
              setNotice('Dry-Run abgeschlossen.');
            })
          }
          disabled={busyAction === 'sync:dry-run'}
        >
          Dry-Run {selectedItemId ? '(nur Auswahl)' : '(alle ready)'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ background: 'var(--success)' }}
          onClick={() =>
            void runAction('sync:apply', async () => {
              const payload = await runEbaySyncApply(selectedItemId ? [selectedItemId] : undefined);
              setApplyResult(payload);
              await loadListings();
              if (selectedItemId) await loadDetail(selectedItemId);
              setNotice('Sync Apply abgeschlossen.');
            })
          }
          disabled={busyAction === 'sync:apply'}
        >
          Sync Apply {selectedItemId ? '(nur Auswahl)' : '(alle ready)'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() =>
            void runAction('reports:generate', async () => {
              const reports = await generateEbayReports();
              setNotice(`Reports erstellt (${reports?.reportId || 'n/a'}).`);
            })
          }
          disabled={busyAction === 'reports:generate'}
        >
          Reports generieren
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() =>
            void runAction('gaps:refresh', async () => {
              const docs = await fetchEbayGaps({ itemId: selectedItemId || undefined, limit: selectedItemId ? 1 : 20 });
              if (selectedItemId && docs.length) {
                setDetail((prev) => (prev ? { ...prev, gaps: docs[0] } : prev));
              }
              setNotice(`Gaps geladen (${docs.length}).`);
            })
          }
          disabled={busyAction === 'gaps:refresh'}
        >
          Gaps aktualisieren
        </button>
      </div>

      {/* ===== DRY-RUN / APPLY RESULTS ===== */}
      {(dryRunResult || applyResult) && (
        <div className="card" style={{ marginTop: 'var(--space-6)' }}>
          {dryRunResult && (
            <>
              <div className="card-header">
                <div className="card-title">Dry-Run Ergebnis</div>
              </div>
              <div className="card-body">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                  Total: {dryRunResult.summary.total} | Ready: {dryRunResult.summary.ready} | Blocked: {dryRunResult.summary.blocked}
                </p>
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Item ID</th>
                        <th>Status</th>
                        <th>Blockers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dryRunResult.items.map((item) => (
                        <tr key={item.itemId}>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{item.itemId}</td>
                          <td>
                            <span className={`status-badge ${item.canApply ? 'success' : 'error'}`}>
                              <span className="status-dot" />
                              {item.canApply ? 'ready' : 'blocked'}
                            </span>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{item.blockers.join('; ') || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {applyResult && (
            <>
              <div className="card-header">
                <div className="card-title">Apply Ergebnis</div>
              </div>
              <div className="card-body">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                  Total: {applyResult.summary.total} | Success: {applyResult.summary.success} | Failed: {applyResult.summary.failed} | Skipped: {applyResult.summary.skipped}
                </p>
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Item ID</th>
                        <th>Status</th>
                        <th>Nachricht</th>
                      </tr>
                    </thead>
                    <tbody>
                      {applyResult.results.map((item) => (
                        <tr key={item.itemId}>
                          <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{item.itemId}</td>
                          <td>
                            <span className={`status-badge ${item.ok ? 'success' : item.skipped ? 'warning' : 'error'}`}>
                              <span className="status-dot" />
                              {item.ok ? 'ok' : item.skipped ? 'skipped' : 'failed'}
                            </span>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{safeString(item.message) || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== DETAIL PANEL ===== */}
      {showDetailPanel && selectedItemId && (
        <div className="card" style={{ marginTop: 'var(--space-6)' }}>
          <div className="card-header">
            <div className="card-title">
              Listing Detail: {safeString(selectedListing?.title) || selectedItemId}
            </div>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowDetailPanel(false)}
            >
              Schliessen
            </button>
          </div>
          <div className="card-body">
            {loadingDetail ? (
              <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Lade Listing-Details...</p>
            ) : !detail ? (
              <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Keine Detaildaten verfuegbar.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                {/* Listing + Linking info */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                  <div className="card" style={{ padding: 'var(--space-4)' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: 8 }}>
                      eBay Listing
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                      {ebayTitle || '-'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                      Item ID: {safeString(detail.listing?.itemId) || '-'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                      SKU: {safeString(detail.listing?.sku) || '-'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                      Kategorie: {ebayCategoryText}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                      Zuletzt aktualisiert: {formatDateTime(detail.listing?.updatedAt)}
                    </div>
                    {ebayViewItemUrl && (
                      <a
                        href={ebayViewItemUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-xs btn-secondary"
                      >
                        Auf eBay oeffnen
                      </a>
                    )}
                  </div>
                  <div className="card" style={{ padding: 'var(--space-4)' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: 8 }}>
                      Linking
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className={statusBadgeV2Class(detail.link?.status)}>
                        <span className="status-dot" />
                        {safeString(detail.link?.status) || 'n/a'}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        Method: {safeString(detail.link?.method) || '-'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                      Product ID: {safeString(detail.link?.productId) || '-'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      Confidence: {toDisplayValue(detail.link?.confidence)}
                    </div>
                  </div>
                </div>

                {/* Direct comparison (eBay vs AvyCloud) */}
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Direktvergleich (eBay vs AvyCloud)</div>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Kernaussagen auf einen Blick</span>
                  </div>
                  <div className="card-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                      {fieldComparisonRows.map((row) => (
                        <div
                          key={row.key}
                          style={{
                            padding: 'var(--space-3)',
                            borderRadius: 'var(--radius-md)',
                            border: `1px solid ${row.equal ? 'var(--success-border)' : 'var(--warning-border)'}`,
                            background: row.equal ? 'var(--success-bg)' : 'var(--warning-bg)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{row.label}</span>
                            <span className={`status-badge ${row.equal ? 'success' : 'warning'}`} style={{ fontSize: 10 }}>
                              {row.equal ? 'gleich' : 'abweichung'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                              <span style={{ color: 'var(--text-tertiary)' }}>eBay: </span>{row.ebayValue}
                            </div>
                            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                              <span style={{ color: 'var(--text-tertiary)' }}>AvyCloud: </span>{row.avyValue}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Item Specifics comparison */}
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Item Specifics Vergleich ({specificsComparisonRows.length})</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span className="status-badge error" style={{ fontSize: 10 }}>Fehlt auf eBay: {specificsStats.missing_ebay}</span>
                      <span className="status-badge warning" style={{ fontSize: 10 }}>Unterschiedlich: {specificsStats.different}</span>
                      <span className="status-badge draft" style={{ fontSize: 10 }}>Nur eBay: {specificsStats.missing_avy}</span>
                      <span className="status-badge success" style={{ fontSize: 10 }}>Gleich: {specificsStats.match}</span>
                    </div>
                  </div>
                  <div className="card-body" style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {specificsComparisonRows.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Keine Item Specifics zum Vergleichen vorhanden.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {specificsComparisonRows.map((row) => (
                          <div
                            key={row.keyToken}
                            style={{
                              padding: 'var(--space-2) var(--space-3)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-md)',
                              background: 'var(--bg)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{row.keyLabel}</span>
                              <span
                                className={`status-badge ${
                                  row.status === 'match' ? 'success'
                                    : row.status === 'missing_ebay' ? 'error'
                                      : row.status === 'missing_avy' ? 'draft'
                                        : 'warning'
                                }`}
                                style={{ fontSize: 10 }}
                              >
                                {row.status === 'match'
                                  ? 'gleich'
                                  : row.status === 'missing_ebay'
                                    ? 'fehlt auf ebay'
                                    : row.status === 'missing_avy'
                                      ? 'nur ebay'
                                      : 'abweichend'}
                              </span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                              <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                                <span style={{ color: 'var(--text-tertiary)' }}>eBay:</span> {row.ebayValue}
                              </div>
                              <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                                <span style={{ color: 'var(--text-tertiary)' }}>AvyCloud:</span> {row.avyValue}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Gaps */}
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Gaps ({gapList.length})</div>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      Letztes Audit: {formatDateTime(detail.gaps?.updatedAtIso || detail.gaps?.updatedAt as any)}
                    </span>
                  </div>
                  <div className="card-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {gapList.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Keine Gaps fuer dieses Listing gefunden.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {gapList.map((gap, index) => (
                          <div
                            key={safeString(gap.id) || `gap-${index}`}
                            className="card"
                            style={{ padding: 'var(--space-4)' }}
                          >
                            {/* Gap header badges */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                              <span className="status-badge draft" style={{ fontSize: 10 }}>
                                {safeString(gap.id) || '-'}
                              </span>
                              <span className={statusBadgeV2Class(gap.severity)} style={{ fontSize: 10 }}>
                                <span className="status-dot" />
                                {safeString(gap.severity) || '-'}
                              </span>
                              <span className={statusBadgeV2Class(gap.status)} style={{ fontSize: 10 }}>
                                <span className="status-dot" />
                                {safeString(gap.status) || '-'}
                              </span>
                              <span className="status-badge draft" style={{ fontSize: 10 }}>
                                {safeString(gap.type) || '-'}:{safeString(gap.field) || '-'}
                              </span>
                            </div>

                            {/* Gap message */}
                            {safeString(gap.message) && (
                              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                                {safeString(gap.message)}
                              </p>
                            )}

                            {/* eBay vs AvyCloud values */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                              <div style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-secondary)' }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: 4 }}>eBay</div>
                                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)', margin: 0, fontFamily: 'inherit' }}>
                                  {toDisplayValue(gap.listingValue)}
                                </pre>
                              </div>
                              <div style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-secondary)' }}>
                                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: 4 }}>AvyCloud</div>
                                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)', margin: 0, fontFamily: 'inherit' }}>
                                  {toDisplayValue(gap.avyValue)}
                                </pre>
                              </div>
                            </div>

                            {/* Gap action buttons */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {GAP_ACTIONS.map((actionDef) => (
                                <button
                                  key={actionDef.id}
                                  type="button"
                                  className="btn btn-xs btn-secondary"
                                  onClick={() => void handleGapAction(gap, actionDef.id)}
                                  disabled={busyAction === `gap:${gap.id}:${actionDef.id}`}
                                >
                                  {actionDef.label}
                                </button>
                              ))}
                              {safeString(gap.suggestion?.from) && safeString(gap.suggestion?.to) && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  onClick={() => void handleGapAction(gap, 'rename_alias')}
                                  disabled={busyAction === `gap:${gap.id}:rename_alias`}
                                >
                                  Alias: {safeString(gap.suggestion?.from)} -&gt; {safeString(gap.suggestion?.to)}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
