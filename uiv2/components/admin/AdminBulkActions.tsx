import React from 'react';
import { Play, RefreshCw, Upload, FileText, Trash2, Users } from 'lucide-react';
import { adminGetBulkJob, adminRunBulkAction } from '../../api/client';
import { Spinner } from '../Spinner';
import { Notice } from '../ui/Notice';

type Action = 'title' | 'price' | 'category' | 'ktype' | 'export_marketplace';

export const AdminBulkActions: React.FC = () => {
  const [action, setAction] = React.useState<Action>('price');
  const [apply, setApply] = React.useState(true);
  const [limit, setLimit] = React.useState(500);
  const [offset, setOffset] = React.useState(0);
  const [debug, setDebug] = React.useState(false);
  const [maxAgeDays, setMaxAgeDays] = React.useState(0);
  const [includeUi, setIncludeUi] = React.useState(false);

  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<any>(null);

  const canRun = !running;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setJob(null);
    setJobId(null);
    try {
      const res = await adminRunBulkAction({
        action,
        apply,
        limit,
        offset,
        debug,
        maxAgeDays: action === 'price' ? maxAgeDays : undefined,
        includeUi: action === 'title' ? includeUi : undefined,
      });
      setJobId(res.jobId);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const refreshJob = React.useCallback(async () => {
    if (!jobId) return;
    try {
      const data = await adminGetBulkJob(jobId);
      setJob(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [jobId]);

  React.useEffect(() => {
    if (!jobId) return;
    refreshJob();
    const t = setInterval(() => refreshJob(), 2500);
    return () => clearInterval(t);
  }, [jobId, refreshJob]);

  return (
    <>
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>Massenoperationen</div>
        <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Konsolidierte Bulk-Tasks fur Produkt-Details (Titel/Preis/Kategorie). Lauft asynchron als Admin-Job.</div>
      </div>

      {/* Main Bulk Action Config Card */}
      <div className="bulk-card" style={{ flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)', width: '100%' }}>
          <div className="bulk-info">
            <div className="bulk-title">Bulk Action starten</div>
            <div className="bulk-desc">Wahle die Aktion, konfiguriere die Parameter und starte den Job.</div>
          </div>
          <button type="button" onClick={run} disabled={running} className="btn btn-primary">
            {running ? <Spinner className="h-4 w-4" /> : <Play size={14} />}
            Start
          </button>
        </div>

        <div className="form-grid" style={{ width: '100%' }}>
          <div className="form-group">
            <label className="form-label">Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as Action)}
              className="form-select"
            >
              <option value="price">Preis refresh (NEW-only)</option>
              <option value="title">Titel normalisieren (Policy)</option>
              <option value="category">Kategorie IDs backfill (eBay/Kaufland)</option>
              <option value="ktype">K-Typ (noch nicht konsolidiert)</option>
              <option value="export_marketplace">Export Marketplace (CSV+JSON)</option>
            </select>
          </div>

          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
            <label className="toggle-row">
              <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
              <span>Write</span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
              <span>Debug</span>
            </label>
          </div>

          <div className="form-group">
            <label className="form-label">Limit</label>
            <input
              type="number"
              min={1}
              max={20000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 1)}
              className="form-input"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Offset</label>
            <input
              type="number"
              min={0}
              value={offset}
              onChange={(e) => setOffset(Math.max(0, Number(e.target.value) || 0))}
              className="form-input"
            />
          </div>
        </div>

        {action === 'price' && (
          <div className="form-group" style={{ width: '100%' }}>
            <label className="form-label">maxAgeDays <span className="form-label-sub">(0 = nur missing)</span></label>
            <input
              type="number"
              min={0}
              max={365}
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays(Math.max(0, Number(e.target.value) || 0))}
              className="form-input"
              style={{ maxWidth: '200px' }}
            />
          </div>
        )}

        {action === 'title' && (
          <div style={{ width: '100%' }}>
            <label className="toggle-row">
              <input type="checkbox" checked={includeUi} onChange={(e) => setIncludeUi(e.target.checked)} />
              <span>Auch UI-saved Produkte anfassen (includeUi)</span>
            </label>
          </div>
        )}

        {error && (
          <div style={{ width: '100%' }}>
            <Notice tone="error" title="Fehler" details={error} />
          </div>
        )}
      </div>

      {/* Static Bulk Action Cards (from mockup) */}
      <div className="bulk-card">
        <div className="bulk-icon" style={{ background: 'var(--info-bg)' }}>
          <Upload size={20} strokeWidth={1.5} style={{ color: 'var(--info)' }} />
        </div>
        <div className="bulk-info">
          <div className="bulk-title">CSV Import</div>
          <div className="bulk-desc">Importiere Benutzer aus einer CSV-Datei. Format: Name, E-Mail, Rolle, Gruppe.</div>
        </div>
        <div className="bulk-actions">
          <button type="button" className="btn btn-secondary btn-sm">Vorlage herunterladen</button>
          <button type="button" className="btn btn-primary btn-sm">Importieren</button>
        </div>
      </div>

      <div className="bulk-card">
        <div className="bulk-icon" style={{ background: 'var(--warning-bg)' }}>
          <Users size={20} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
        </div>
        <div className="bulk-info">
          <div className="bulk-title">Rollen zuweisen</div>
          <div className="bulk-desc">Weise mehreren Benutzern gleichzeitig eine neue Rolle zu.</div>
        </div>
        <div className="bulk-actions">
          <button type="button" className="btn btn-secondary btn-sm">Ausfuehren</button>
        </div>
      </div>

      <div className="bulk-card">
        <div className="bulk-icon" style={{ background: 'var(--success-bg)' }}>
          <FileText size={20} strokeWidth={1.5} style={{ color: 'var(--success)' }} />
        </div>
        <div className="bulk-info">
          <div className="bulk-title">Export Benutzerliste</div>
          <div className="bulk-desc">Exportiere alle Benutzer mit Rollen und Status als CSV- oder Excel-Datei.</div>
        </div>
        <div className="bulk-actions">
          <button type="button" className="btn btn-secondary btn-sm">CSV</button>
          <button type="button" className="btn btn-secondary btn-sm">Excel</button>
        </div>
      </div>

      <div className="bulk-card">
        <div className="bulk-icon" style={{ background: 'var(--error-bg)' }}>
          <Trash2 size={20} strokeWidth={1.5} style={{ color: 'var(--error)' }} />
        </div>
        <div className="bulk-info">
          <div className="bulk-title">Inaktive Benutzer bereinigen</div>
          <div className="bulk-desc">Deaktiviere oder loesche alle Benutzer, die sich seit uber 90 Tagen nicht angemeldet haben.</div>
        </div>
        <div className="bulk-actions">
          <button type="button" className="btn btn-danger btn-sm">Bereinigen</button>
        </div>
      </div>

      {/* Job Status */}
      {jobId && (
        <div className="card" style={{ marginTop: 'var(--space-5)' }}>
          <div className="card-header">
            <div>
              <span className="card-title">Job</span>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'monospace', marginTop: '2px' }}>{jobId}</div>
            </div>
            <button type="button" onClick={refreshJob} className="btn btn-secondary btn-sm">
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
          <div style={{ padding: 'var(--space-4)' }}>
            {job ? (
              <pre style={{ overflow: 'auto', whiteSpace: 'pre-wrap', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-secondary)', padding: 'var(--space-3)', fontSize: '11px', color: 'var(--text-primary)' }}>
                {JSON.stringify(job, null, 2)}
              </pre>
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Loading...</div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
