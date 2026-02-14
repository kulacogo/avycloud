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
  return `${raw.slice(0, maxLength)}…`;
};

const GAP_ACTIONS = [
  { id: 'review', label: 'Review' },
  { id: 'accept_avy', label: 'Avy uebernehmen' },
  { id: 'accept_ebay', label: 'eBay behalten' },
  { id: 'ready_to_sync', label: 'Ready to Sync' },
  { id: 'ignore', label: 'Ignore' },
  { id: 'reset', label: 'Reset' },
] as const;

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

  return (
    <div className="max-w-7xl mx-auto space-y-4">
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
              onClick={() => void loadListings()}
              disabled={loadingListings}
              className="rounded-xl bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('sync:listings', async () => {
                  const res = await syncEbayLiveListings({});
                  await loadListings();
                  setNotice(`Sync abgeschlossen (${res?.fetched ?? 0} Listings, ${res?.gaps ?? 0} Gap-Dokumente).`);
                })
              }
              disabled={busyAction === 'sync:listings'}
              className="rounded-xl bg-sky-600 hover:bg-sky-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Live Sync + Audit
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              void runAction('links:rebuild', async () => {
                const res = await rebuildEbayListingLinks({});
                await loadListings();
                setNotice(`Linking aktualisiert (${res?.matched ?? 0} matched, ${res?.unmatched ?? 0} unmatched).`);
              })
            }
            disabled={busyAction === 'links:rebuild'}
            className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Linking neu berechnen
          </button>
          <button
            type="button"
            onClick={() =>
              void runAction('gaps:rebuild', async () => {
                const res = await rebuildEbayGaps({});
                await loadListings();
                setNotice(`Gap Audit aktualisiert (${res?.totalListings ?? 0} Listings, ${res?.totalGaps ?? 0} Gaps).`);
              })
            }
            disabled={busyAction === 'gaps:rebuild'}
            className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Gap Audit neu berechnen
          </button>
          <button
            type="button"
            onClick={() =>
              void runAction('sync:dry-run', async () => {
                const payload = await runEbaySyncDryRun(selectedItemId ? [selectedItemId] : undefined);
                setDryRunResult(payload);
                setNotice('Dry-Run abgeschlossen.');
              })
            }
            disabled={busyAction === 'sync:dry-run'}
            className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Dry-Run {selectedItemId ? '(nur Auswahl)' : '(alle ready)'}
          </button>
          <button
            type="button"
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
            className="rounded-lg border border-emerald-500/60 bg-emerald-900/30 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-800/40 disabled:opacity-50"
          >
            Sync Apply {selectedItemId ? '(nur Auswahl)' : '(alle ready)'}
          </button>
          <button
            type="button"
            onClick={() =>
              void runAction('reports:generate', async () => {
                const reports = await generateEbayReports();
                setNotice(`Reports erstellt (${reports?.reportId || 'n/a'}).`);
              })
            }
            disabled={busyAction === 'reports:generate'}
            className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Reports generieren
          </button>
          <button
            type="button"
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
            className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/70 disabled:opacity-50"
          >
            Gaps aktualisieren
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

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-4 rounded-2xl border border-white/10 bg-slate-800/70 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-100">Listings ({listings.length})</p>
            {loadingListings && <p className="text-xs text-slate-400">Lade...</p>}
          </div>
          <div className="max-h-[72vh] overflow-auto space-y-2 pr-1">
            {listings.map((row) => {
              const active = row.itemId === selectedItemId;
              return (
                <button
                  key={row.itemId}
                  type="button"
                  onClick={() => setSelectedItemId(row.itemId)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    active ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500'
                  }`}
                >
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
                </button>
              );
            })}
            {!loadingListings && listings.length === 0 && (
              <p className="rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-3 text-sm text-slate-400">
                Keine Listings gefunden.
              </p>
            )}
          </div>
        </div>

        <div className="xl:col-span-8 rounded-2xl border border-white/10 bg-slate-800/70 p-4 space-y-4">
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
                <div className="max-h-[32vh] overflow-auto space-y-1 pr-1">
                  {specificsComparisonRows.map((row) => (
                    <div key={row.keyToken} className="rounded-lg border border-slate-700 bg-slate-950/50 p-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-100">{row.keyLabel}</p>
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
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                        <div className="rounded border border-slate-700 bg-slate-900/70 p-1.5 text-[11px] text-slate-200">
                          <span className="text-slate-400">eBay:</span> {row.ebayValue}
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/70 p-1.5 text-[11px] text-slate-200">
                          <span className="text-slate-400">AvyCloud:</span> {row.avyValue}
                        </div>
                      </div>
                    </div>
                  ))}
                  {specificsComparisonRows.length === 0 && (
                    <p className="rounded border border-slate-700 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
                      Keine Item Specifics zum Vergleichen vorhanden.
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-slate-100">Gaps ({gapList.length})</p>
                  <p className="text-xs text-slate-400">
                    Letztes Audit: {formatDateTime(detail.gaps?.updatedAtIso || detail.gaps?.updatedAt as any)}
                  </p>
                </div>
                <div className="space-y-2 max-h-[34vh] overflow-auto pr-1">
                  {gapList.map((gap, index) => (
                    <div key={safeString(gap.id) || `gap-${index}`} className="rounded-xl border border-slate-700 bg-slate-950/50 p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-200">
                          {safeString(gap.id) || '-'}
                        </span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusBadgeClass(gap.severity)}`}>
                          {safeString(gap.severity) || '-'}
                        </span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusBadgeClass(gap.status)}`}>
                          {safeString(gap.status) || '-'}
                        </span>
                        <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300">
                          {safeString(gap.type) || '-'}:{safeString(gap.field) || '-'}
                        </span>
                      </div>
                      {safeString(gap.message) && <p className="text-xs text-slate-300">{safeString(gap.message)}</p>}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div className="rounded border border-slate-700 bg-slate-900/70 p-2">
                          <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">eBay</p>
                          <pre className="text-[11px] whitespace-pre-wrap break-words text-slate-200">
                            {toDisplayValue(gap.listingValue)}
                          </pre>
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/70 p-2">
                          <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">AvyCloud</p>
                          <pre className="text-[11px] whitespace-pre-wrap break-words text-slate-200">
                            {toDisplayValue(gap.avyValue)}
                          </pre>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {GAP_ACTIONS.map((actionDef) => (
                          <button
                            key={actionDef.id}
                            type="button"
                            onClick={() => void handleGapAction(gap, actionDef.id)}
                            disabled={busyAction === `gap:${gap.id}:${actionDef.id}`}
                            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {actionDef.label}
                          </button>
                        ))}
                        {safeString(gap.suggestion?.from) && safeString(gap.suggestion?.to) && (
                          <button
                            type="button"
                            onClick={() => void handleGapAction(gap, 'rename_alias')}
                            disabled={busyAction === `gap:${gap.id}:rename_alias`}
                            className="rounded border border-sky-600/70 bg-sky-900/20 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-800/30 disabled:opacity-50"
                          >
                            Alias: {safeString(gap.suggestion?.from)} -&gt; {safeString(gap.suggestion?.to)}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {gapList.length === 0 && (
                    <p className="rounded border border-slate-700 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
                      Keine Gaps fuer dieses Listing gefunden.
                    </p>
                  )}
                </div>
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
