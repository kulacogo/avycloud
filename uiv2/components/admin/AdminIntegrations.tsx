import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EbayConnectionStatus,
  fetchEbayStatus,
  importEbayMipCsv,
  startEbayOAuth,
  fetchEbayOffersBySku,
} from '../../api/client';
import { HelpDisclosure } from '../ui/HelpDisclosure';

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
    const tone = connected ? 'bg-[var(--success)]/20 text-[color:var(--success)] border-[var(--success-border)]' : 'bg-[var(--surface-hover)]/60 text-[color:var(--text-primary)] border-[var(--border)]';
    const label = connected ? 'Verbunden' : 'Nicht verbunden';
    return (
      <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${tone}`}>
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
      setError('Bitte eine CSV-Datei auswählen.');
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
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold">eBay.de Verbindung</h3>
              {statusBadge}
            </div>
            <p className="text-sm text-[color:var(--text-tertiary)]">
              OAuth Login + Listing-Snapshots (MIP CSV Import / API-Read). Damit Improve/Chat wissen, was live ist und was fehlt.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reload}
              className="rounded-xl bg-[var(--surface-hover)]/80 px-4 py-2 text-sm font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
              disabled={loading}
            >
              Status aktualisieren
            </button>
            <button
              type="button"
              onClick={handleConnect}
              className="rounded-xl bg-[var(--avy-purple)] px-4 py-2 text-sm font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)] transition-colors"
              disabled={loading}
            >
              Mit eBay verbinden
            </button>
          </div>
        </div>

        <HelpDisclosure title="Technische Hinweise (wichtig)">
          <ul className="list-disc pl-5 space-y-1 text-sm text-[color:var(--text-secondary)]">
            <li>
              eBay nutzt als <code>redirect_uri</code> den <b>RuName</b> (nicht die Callback-URL). Das muss im Backend als <code>EBAY_RU_NAME</code> konfiguriert sein.
            </li>
            <li>
              Für Listing-Lesen via Inventory API reicht der Scope <code>sell.inventory.readonly</code> (Default). Für spätere automatische Updates wären zusätzliche Write-Scopes nötig.
            </li>
          </ul>
        </HelpDisclosure>

        {error && (
          <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-sm text-[color:var(--error)]">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/30 p-4 space-y-3">
            <h4 className="font-semibold">MIP CSV Import</h4>
            <p className="text-xs text-[color:var(--text-tertiary)]">
              Importiert Listing-Snapshots pro SKU (Titel, Beschreibung, Bilder, CategoryId, Item specifics). Duplikate pro SKU werden automatisch „best-effort“ konsolidiert.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-[color:var(--text-primary)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--surface-hover)] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[color:var(--text-primary)] hover:file:bg-[var(--surface)]"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImport}
                disabled={!csvFile || loading}
                className="rounded-xl bg-[var(--success)] px-4 py-2 text-sm font-semibold text-[color:white] hover:bg-[var(--success)] disabled:opacity-60 transition-colors"
              >
                Import starten
              </button>
              {csvFile && (
                <span className="text-xs text-[color:var(--text-tertiary)]">{csvFile.name}</span>
              )}
            </div>
            {importReport && (
              <pre className="max-h-64 overflow-auto rounded-xl bg-[var(--bg)]/70 border border-[var(--border)] p-3 text-xs text-[color:var(--text-primary)]">
{pretty(importReport)}
              </pre>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/30 p-4 space-y-3">
            <h4 className="font-semibold">API Test (getOffers by SKU)</h4>
            <p className="text-xs text-[color:var(--text-tertiary)]">
              Prüft live die eBay Inventory API Verbindung. Voraussetzung: eBay ist verbunden.
            </p>
            <div className="flex items-center gap-2">
              <input
                value={testSku}
                onChange={(e) => setTestSku(e.target.value)}
                placeholder="SKU-123..."
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2 text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--avy-purple)]/40"
              />
              <button
                type="button"
                onClick={handleTestOffers}
                disabled={!testSku.trim() || loading}
                className="rounded-xl bg-[var(--surface-hover)]/80 px-4 py-2 text-sm font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
              >
                Abrufen
              </button>
            </div>
            {offersError && (
              <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-sm text-[color:var(--error)]">
                {offersError}
              </div>
            )}
            {offers && (
              <pre className="max-h-64 overflow-auto rounded-xl bg-[var(--bg)]/70 border border-[var(--border)] p-3 text-xs text-[color:var(--text-primary)]">
{pretty(offers)}
              </pre>
            )}
          </div>
        </div>

        {status && (
          <details className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/30 p-4">
            <summary className="cursor-pointer select-none text-sm font-semibold text-[color:var(--text-primary)]">
              Debug: Verbindung (ohne Tokens)
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto text-xs text-[color:var(--text-primary)]">
{pretty(status)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

