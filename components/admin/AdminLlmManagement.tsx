import React from 'react';
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
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">Admin: LLM Management</h2>
        <p className="text-sm text-txt-muted">
          Listet die vorhandenen LLM-Einsatzbereiche (Scopes) und erlaubt Prompt/Rules Edits mit Versionierung.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Scopes</h3>
            <button
              type="button"
              onClick={loadScopes}
              disabled={loading}
              className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-txt-primary"
            >
              Refresh
            </button>
          </div>
          <div className="space-y-1">
            {scopes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedScopeId(s.id)}
                className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                  selectedScopeId === s.id ? 'bg-accent/50 text-txt-primary' : 'bg-app-bg/30 text-txt-secondary hover:bg-app-elevated/40'
                }`}
              >
                <div className="font-semibold">{s.name || s.id}</div>
                <div className="text-xs text-txt-muted">{s.id}</div>
              </button>
            ))}
            {scopes.length === 0 && <div className="text-sm text-txt-muted">Keine Scopes.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{scope?.name || scope?.id || '—'}</div>
            <div className="text-xs text-txt-muted">{scope?.purpose || ''}</div>
            <div className="text-xs text-txt-muted">
              Default Model Env: <code>{scope?.defaultModelEnvKey || '—'}</code> · Active Version:{' '}
              <code>{scope?.activeVersionId || '—'}</code>
            </div>
          </div>

          {scope?.activeVersionId && (
            <div className="rounded-xl border border-app-border bg-app-bg/40 p-3 text-xs text-txt-secondary">
              <div className="flex flex-wrap gap-3 items-center">
                <span className="font-semibold text-txt-primary">Aktive Version:</span>
                <span className="text-txt-primary">{scope.activeVersionId}</span>
              </div>
              <p className="mt-2 text-txt-muted">
                Felder unten sind mit der aktuell aktiven Version vorbelegt. Änderungen werden als neue Version gespeichert
                und automatisch aktiviert.
              </p>
            </div>
          )}

          <div className="rounded-xl border border-app-border bg-app-bg/20 p-4 space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-txt-secondary">
                Prompt Mode
                <select
                  className="ml-2 bg-app-bg/60 border border-app-border rounded-xl px-2 py-1 text-txt-primary"
                  value={promptMode}
                  onChange={(e) => setPromptMode(e.target.value as any)}
                >
                  <option value="append">append</option>
                  <option value="replace">replace</option>
                </select>
              </label>
              <label className="text-xs text-txt-secondary">
                Rules Mode
                <select
                  className="ml-2 bg-app-bg/60 border border-app-border rounded-xl px-2 py-1 text-txt-primary"
                  value={rulesMode}
                  onChange={(e) => setRulesMode(e.target.value as any)}
                >
                  <option value="append">append</option>
                  <option value="replace">replace</option>
                </select>
              </label>
            </div>
            <label className="block text-xs text-txt-secondary space-y-1">
              <span>Prompt Text (delta)</span>
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={6}
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
              />
            </label>
            <label className="block text-xs text-txt-secondary space-y-1">
              <span>Rules Text (delta)</span>
              <textarea
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
                rows={6}
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
              />
            </label>
            <label className="block text-xs text-txt-secondary space-y-1">
              <span>Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={createVersion}
              disabled={!selectedScopeId || saving}
              className="rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
            >
              {saving ? 'Speichere…' : 'Neue Version speichern & aktivieren'}
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Versions</div>
            <div className="space-y-2 max-h-[260px] overflow-auto">
              {versions.map((v: any) => (
                <div key={v.id} className="rounded-xl border border-app-border bg-app-bg/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-txt-secondary">
                      <div>
                        <code>{v.id}</code> {scope?.activeVersionId === v.id ? <span className="text-accent">ACTIVE</span> : null}
                      </div>
                      {v.note ? <div className="text-txt-muted">{v.note}</div> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => activate(v.id)}
                      disabled={saving || scope?.activeVersionId === v.id}
                      className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-txt-primary"
                    >
                      Activate
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-txt-muted">
                      promptMode: <code>{v.promptMode || 'append'}</code>
                    </div>
                    <div className="text-txt-muted">
                      rulesMode: <code>{v.rulesMode || 'append'}</code>
                    </div>
                  </div>
                </div>
              ))}
              {versions.length === 0 && <div className="text-sm text-txt-muted">Noch keine Versionen.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

