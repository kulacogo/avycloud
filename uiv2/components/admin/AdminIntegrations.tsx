import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Link2, Upload, Search } from 'lucide-react';
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
    return connected ? (
      <div className="integration-status connected">
        <span className="status-dot active" />Verbunden
      </div>
    ) : (
      <div className="integration-status disconnected">
        <span className="status-dot inactive" />Nicht verbunden
      </div>
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
      setError('Bitte eine CSV-Datei auswahlen.');
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
    <div className="integration-grid">
      {/* eBay Integration Card */}
      <div className="integration-card" style={{ gridColumn: '1 / -1' }}>
        <div className="integration-card-top">
          <div className="integration-logo" style={{ background: 'linear-gradient(135deg, #E53238, #F5AF02)', color: 'white', border: 'none' }}>
            eB
          </div>
          <div className="integration-info">
            <div className="integration-name">eBay.de Verbindung</div>
            {statusBadge}
          </div>
        </div>
        <div className="integration-desc">
          OAuth Login + Listing-Snapshots (MIP CSV Import / API-Read). Damit Improve/Chat wissen, was live ist und was fehlt.
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: 'var(--space-4)' }}>
          <button type="button" onClick={reload} disabled={loading} className="btn btn-secondary btn-sm">
            <RefreshCw size={12} />
            Status aktualisieren
          </button>
          <button type="button" onClick={handleConnect} disabled={loading} className="btn btn-primary btn-sm">
            <Link2 size={12} />
            Mit eBay verbinden
          </button>
        </div>

        <HelpDisclosure title="Technische Hinweise (wichtig)">
          <ul style={{ paddingLeft: '20px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            <li>
              eBay nutzt als <code>redirect_uri</code> den <b>RuName</b> (nicht die Callback-URL). Das muss im Backend als <code>EBAY_RU_NAME</code> konfiguriert sein.
            </li>
            <li>
              Fur Listing-Lesen via Inventory API reicht der Scope <code>sell.inventory.readonly</code> (Default). Fur spatere automatische Updates waren zusatzliche Write-Scopes notig.
            </li>
          </ul>
        </HelpDisclosure>

        {error && (
          <div className="alert alert-error" style={{ marginTop: 'var(--space-4)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
          {/* MIP CSV Import */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">MIP CSV Import</span>
            </div>
            <div style={{ padding: 'var(--space-4)' }}>
              <div className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
                Importiert Listing-Snapshots pro SKU (Titel, Beschreibung, Bilder, CategoryId, Item specifics). Duplikate pro SKU werden automatisch best-effort konsolidiert.
              </div>
              <div className="form-group">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
                  className="form-input"
                  style={{ padding: '8px' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button type="button" onClick={handleImport} disabled={!csvFile || loading} className="btn btn-success btn-sm">
                  <Upload size={12} />
                  Import starten
                </button>
                {csvFile && (
                  <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{csvFile.name}</span>
                )}
              </div>
              {importReport && (
                <pre style={{ marginTop: 'var(--space-3)', maxHeight: '200px', overflow: 'auto', borderRadius: 'var(--radius-md)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', padding: 'var(--space-3)', fontSize: '11px' }}>
{pretty(importReport)}
                </pre>
              )}
            </div>
          </div>

          {/* API Test */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">API Test (getOffers by SKU)</span>
            </div>
            <div style={{ padding: 'var(--space-4)' }}>
              <div className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
                Pruft live die eBay Inventory API Verbindung. Voraussetzung: eBay ist verbunden.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  value={testSku}
                  onChange={(e) => setTestSku(e.target.value)}
                  placeholder="SKU-123..."
                  className="form-input"
                  style={{ flex: 1 }}
                />
                <button type="button" onClick={handleTestOffers} disabled={!testSku.trim() || loading} className="btn btn-secondary btn-sm">
                  <Search size={12} />
                  Abrufen
                </button>
              </div>
              {offersError && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-3)' }}>
                  {offersError}
                </div>
              )}
              {offers && (
                <pre style={{ marginTop: 'var(--space-3)', maxHeight: '200px', overflow: 'auto', borderRadius: 'var(--radius-md)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', padding: 'var(--space-3)', fontSize: '11px' }}>
{pretty(offers)}
                </pre>
              )}
            </div>
          </div>
        </div>

        {status && (
          <details style={{ marginTop: 'var(--space-5)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', padding: 'var(--space-4)', background: 'var(--surface-secondary)' }}>
            <summary style={{ cursor: 'pointer', userSelect: 'none', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Debug: Verbindung (ohne Tokens)
            </summary>
            <pre style={{ marginTop: 'var(--space-3)', maxHeight: '200px', overflow: 'auto', fontSize: '11px', color: 'var(--text-primary)' }}>
{pretty(status)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};
