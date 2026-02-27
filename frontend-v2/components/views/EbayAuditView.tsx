import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyEbayListingSuggestions,
  computeEbayListingAudit,
  fetchEbayListingAudit,
  fetchEbayLiveListings,
  fetchEbayTradingStatus,
  lightSyncEbayLiveListings,
} from '../../api/client';
import { EbayListingRow } from '../../types';

const safeString = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).trim();
  if (value instanceof Error) return safeString(value.message || value.name);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value).trim();
  }
};

const severityBadge = (severity: string) => {
  const key = safeString(severity).toLowerCase();
  if (key === 'critical') return 'bg-[var(--error-bg)] text-[var(--error)] border-[var(--error-border)]';
  if (key === 'warn' || key === 'warning') return 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]';
  return 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border)]';
};

export const EbayAuditView: React.FC = () => {
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [listings, setListings] = useState<EbayListingRow[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tradingStatus, setTradingStatus] = useState<any | null>(null);

  const [audit, setAudit] = useState<any | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [applyBusyId, setApplyBusyId] = useState<string | null>(null);

  const loadTradingStatus = useCallback(async () => {
    try {
      const status = await fetchEbayTradingStatus();
      setTradingStatus(status);
    } catch {
      setTradingStatus(null);
    }
  }, []);

  const loadListings = useCallback(async () => {
    setLoadingListings(true);
    setDetailError(null);
    try {
      const data = await fetchEbayLiveListings({
        limit: 200,
        search,
        includeInactive,
        matchStatus: 'all',
      });
      setListings(Array.isArray(data) ? data : []);
    } catch (err) {
      setListings([]);
      setDetailError(safeString(err?.message || err) || 'Listings konnten nicht geladen werden.');
    } finally {
      setLoadingListings(false);
    }
  }, [includeInactive, search]);

  const loadAudit = useCallback(async (itemId: string) => {
    const key = safeString(itemId);
    if (!key) return;
    setLoadingAudit(true);
    try {
      const data = await fetchEbayListingAudit(key);
      setAudit(data);
    } catch {
      setAudit(null);
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  const runAudit = useCallback(
    async (itemId: string, forceRefresh: boolean) => {
      const key = safeString(itemId);
      if (!key) return;
      setBusyAction('audit');
      setNotice(null);
      try {
        const data = await computeEbayListingAudit(key, { forceRefresh });
        setAudit(data);
        setNotice('Audit aktualisiert.');
      } catch (err) {
        setNotice(safeString(err?.message || err) || 'Audit fehlgeschlagen.');
      } finally {
        setBusyAction(null);
      }
    },
    []
  );

  const runLightSync = useCallback(async () => {
    setBusyAction('light-sync');
    setNotice(null);
    try {
      await lightSyncEbayLiveListings({});
      await loadListings();
      setNotice('Light Sync abgeschlossen.');
    } catch (err) {
      setNotice(safeString(err?.message || err) || 'Light Sync fehlgeschlagen.');
    } finally {
      setBusyAction(null);
    }
  }, [loadListings]);

  const onApplySuggestion = useCallback(
    async (suggestionId: string) => {
      if (!selectedItemId) return;
      const sid = safeString(suggestionId);
      if (!sid) return;
      setApplyBusyId(sid);
      setNotice(null);
      try {
        await applyEbayListingSuggestions(selectedItemId, { suggestionIds: [sid] });
        setNotice('Vorschlag uebernommen und an eBay gesendet.');
        await runAudit(selectedItemId, true);
        await runLightSync();
      } catch (err) {
        setNotice(safeString(err?.message || err) || 'Uebernahme fehlgeschlagen.');
      } finally {
        setApplyBusyId(null);
      }
    },
    [runAudit, runLightSync, selectedItemId]
  );

  useEffect(() => {
    void loadTradingStatus();
  }, [loadTradingStatus]);

  useEffect(() => {
    void loadListings();
  }, [loadListings]);

  const filteredListings = useMemo(() => {
    const needle = safeString(search).toLowerCase();
    if (!needle) return listings;
    return listings.filter((row) => {
      const hay = [row.itemId, row.sku, row.title].map((v) => safeString(v).toLowerCase()).join(' ');
      return hay.includes(needle);
    });
  }, [listings, search]);

  useEffect(() => {
    if (!filteredListings.length) return;
    if (!selectedItemId || !filteredListings.some((x) => x.itemId === selectedItemId)) {
      setSelectedItemId(filteredListings[0].itemId);
    }
  }, [filteredListings, selectedItemId]);

  useEffect(() => {
    if (!selectedItemId) return;
    void loadAudit(selectedItemId);
  }, [loadAudit, selectedItemId]);

  const selectedListing = useMemo(() => {
    if (!selectedItemId) return null;
    return filteredListings.find((x) => x.itemId === selectedItemId) || null;
  }, [filteredListings, selectedItemId]);

  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const suggestions = Array.isArray(audit?.suggestions) ? audit.suggestions : [];

  return (
    <section className="space-y-5">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">eBay Listing Audit</h1>
            <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">
              Ganzheitliche Pruefung (Titel/Keywords, Merkmale, Bilder, Beschreibung) mit konkreten Verbesserungsvorschlaegen.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold inline-flex items-center gap-1.5 ${
                tradingStatus?.connected
                  ? 'bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success-border)]'
                  : 'bg-[var(--error-bg)] text-[var(--error)] border border-[var(--error-border)]'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  tradingStatus?.connected ? 'bg-[var(--success)]' : 'bg-[var(--error)]'
                }`}
              />
              Trading API: {tradingStatus?.connected ? 'verbunden' : 'offline'}
            </span>
            <button
              type="button"
              onClick={() => void runLightSync()}
              disabled={busyAction === 'light-sync'}
              className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3.5 py-2 text-[13px] bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] active:translate-y-0 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Light Sync
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-6">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Suche nach Item ID, SKU oder Titel"
              className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)]"
            />
          </div>
          <div className="lg:col-span-3 flex items-center">
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
          <div className="lg:col-span-3 flex justify-end">
            <button
              type="button"
              onClick={() => void loadListings()}
              disabled={loadingListings}
              className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3.5 py-2 text-[13px] bg-[var(--surface-secondary)] text-[var(--text-secondary)] border border-[var(--border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Liste neu laden
            </button>
          </div>
        </div>
      </div>

      {detailError && (
        <div className="rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)]">
          {detailError}
        </div>
      )}
      {notice && (
        <div className="rounded-lg bg-[var(--surface-secondary)] border border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)]">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-5">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Listings ({filteredListings.length}/{listings.length})
            </p>
            {loadingListings && (
              <div className="w-4 h-4 border-2 border-[var(--border)] border-t-[var(--avy-purple)] rounded-full animate-spin" />
            )}
          </div>
          <div className="space-y-2 max-h-[70vh] overflow-auto pr-1">
            {filteredListings.map((row) => {
              const isSelected = row.itemId === selectedItemId;
              const title = safeString(row.title) || '(ohne Titel)';
              const sku = safeString(row.sku);
              return (
                <button
                  key={row.itemId}
                  type="button"
                  onClick={() => setSelectedItemId(row.itemId)}
                  className={`w-full text-left rounded-lg px-3 py-2 border transition-all ${
                    isSelected
                      ? 'bg-[var(--avy-purple-soft)] border-[var(--avy-purple)]'
                      : 'bg-[var(--surface)] border-[var(--border)] hover:border-[var(--border-hover)]'
                  }`}
                >
                  <div className="text-xs font-semibold text-[var(--text-primary)] line-clamp-2">{title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                    <span>Item: {row.itemId}</span>
                    {sku && <span>SKU: {sku}</span>}
                    {row.active === false && <span className="text-[var(--warning)]">inaktiv</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 space-y-4">
          {!selectedListing ? (
            <div className="text-sm text-[var(--text-secondary)]">Kein Listing ausgewaehlt.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
                    {safeString(selectedListing.title) || '(ohne Titel)'}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span>ItemId: {selectedListing.itemId}</span>
                    {safeString(selectedListing.sku) && <span>SKU: {safeString(selectedListing.sku)}</span>}
                    {safeString(selectedListing.primaryCategoryId) && <span>Kategorie: {safeString(selectedListing.primaryCategoryId)}</span>}
                    {safeString(selectedListing.viewItemUrl) && (
                      <a
                        className="text-[var(--avy-purple)] hover:underline"
                        href={safeString(selectedListing.viewItemUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Listing oeffnen
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runAudit(selectedListing.itemId, true)}
                    disabled={busyAction === 'audit'}
                    className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-3 py-2 text-[13px] bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success-border)] hover:shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Audit aktualisieren
                  </button>
                </div>
              </div>

              <div className="border-t border-[var(--border)] pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Audit</p>
                  <div className="text-xs text-[var(--text-tertiary)]">
                    {audit?.updatedAtIso ? `Stand: ${safeString(audit.updatedAtIso)}` : 'Noch kein Audit'}
                  </div>
                </div>

                {loadingAudit ? (
                  <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <div className="w-4 h-4 border-2 border-[var(--border)] border-t-[var(--avy-purple)] rounded-full animate-spin" />
                    Audit wird geladen…
                  </div>
                ) : !audit ? (
                  <div className="text-sm text-[var(--text-secondary)]">
                    Noch kein Audit vorhanden. Klicke „Audit aktualisieren“, um Findings & Vorschlaege zu erzeugen.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                        <div className="text-xs text-[var(--text-tertiary)]">Status</div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{safeString(audit.status) || '-'}</div>
                      </div>
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                        <div className="text-xs text-[var(--text-tertiary)]">Findings</div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{findings.length}</div>
                      </div>
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                        <div className="text-xs text-[var(--text-tertiary)]">Vorschlaege</div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{suggestions.length}</div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">Findings</div>
                      {findings.length === 0 ? (
                        <div className="text-sm text-[var(--text-secondary)]">Keine Findings.</div>
                      ) : (
                        <div className="space-y-2">
                          {findings.map((f: any) => (
                            <div
                              key={safeString(f?.id) || Math.random()}
                              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                                    {safeString(f?.title) || safeString(f?.id)}
                                  </div>
                                  {safeString(f?.message) && (
                                    <div className="text-xs text-[var(--text-secondary)] mt-1">{safeString(f.message)}</div>
                                  )}
                                </div>
                                <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${severityBadge(f?.severity)}`}>
                                  {safeString(f?.severity) || 'info'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">Vorschlaege</div>
                      {suggestions.length === 0 ? (
                        <div className="text-sm text-[var(--text-secondary)]">Keine Vorschlaege.</div>
                      ) : (
                        <div className="space-y-2">
                          {suggestions.map((s: any) => {
                            const id = safeString(s?.id);
                            const canApply = Boolean(s?.patch && s?.apply?.mode === 'trading_revise');
                            const isBusy = applyBusyId === id;
                            return (
                              <div key={id || Math.random()} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold text-[var(--text-primary)]">
                                      {safeString(s?.title) || id || 'Vorschlag'}
                                    </div>
                                    {safeString(s?.message) && (
                                      <div className="text-xs text-[var(--text-secondary)] mt-1">{safeString(s.message)}</div>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${severityBadge(s?.severity)}`}
                                    >
                                      {safeString(s?.severity) || 'info'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => void onApplySuggestion(id)}
                                      disabled={!canApply || isBusy}
                                      className="inline-flex items-center gap-1.5 rounded-lg font-semibold px-2.5 py-1.5 text-xs bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                                      title={canApply ? 'Vorschlag uebernehmen' : 'In v1 nicht automatisch anwendbar'}
                                    >
                                      {isBusy ? '...' : 'Uebernehmen'}
                                    </button>
                                  </div>
                                </div>

                                {s?.patch && (
                                  <pre className="mt-2 text-[11px] bg-[var(--surface-secondary)] border border-[var(--border)] rounded-lg p-2 overflow-auto">
                                    {JSON.stringify(s.patch, null, 2)}
                                  </pre>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
};

