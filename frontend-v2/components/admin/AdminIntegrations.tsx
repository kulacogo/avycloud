import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EbayConnectionStatus,
  fetchEbayStatus,
  importEbayMipCsv,
  startEbayOAuth,
  fetchEbayOffersBySku,
} from '../../api/client';
import { HelpDisclosure } from '../shared/HelpDisclosure';

const pretty = (v: any) => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

export const AdminIntegrations: React.FC = () => {
  const [status, setStatus] = useState<EbayConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importReport, setImportReport] = useState<any>(null);

  const [testSku, setTestSku] = useState('');
  const [offers, setOffers] = useState<any>(null);
  const [offersError, setOffersError] = useState<string | null>(null);

  const connected = Boolean(status?.connected);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchEbayStatus();
      setStatus(next);
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const type = (event?.data as any)?.type;
      if (type === 'avycloud:ebay_oauth_complete') {
        reload();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [reload]);

  const statusBadge = useMemo(() => {
    const tone = connected
      ? 'text-[var(--success)] bg-[var(--success-bg)]'
      : 'text-[var(--text-secondary)] bg-[var(--surface-secondary)]';
    const label = connected ? 'Verbunden' : 'Nicht verbunden';
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? 'bg-[var(--success)]' : 'bg-[var(--text-tertiary)]'}`} />
        {label}
      </span>
    );
  }, [connected]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const url = await startEbayOAuth({ locale: 'de-DE', promptLogin: true });
      const popup = window.open(url, '_blank', 'noopener,noreferrer');
      if (!popup) {
        // Fallback: navigate in same tab if popups are blocked.
        window.location.assign(url);
      } else {
        try { popup.focus?.(); } catch {}
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!csvFile) {
      setError('Bitte eine CSV-Datei auswaehlen.');
      return;
    }
    setLoading(true);
    setError(null);
    setImportReport(null);
    try {
      const report = await importEbayMipCsv(csvFile);
      setImportReport(report);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [csvFile]);

  const handleTestOffers = useCallback(async () => {
    const sku = String(testSku || '').trim();
    if (!sku) return;
    setOffers(null);
    setOffersError(null);
    try {
      const data = await fetchEbayOffersBySku(sku);
      setOffers(data);
    } catch (e: any) {
      setOffersError(e?.message || String(e));
    }
  }, [testSku]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">eBay.de Verbindung</h3>
              {statusBadge}
            </div>
            <p className="text-sm text-[var(--text-tertiary)]">
              OAuth Login + Listing-Snapshots (MIP CSV Import / API-Read). Damit Improve/Chat wissen, was live ist und was fehlt.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reload}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
              disabled={loading}
            >
              Status aktualisieren
            </button>
            <button
              type="button"
              onClick={handleConnect}
              className="rounded-lg bg-[var(--avy-purple)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--avy-purple-hover)] transition-all duration-200"
              disabled={loading}
            >
              Mit eBay verbinden
            </button>
          </div>
        </div>

        <HelpDisclosure title="Technische Hinweise (wichtig)">
          <ul className="list-disc pl-5 space-y-1 text-sm text-[var(--text-secondary)]">
            <li>
              eBay nutzt als <code className="text-[var(--text-primary)]">redirect_uri</code> den <b>RuName</b> (nicht die Callback-URL). Das muss im Backend als <code className="text-[var(--text-primary)]">EBAY_RU_NAME</code> konfiguriert sein.
            </li>
            <li>
              Fuer Listing-Lesen via Inventory API reicht der Scope <code className="text-[var(--text-primary)]">sell.inventory.readonly</code> (Default). Fuer spaetere automatische Updates waeren zusaetzliche Write-Scopes noetig.
            </li>
          </ul>
        </HelpDisclosure>

        {error && (
          <div className="rounded-lg bg-[var(--error-bg)] p-3 text-sm text-[var(--error)] ring-1 ring-[var(--error-border)]">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">MIP CSV Import</h4>
            <p className="text-xs text-[var(--text-tertiary)]">
              Importiert Listing-Snapshots pro SKU (Titel, Beschreibung, Bilder, CategoryId, Item specifics). Duplikate pro SKU werden automatisch best-effort konsolidiert.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-[var(--text-secondary)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--surface-secondary)] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[var(--text-primary)] hover:file:bg-[var(--surface-hover)]"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImport}
                disabled={!csvFile || loading}
                className="rounded-lg bg-[var(--success)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
              >
                Import starten
              </button>
              {csvFile && (
                <span className="text-xs text-[var(--text-tertiary)]">{csvFile.name}</span>
              )}
            </div>
            {importReport && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--bg)] border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
{pretty(importReport)}
              </pre>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">API Test (getOffers by SKU)</h4>
            <p className="text-xs text-[var(--text-tertiary)]">
              Prueft live die eBay Inventory API Verbindung. Voraussetzung: eBay ist verbunden.
            </p>
            <div className="flex items-center gap-2">
              <input
                value={testSku}
                onChange={(e) => setTestSku(e.target.value)}
                placeholder="SKU-123..."
                className="w-full rounded-lg bg-[var(--bg)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)] transition-colors duration-200"
              />
              <button
                type="button"
                onClick={handleTestOffers}
                disabled={!testSku.trim() || loading}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
              >
                Abrufen
              </button>
            </div>
            {offersError && (
              <div className="rounded-lg bg-[var(--error-bg)] p-3 text-sm text-[var(--error)] ring-1 ring-[var(--error-border)]">
                {offersError}
              </div>
            )}
            {offers && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--bg)] border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
{pretty(offers)}
              </pre>
            )}
          </div>
        </div>

        {status && (
          <details className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
            <summary className="cursor-pointer select-none text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-150">
              Debug: Verbindung (ohne Tokens)
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto text-xs text-[var(--text-secondary)]">
{pretty(status)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};
