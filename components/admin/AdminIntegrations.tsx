import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EbayConnectionStatus,
  EbayRateLimitStatus,
  fetchEbayStatus,
  fetchEbayRateLimitStatus,
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

function rateLimitTone(used: number, max: number): string {
  const pct = max > 0 ? used / max : 0;
  if (pct >= 0.9) return "danger";
  if (pct >= 0.7) return "warning";
  return "success";
}

function RateLimitBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const tone = rateLimitTone(used, max);
  const barColor =
    tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-success";
  const textColor =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-success";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-txt-muted">{label}</span>
        <span className={`font-mono font-semibold ${textColor}`}>
          {used.toLocaleString("de-DE")} / {max.toLocaleString("de-DE")}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-app-surface overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RateLimitCard({ data }: { data: EbayRateLimitStatus }) {
  const dayTone = rateLimitTone(data.lastDay, data.limits.perDay);
  const borderTone =
    dayTone === "danger"
      ? "border-danger/40"
      : dayTone === "warning"
        ? "border-warning/40"
        : "border-app-border";

  return (
    <div className={`rounded-xl border ${borderTone} bg-app-bg/30 p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">API Rate Limit</h4>
        {data.queueLength > 0 && (
          <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning">
            {data.queueLength} in Warteschlange
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <RateLimitBar label="Pro Sekunde" used={data.lastSecond} max={data.limits.perSecond} />
        <RateLimitBar label="Pro Stunde" used={data.lastHour} max={data.limits.perHour} />
        <RateLimitBar label="Pro Tag" used={data.lastDay} max={data.limits.perDay} />
      </div>
    </div>
  );
}

export const AdminIntegrations: React.FC = () => {
  const [status, setStatus] = useState<EbayConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importReport, setImportReport] = useState<any>(null);

  const [testSku, setTestSku] = useState('');
  const [offers, setOffers] = useState<any>(null);
  const [offersError, setOffersError] = useState<string | null>(null);

  const [rateLimit, setRateLimit] = useState<EbayRateLimitStatus | null>(null);

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
    const loadRateLimit = () => {
      fetchEbayRateLimitStatus().then(setRateLimit).catch(() => setRateLimit(null));
    };
    loadRateLimit();
    const iv = setInterval(loadRateLimit, 30_000);
    return () => clearInterval(iv);
  }, []);

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
    const tone = connected ? 'bg-success-dim text-success border-success/30' : 'bg-app-surface text-txt-secondary border-app-border';
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
    <div className="space-y-5">
      <div className="rounded-2xl border border-app-border bg-app-bg/40 p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold">eBay.de Verbindung</h3>
              {statusBadge}
            </div>
            <p className="text-sm text-txt-muted">
              OAuth Login + Listing-Snapshots (MIP CSV Import / API-Read). Damit Improve/Chat wissen, was live ist und was fehlt.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reload}
              className="rounded-xl bg-app-elevated px-4 py-2 text-sm font-semibold text-txt-secondary hover:bg-app-elevated transition-colors"
              disabled={loading}
            >
              Status aktualisieren
            </button>
            <button
              type="button"
              onClick={handleConnect}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-txt-primary hover:bg-accent/80 transition-colors"
              disabled={loading}
            >
              Mit eBay verbinden
            </button>
          </div>
        </div>

        {rateLimit && (
          <RateLimitCard data={rateLimit} />
        )}

        <HelpDisclosure title="Technische Hinweise (wichtig)">
          <ul className="list-disc pl-5 space-y-1 text-sm text-txt-secondary">
            <li>
              eBay nutzt als <code>redirect_uri</code> den <b>RuName</b> (nicht die Callback-URL). Das muss im Backend als <code>EBAY_RU_NAME</code> konfiguriert sein.
            </li>
            <li>
              Für Listing-Lesen via Inventory API reicht der Scope <code>sell.inventory.readonly</code> (Default). Für spätere automatische Updates wären zusätzliche Write-Scopes nötig.
            </li>
          </ul>
        </HelpDisclosure>

        {error && (
          <div className="rounded-xl border border-danger/20 bg-danger-dim p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-app-border bg-app-bg/30 p-4 space-y-3">
            <h4 className="font-semibold">MIP CSV Import</h4>
            <p className="text-xs text-txt-muted">
              Importiert Listing-Snapshots pro SKU (Titel, Beschreibung, Bilder, CategoryId, Item specifics). Duplikate pro SKU werden automatisch „best-effort“ konsolidiert.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-txt-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-app-elevated file:px-3 file:py-2 file:text-sm file:font-semibold file:text-txt-secondary hover:file:bg-app-elevated/80"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImport}
                disabled={!csvFile || loading}
                className="rounded-xl bg-success px-4 py-2 text-sm font-semibold text-txt-primary hover:bg-success/80 disabled:opacity-60 transition-colors"
              >
                Import starten
              </button>
              {csvFile && (
                <span className="text-xs text-txt-muted">{csvFile.name}</span>
              )}
            </div>
            {importReport && (
              <pre className="max-h-64 overflow-auto rounded-xl bg-app-bg/70 border border-app-border p-3 text-xs text-txt-secondary">
{pretty(importReport)}
              </pre>
            )}
          </div>

          <div className="rounded-xl border border-app-border bg-app-bg/30 p-4 space-y-3">
            <h4 className="font-semibold">API Test (getOffers by SKU)</h4>
            <p className="text-xs text-txt-muted">
              Prüft live die eBay Inventory API Verbindung. Voraussetzung: eBay ist verbunden.
            </p>
            <div className="flex items-center gap-2">
              <input
                value={testSku}
                onChange={(e) => setTestSku(e.target.value)}
                placeholder="SKU-123..."
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
              <button
                type="button"
                onClick={handleTestOffers}
                disabled={!testSku.trim() || loading}
                className="rounded-xl bg-app-elevated px-4 py-2 text-sm font-semibold text-txt-secondary hover:bg-app-elevated transition-colors"
              >
                Abrufen
              </button>
            </div>
            {offersError && (
              <div className="rounded-xl border border-danger/20 bg-danger-dim p-3 text-sm text-danger">
                {offersError}
              </div>
            )}
            {offers && (
              <pre className="max-h-64 overflow-auto rounded-xl bg-app-bg/70 border border-app-border p-3 text-xs text-txt-secondary">
{pretty(offers)}
              </pre>
            )}
          </div>
        </div>

        {status && (
          <details className="rounded-xl border border-app-border bg-app-bg/30 p-4">
            <summary className="cursor-pointer select-none text-sm font-semibold text-txt-secondary">
              Debug: Verbindung (ohne Tokens)
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto text-xs text-txt-secondary">
{pretty(status)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

