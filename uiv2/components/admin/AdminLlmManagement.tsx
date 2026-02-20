import React from 'react';
import { RefreshCw, Save, Zap } from 'lucide-react';
import {
  adminActivateLlmVersion,
  adminCreateLlmVersion,
  adminGetLlmScope,
  adminListLlmScopes,
  type AdminLlmScopeRecord,
} from '../../api/client';
import { Notice } from '../ui/Notice';

export const AdminLlmManagement: React.FC = () => {
  const [scopes, setScopes] = React.useState<AdminLlmScopeRecord[]>([]);
  const [selectedScopeId, setSelectedScopeId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [promptText, setPromptText] = React.useState('');
  const [rulesText, setRulesText] = React.useState('');
  const [promptMode, setPromptMode] = React.useState<'append' | 'replace'>('append');
  const [rulesMode, setRulesMode] = React.useState<'append' | 'replace'>('append');
  const [note, setNote] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);

  const loadScopes = React.useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const list = await adminListLlmScopes();
      const sorted = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      setScopes(sorted);
      if (!selectedScopeId && sorted.length) setSelectedScopeId(sorted[0].id);
    } catch (e: any) {
      setError(e?.message || 'Failed to load scopes');
    } finally {
      setLoading(false);
    }
  }, [selectedScopeId]);

  const loadDetail = React.useCallback(async (scopeId: string) => {
    setError(null);
    setLoading(true);
    try {
      const d = await adminGetLlmScope(scopeId);
      setDetail(d);
      // Prefill editor with the active version so current prompts/rules are visible.
      const active =
        d?.scope?.activeVersionId &&
        Array.isArray(d?.versions) &&
        d.versions.find((v: any) => String(v?.id) === String(d.scope.activeVersionId));

      setPromptText(active?.promptText || '');
      setRulesText(active?.rulesText || '');
      setPromptMode(active?.promptMode === 'replace' ? 'replace' : 'append');
      setRulesMode(active?.rulesMode === 'replace' ? 'replace' : 'append');
      setNote(active?.note || '');
    } catch (e: any) {
      setError(e?.message || 'Failed to load scope');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadScopes();
  }, [loadScopes]);

  React.useEffect(() => {
    if (selectedScopeId) {
      loadDetail(selectedScopeId);
    }
  }, [selectedScopeId, loadDetail]);

  const createVersion = async () => {
    if (!selectedScopeId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await adminCreateLlmVersion(selectedScopeId, {
        promptText,
        rulesText,
        promptMode,
        rulesMode,
        note: note || undefined,
      });
      await loadDetail(selectedScopeId);
      setNotice({ tone: 'success', title: 'Neue Version gespeichert und aktiviert' });
    } catch (e: any) {
      setError(e?.message || 'Failed to save version');
    } finally {
      setSaving(false);
    }
  };

  const activate = async (versionId: string) => {
    if (!selectedScopeId) return;
    setSaving(true);
    setError(null);
    try {
      await adminActivateLlmVersion(selectedScopeId, versionId);
      await loadDetail(selectedScopeId);
    } catch (e: any) {
      setError(e?.message || 'Failed to activate');
    } finally {
      setSaving(false);
    }
  };

  const scope = detail?.scope;
  const versions = Array.isArray(detail?.versions) ? detail.versions : [];

  return (
    <>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-5)' }}>
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      {/* LLM Config Card */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">LLM Provider Einstellungen</span>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Konfiguration der KI-Dienste</span>
        </div>
        <div style={{ padding: 'var(--space-6)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-6)' }}>
            {/* Scopes List */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>Scopes</span>
                <button type="button" onClick={loadScopes} disabled={loading} className="btn btn-secondary btn-sm">
                  <RefreshCw size={12} />
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {scopes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedScopeId(s.id)}
                    className={`btn ${selectedScopeId === s.id ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{s.name || s.id}</div>
                      <div style={{ fontSize: '11px', opacity: 0.7 }}>{s.id}</div>
                    </div>
                  </button>
                ))}
                {scopes.length === 0 && (
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Scopes.</div>
                )}
              </div>
            </div>

            {/* Scope Detail / Editor */}
            <div>
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{scope?.name || scope?.id || '--'}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{scope?.purpose || ''}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  Default Model Env: <code>{scope?.defaultModelEnvKey || '--'}</code> | Active Version:{' '}
                  <code>{scope?.activeVersionId || '--'}</code>
                </div>
              </div>

              {scope?.activeVersionId && (
                <div className="alert alert-info" style={{ marginBottom: 'var(--space-4)' }}>
                  <Zap size={14} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '12px' }}>Aktive Version: {scope.activeVersionId}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Felder unten sind mit der aktuell aktiven Version vorbelegt. Anderungen werden als neue Version gespeichert und automatisch aktiviert.
                    </div>
                  </div>
                </div>
              )}

              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">
                    Prompt Mode
                  </label>
                  <select
                    className="form-select"
                    value={promptMode}
                    onChange={(e) => setPromptMode(e.target.value as any)}
                  >
                    <option value="append">append</option>
                    <option value="replace">replace</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Rules Mode
                  </label>
                  <select
                    className="form-select"
                    value={rulesMode}
                    onChange={(e) => setRulesMode(e.target.value as any)}
                  >
                    <option value="append">append</option>
                    <option value="replace">replace</option>
                  </select>
                </div>
                <div className="form-group full">
                  <label className="form-label">Prompt Text (delta)</label>
                  <textarea
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    rows={6}
                    className="form-input"
                    style={{ fontFamily: 'monospace', fontSize: '12px', minHeight: '120px', resize: 'vertical' }}
                  />
                </div>
                <div className="form-group full">
                  <label className="form-label">Rules Text (delta)</label>
                  <textarea
                    value={rulesText}
                    onChange={(e) => setRulesText(e.target.value)}
                    rows={6}
                    className="form-input"
                    style={{ fontFamily: 'monospace', fontSize: '12px', minHeight: '120px', resize: 'vertical' }}
                  />
                </div>
                <div className="form-group full">
                  <label className="form-label">Note (optional)</label>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="form-input"
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: 'var(--space-5)', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={createVersion}
                  disabled={!selectedScopeId || saving}
                  className="btn btn-primary"
                >
                  <Save size={14} />
                  {saving ? 'Speichere...' : 'Neue Version speichern & aktivieren'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Versions */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Versions</span>
        </div>
        <div style={{ padding: 'var(--space-5)', maxHeight: '320px', overflowY: 'auto' }}>
          {versions.map((v: any) => (
            <div
              key={v.id}
              style={{
                padding: 'var(--space-3) var(--space-4)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-3)',
                background: scope?.activeVersionId === v.id ? 'var(--avy-purple-glow)' : 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  <code>{v.id}</code>{' '}
                  {scope?.activeVersionId === v.id && (
                    <span className="role-badge admin">ACTIVE</span>
                  )}
                  {v.note && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{v.note}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => activate(v.id)}
                  disabled={saving || scope?.activeVersionId === v.id}
                  className="btn btn-secondary btn-sm"
                >
                  Activate
                </button>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '6px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                <span>promptMode: <code>{v.promptMode || 'append'}</code></span>
                <span>rulesMode: <code>{v.rulesMode || 'append'}</code></span>
              </div>
            </div>
          ))}
          {versions.length === 0 && (
            <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Noch keine Versionen.</div>
          )}
        </div>
      </div>
    </>
  );
};
