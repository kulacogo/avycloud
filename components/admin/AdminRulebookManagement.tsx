import React from 'react';
import {
  adminApplyRulebook,
  adminGetRulebook,
  adminGetRulebookApplyJob,
  adminUpdateRulebook,
  type AdminRulebookConfig,
} from '../../api/client';
import { Notice } from '../ui/Notice';

type HighlightRuleRow = { schemaId: string; min: number; max: number; minLen: number; maxLen: number };
type TitleRuleRow = { schemaId: string; minLen: number; softMaxLen: number; maxLen: number; mobileMaxLen: number };
type CanonRow = { from: string; to: string };

const toNumber = (v: any, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const AdminRulebookManagement: React.FC = () => {
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string>('');
  const [runAfterSave, setRunAfterSave] = React.useState<boolean>(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);

  const [meta, setMeta] = React.useState<{ versionId: string | null; updatedAt: string | null; updatedBy: string | null } | null>(
    null
  );
  const [cfg, setCfg] = React.useState<AdminRulebookConfig>({
    title: { minLen: 70, softMaxLen: 80, maxLen: 80, mobileMaxLen: 60, marketingWords: ['neu', 'top', 'neuware'] },
    highlights: { requireDashTemplate: true, rulesBySchema: {} },
    attributes: { canonicalKeyMap: {} },
  });

  const [highlightRows, setHighlightRows] = React.useState<HighlightRuleRow[]>([]);
  const [titleRows, setTitleRows] = React.useState<TitleRuleRow[]>([]);
  const [canonRows, setCanonRows] = React.useState<CanonRow[]>([]);

  const [applyJobId, setApplyJobId] = React.useState<string>('');
  const [applyJob, setApplyJob] = React.useState<any>(null);
  const [applyMinQty, setApplyMinQty] = React.useState<number>(1);
  const [applyRequireBin, setApplyRequireBin] = React.useState<boolean>(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await adminGetRulebook();
      setMeta({ versionId: data.versionId, updatedAt: data.updatedAt, updatedBy: data.updatedBy });
      setCfg(data.config || {});

      const rbs = data.config?.highlights?.rulesBySchema || {};
      const rows: HighlightRuleRow[] = Object.entries(rbs).map(([schemaId, rule]: any) => ({
        schemaId,
        min: toNumber(rule?.min, 4),
        max: toNumber(rule?.max, 6),
        minLen: toNumber(rule?.minLen, 70),
        maxLen: toNumber(rule?.maxLen, 110),
      }));
      setHighlightRows(rows.sort((a, b) => a.schemaId.localeCompare(b.schemaId)));

      const trs = (data.config as any)?.title?.rulesBySchema || {};
      const trows: TitleRuleRow[] = Object.entries(trs).map(([schemaId, rule]: any) => ({
        schemaId,
        minLen: toNumber(rule?.minLen, toNumber(data.config?.title?.minLen, 70)),
        softMaxLen: toNumber(rule?.softMaxLen, toNumber(data.config?.title?.softMaxLen, 80)),
        maxLen: toNumber(rule?.maxLen, toNumber(data.config?.title?.maxLen, 80)),
        mobileMaxLen: toNumber(rule?.mobileMaxLen, toNumber(data.config?.title?.mobileMaxLen, 60)),
      }));
      setTitleRows(trows.sort((a, b) => a.schemaId.localeCompare(b.schemaId)));

      const cmap = data.config?.attributes?.canonicalKeyMap || {};
      const crows: CanonRow[] = Object.entries(cmap).map(([from, to]: any) => ({
        from: String(from || ''),
        to: String(to || ''),
      }));
      setCanonRows(crows.sort((a, b) => a.from.localeCompare(b.from)));
    } catch (e: any) {
      setError(e?.message || 'Failed to load rulebook');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next: AdminRulebookConfig = {
        ...(cfg || {}),
        title: {
          ...(cfg.title || {}),
          minLen: toNumber(cfg?.title?.minLen, 70),
          softMaxLen: toNumber(cfg?.title?.softMaxLen, 80),
          maxLen: toNumber(cfg?.title?.maxLen, 80),
          mobileMaxLen: toNumber(cfg?.title?.mobileMaxLen, 60),
          marketingWords: Array.isArray(cfg?.title?.marketingWords) ? cfg.title!.marketingWords : [],
          rulesBySchema: Object.fromEntries(
            titleRows
              .filter((r) => r.schemaId.trim())
              .map((r) => [
                r.schemaId.trim(),
                {
                  minLen: toNumber(r.minLen, 70),
                  softMaxLen: toNumber(r.softMaxLen, 80),
                  maxLen: toNumber(r.maxLen, 80),
                  mobileMaxLen: toNumber(r.mobileMaxLen, 60),
                },
              ])
          ) as any,
        },
        highlights: {
          ...(cfg.highlights || {}),
          requireDashTemplate: cfg?.highlights?.requireDashTemplate !== false,
          rulesBySchema: Object.fromEntries(
            highlightRows
              .filter((r) => r.schemaId.trim())
              .map((r) => [
                r.schemaId.trim(),
                { min: toNumber(r.min, 4), max: toNumber(r.max, 6), minLen: toNumber(r.minLen, 70), maxLen: toNumber(r.maxLen, 110) },
              ])
          ),
        },
        attributes: {
          ...(cfg.attributes || {}),
          canonicalKeyMap: Object.fromEntries(
            canonRows
              .map((r) => ({ from: r.from.trim().toLowerCase(), to: r.to.trim() }))
              .filter((r) => r.from && r.to)
              .map((r) => [r.from, r.to])
          ),
        },
      };

      await adminUpdateRulebook({ config: next, note: note || undefined });
      setNote('');
      await load();

      if (runAfterSave) {
        const r = await adminApplyRulebook({});
        setApplyJobId(r.jobId);
        setApplyJob(null);
        setNotice({ tone: 'success', title: 'Rulebook gespeichert + Apply Job gestartet', details: `JobId: ${r.jobId}` });
      } else {
        setNotice({ tone: 'success', title: 'Rulebook gespeichert (Versionierung aktiv)' });
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to save rulebook');
    } finally {
      setSaving(false);
    }
  };

  const runApply = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await adminApplyRulebook({
        minQty: Number.isFinite(Number(applyMinQty)) ? Math.max(1, Math.min(9999, Number(applyMinQty))) : 1,
        requireBin: Boolean(applyRequireBin),
      });
      setApplyJobId(r.jobId);
      setApplyJob(null);
      setNotice({ tone: 'success', title: 'Apply Job gestartet', details: `JobId: ${r.jobId}` });
    } catch (e: any) {
      setError(e?.message || 'Failed to start rulebook apply job');
    } finally {
      setSaving(false);
    }
  };

  const refreshApplyJob = async () => {
    if (!applyJobId) return;
    setSaving(true);
    setError(null);
    try {
      const j = await adminGetRulebookApplyJob(applyJobId);
      setApplyJob(j);
    } catch (e: any) {
      setError(e?.message || 'Failed to load job');
    } finally {
      setSaving(false);
    }
  };

  const updateHighlightCell = (idx: number, key: keyof HighlightRuleRow, value: any) => {
    setHighlightRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx] };
      (row as any)[key] = key === 'schemaId' ? String(value) : toNumber(value, (row as any)[key]);
      next[idx] = row;
      return next;
    });
  };

  const updateTitleCell = (idx: number, key: keyof TitleRuleRow, value: any) => {
    setTitleRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx] };
      (row as any)[key] = key === 'schemaId' ? String(value) : toNumber(value, (row as any)[key]);
      next[idx] = row;
      return next;
    });
  };

  const updateCanonCell = (idx: number, key: keyof CanonRow, value: any) => {
    setCanonRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx] };
      (row as any)[key] = String(value);
      next[idx] = row;
      return next;
    });
  };

  return (
    <div className="space-y-5">
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Admin: Regelverwaltung (Rulebook)</h2>
          <p className="text-sm text-slate-400">
            Zentraler, zwingender Rulebook-Config für Titel/Highlights/Attribute (wirkt auf Identify/Improve/Chat + Delta-Sync).
          </p>
          {meta && (
            <p className="text-xs text-slate-500 mt-1">
              Version: {meta.versionId || '—'} · Updated: {meta.updatedAt || '—'} · By: {meta.updatedBy || '—'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-300 flex items-center gap-2 mr-1">
            <input type="checkbox" checked={runAfterSave} onChange={(e) => setRunAfterSave(e.target.checked)} />
            Run now after Save
          </label>
          <button
            type="button"
            disabled={loading || saving}
            onClick={load}
            className="rounded-xl bg-slate-800/40 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={loading || saving}
            onClick={save}
            className="rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-500/20 bg-rose-950/40 px-4 py-3 text-sm text-rose-400">{error}</div>}
      {loading && <div className="text-sm text-slate-300">Loading…</div>}

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-200">Titel Regeln (Längen + Marketing Wörter)</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(['minLen', 'softMaxLen', 'maxLen', 'mobileMaxLen'] as const).map((k) => (
            <label key={k} className="text-xs text-slate-300 space-y-1">
              <span>{k}</span>
              <input
                className="w-full rounded-xl bg-slate-950/40 border border-white/10 px-3 py-2 text-slate-100"
                value={(cfg.title as any)?.[k] ?? ''}
                onChange={(e) => setCfg((prev) => ({ ...prev, title: { ...(prev.title || {}), [k]: Number(e.target.value) } }))}
              />
            </label>
          ))}
          <label className="text-xs text-slate-300 space-y-1 md:col-span-2">
            <span>marketingWords (comma-separated)</span>
            <input
              className="w-full rounded-xl bg-slate-950/40 border border-white/10 px-3 py-2 text-slate-100"
              value={Array.isArray(cfg?.title?.marketingWords) ? cfg.title!.marketingWords!.join(', ') : ''}
              onChange={(e) =>
                setCfg((prev) => ({
                  ...prev,
                  title: {
                    ...(prev.title || {}),
                    marketingWords: e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  },
                }))
              }
            />
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Titel Kategorien (pro Titel-Kategorie)</h3>
          <button
            type="button"
            className="rounded-xl bg-slate-800/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            onClick={() =>
              setTitleRows((prev) => [
                ...prev,
                { schemaId: 'Haus, Garten & Baumarkt', minLen: 70, softMaxLen: 80, maxLen: 80, mobileMaxLen: 60 },
              ])
            }
          >
            + Add row
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Diese Titel-Kategorien sind grobe Buckets (nicht Produkt-Kategorien). Jedes Produkt wird deterministisch einem Bucket zugeordnet (Fallback: generic).
        </p>
        <div className="overflow-auto rounded-xl ring-1 ring-white/10">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-950/40 text-slate-300">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">schemaId</th>
                <th className="px-3 py-2 text-left font-semibold">minLen</th>
                <th className="px-3 py-2 text-left font-semibold">softMaxLen</th>
                <th className="px-3 py-2 text-left font-semibold">maxLen</th>
                <th className="px-3 py-2 text-left font-semibold">mobileMaxLen</th>
                <th className="px-3 py-2 text-left font-semibold">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {titleRows.map((r, idx) => (
                <tr key={`${r.schemaId}-${idx}`} className="bg-slate-900/20">
                  <td className="px-3 py-2">
                    <input
                      className="w-44 rounded-xl bg-slate-950/40 border border-white/10 px-3 py-2 text-slate-100"
                      value={r.schemaId}
                      onChange={(e) => updateTitleCell(idx, 'schemaId', e.target.value)}
                    />
                  </td>
                  {(['minLen', 'softMaxLen', 'maxLen', 'mobileMaxLen'] as const).map((k) => (
                    <td key={k} className="px-3 py-2">
                      <input
                        className="w-24 rounded-xl bg-slate-950/40 border border-white/10 px-3 py-2 text-slate-100"
                        value={(r as any)[k]}
                        onChange={(e) => updateTitleCell(idx, k, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="rounded-xl bg-red-600/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600"
                      onClick={() => setTitleRows((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {titleRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={6}>
                    No title category rules configured.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Highlights Regeln (pro Schema)</h3>
          <button
            type="button"
            className="rounded-xl bg-slate-800/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            onClick={() => setHighlightRows((p) => [...p, { schemaId: 'generic', min: 4, max: 6, minLen: 70, maxLen: 110 }])}
          >
            + Add row
          </button>
        </div>
        <label className="text-xs text-slate-300 flex items-center gap-2">
          <input
            type="checkbox"
            checked={cfg?.highlights?.requireDashTemplate !== false}
            onChange={(e) => setCfg((prev) => ({ ...prev, highlights: { ...(prev.highlights || {}), requireDashTemplate: e.target.checked } }))}
          />
          Require “[Nutzen] – [Spec]” dash template
        </label>

        <div className="overflow-auto rounded-xl border border-white/10">
          <table className="min-w-[760px] w-full text-sm">
            <thead className="bg-slate-950/40 text-slate-300">
              <tr>
                <th className="text-left px-3 py-2">schemaId</th>
                <th className="text-left px-3 py-2">min</th>
                <th className="text-left px-3 py-2">max</th>
                <th className="text-left px-3 py-2">minLen</th>
                <th className="text-left px-3 py-2">maxLen</th>
                <th className="text-left px-3 py-2">Remove</th>
              </tr>
            </thead>
            <tbody className="text-slate-100">
              {highlightRows.map((row, idx) => (
                <tr key={`${row.schemaId}-${idx}`} className="border-t border-white/10">
                  {(['schemaId', 'min', 'max', 'minLen', 'maxLen'] as const).map((k) => (
                    <td key={k} className="px-3 py-2">
                      <input
                        className="w-full rounded-lg bg-slate-950/40 border border-white/10 px-2 py-1 text-slate-100"
                        value={(row as any)[k]}
                        onChange={(e) => updateHighlightCell(idx, k, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="rounded-lg bg-red-600/20 border border-red-500/30 px-2 py-1 text-xs text-red-200 hover:bg-red-600/30"
                      onClick={() => setHighlightRows((p) => p.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {!highlightRows.length && (
                <tr>
                  <td className="px-3 py-3 text-slate-400" colSpan={6}>
                    No highlight rules configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Attribute Canonical Map (Synonyme → Canonical Key)</h3>
          <button
            type="button"
            className="rounded-xl bg-slate-800/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            onClick={() => setCanonRows((p) => [...p, { from: '', to: '' }])}
          >
            + Add row
          </button>
        </div>
        <div className="overflow-auto rounded-xl border border-white/10">
          <table className="min-w-[760px] w-full text-sm">
            <thead className="bg-slate-950/40 text-slate-300">
              <tr>
                <th className="text-left px-3 py-2">from (lowercase input key)</th>
                <th className="text-left px-3 py-2">to (canonical key)</th>
                <th className="text-left px-3 py-2">Remove</th>
              </tr>
            </thead>
            <tbody className="text-slate-100">
              {canonRows.map((row, idx) => (
                <tr key={`${row.from}-${idx}`} className="border-t border-white/10">
                  <td className="px-3 py-2">
                    <input
                      className="w-full rounded-lg bg-slate-950/40 border border-white/10 px-2 py-1 text-slate-100"
                      value={row.from}
                      onChange={(e) => updateCanonCell(idx, 'from', e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-full rounded-lg bg-slate-950/40 border border-white/10 px-2 py-1 text-slate-100"
                      value={row.to}
                      onChange={(e) => updateCanonCell(idx, 'to', e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="rounded-lg bg-red-600/20 border border-red-500/30 px-2 py-1 text-xs text-red-200 hover:bg-red-600/30"
                      onClick={() => setCanonRows((p) => p.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {!canonRows.length && (
                <tr>
                  <td className="px-3 py-3 text-slate-400" colSpan={3}>
                    No canonical mappings configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-200">Version Note</h3>
        <textarea
          rows={2}
          className="w-full rounded-xl bg-slate-950/40 border border-white/10 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
          placeholder="Optional note (why changed)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Pflicht: Initial Run + Delta Sync</h3>
            <p className="text-xs text-slate-400">
              Startet den serverseitigen Rulebook-Apply Job und enqueued BaseLinker <code>text_only</code> Sync-Jobs für geänderte Produkte.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={runApply}
              className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Run now
            </button>
            <button
              type="button"
              disabled={saving || !applyJobId}
              onClick={refreshApplyJob}
              className="rounded-xl bg-slate-800/40 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              Refresh status
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-200">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">minQty (available)</span>
            <input
              type="number"
              min={1}
              max={9999}
              value={applyMinQty}
              onChange={(e) => setApplyMinQty(Number(e.target.value) || 1)}
              className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={applyRequireBin} onChange={(e) => setApplyRequireBin(e.target.checked)} />
            Require BIN
          </label>

          <div className="text-xs text-slate-400">
            Filter wirkt nur auf diesen Apply-Run: verarbeitet nur Produkte mit Menge ≥ minQty (und optional BIN gesetzt). Ideal, um nur “verfügbare” Artikel zu korrigieren.
          </div>
        </div>

        <div className="text-xs text-slate-300">
          JobId:{' '}
          <input
            className="ml-2 rounded-lg bg-slate-950/40 border border-white/10 px-2 py-1 text-slate-100"
            value={applyJobId}
            onChange={(e) => setApplyJobId(e.target.value)}
            placeholder="job id"
            style={{ width: 380, maxWidth: '100%' }}
          />
        </div>

        {applyJob && (
          <pre className="rounded-xl bg-slate-950/40 border border-white/10 p-3 text-xs text-slate-200 overflow-auto">
            {JSON.stringify(applyJob, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
};

