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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Admin: LLM Management</h2>
        <p className="text-sm text-[color:var(--text-tertiary)]">
          Listet die vorhandenen LLM-Einsatzbereiche (Scopes) und erlaubt Prompt/Rules Edits mit Versionierung.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-4 py-3 text-sm text-[color:var(--error)]">
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-hover)]/60 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Scopes</h3>
            <button
              type="button"
              onClick={loadScopes}
              disabled={loading}
              className="rounded-xl bg-[var(--surface)] hover:bg-[var(--surface-secondary)] disabled:opacity-60 px-3 py-2 text-sm font-semibold text-[color:white]"
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
                  selectedScopeId === s.id ? 'bg-[var(--avy-purple-glow)] text-[color:white]' : 'bg-[var(--surface-secondary)]/30 text-[color:var(--text-primary)] hover:bg-[var(--surface)]/40'
                }`}
              >
                <div className="font-semibold">{s.name || s.id}</div>
                <div className="text-xs text-[color:var(--text-tertiary)]">{s.id}</div>
              </button>
            ))}
            {scopes.length === 0 && <div className="text-sm text-[color:var(--text-tertiary)]">Keine Scopes.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-[var(--border)] bg-[var(--surface-hover)]/60 p-5 space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{scope?.name || scope?.id || '—'}</div>
            <div className="text-xs text-[color:var(--text-tertiary)]">{scope?.purpose || ''}</div>
            <div className="text-xs text-[color:var(--text-tertiary)]">
              Default Model Env: <code>{scope?.defaultModelEnvKey || '—'}</code> · Active Version:{' '}
              <code>{scope?.activeVersionId || '—'}</code>
            </div>
          </div>

          {scope?.activeVersionId && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3 text-xs text-[color:var(--text-secondary)]">
              <div className="flex flex-wrap gap-3 items-center">
                <span className="font-semibold text-[color:var(--text-primary)]">Aktive Version:</span>
                <span className="text-[color:var(--text-primary)]">{scope.activeVersionId}</span>
              </div>
              <p className="mt-2 text-[color:var(--text-tertiary)]">
                Felder unten sind mit der aktuell aktiven Version vorbelegt. Änderungen werden als neue Version gespeichert
                und automatisch aktiviert.
              </p>
            </div>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/20 p-4 space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-[color:var(--text-secondary)]">
                Prompt Mode
                <select
                  className="ml-2 bg-[var(--surface-secondary)]/60 border border-[var(--border)] rounded-lg px-2 py-1 text-[color:var(--text-primary)]"
                  value={promptMode}
                  onChange={(e) => setPromptMode(e.target.value as any)}
                >
                  <option value="append">append</option>
                  <option value="replace">replace</option>
                </select>
              </label>
              <label className="text-xs text-[color:var(--text-secondary)]">
                Rules Mode
                <select
                  className="ml-2 bg-[var(--surface-secondary)]/60 border border-[var(--border)] rounded-lg px-2 py-1 text-[color:var(--text-primary)]"
                  value={rulesMode}
                  onChange={(e) => setRulesMode(e.target.value as any)}
                >
                  <option value="append">append</option>
                  <option value="replace">replace</option>
                </select>
              </label>
            </div>
            <label className="block text-xs text-[color:var(--text-secondary)] space-y-1">
              <span>Prompt Text (delta)</span>
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={6}
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)] font-mono text-xs"
              />
            </label>
            <label className="block text-xs text-[color:var(--text-secondary)] space-y-1">
              <span>Rules Text (delta)</span>
              <textarea
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
                rows={6}
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)] font-mono text-xs"
              />
            </label>
            <label className="block text-xs text-[color:var(--text-secondary)] space-y-1">
              <span>Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)]"
              />
            </label>
            <button
              type="button"
              onClick={createVersion}
              disabled={!selectedScopeId || saving}
              className="rounded-xl bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] disabled:opacity-60 px-4 py-2 text-sm font-semibold text-[color:white]"
            >
              {saving ? 'Speichere…' : 'Neue Version speichern & aktivieren'}
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Versions</div>
            <div className="space-y-2 max-h-[260px] overflow-auto">
              {versions.map((v: any) => (
                <div key={v.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-[color:var(--text-secondary)]">
                      <div>
                        <code>{v.id}</code> {scope?.activeVersionId === v.id ? <span className="text-[color:var(--avy-purple-light)]">ACTIVE</span> : null}
                      </div>
                      {v.note ? <div className="text-[color:var(--text-tertiary)]">{v.note}</div> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => activate(v.id)}
                      disabled={saving || scope?.activeVersionId === v.id}
                      className="rounded-lg bg-[var(--surface)] hover:bg-[var(--surface-secondary)] disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-[color:white]"
                    >
                      Activate
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-[color:var(--text-tertiary)]">
                      promptMode: <code>{v.promptMode || 'append'}</code>
                    </div>
                    <div className="text-[color:var(--text-tertiary)]">
                      rulesMode: <code>{v.rulesMode || 'append'}</code>
                    </div>
                  </div>
                </div>
              ))}
              {versions.length === 0 && <div className="text-sm text-[color:var(--text-tertiary)]">Noch keine Versionen.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

