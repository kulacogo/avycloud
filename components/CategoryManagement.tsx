import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { EbayCategoryOption } from '../types';
import { fetchCategoryProfile, saveCategoryProfile, searchEbayCategories } from '../api/client';

type CategoryProfile = {
  id: string;
  breadcrumb?: string;
  enabled?: boolean;
  canonicalAttributes?: string[];
  attributeAliases?: Record<string, string>;
  notes?: string;
  updatedAtIso?: string;
};

const safeString = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

export const CategoryManagement: React.FC = () => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EbayCategoryOption[]>([]);
  const [selected, setSelected] = useState<EbayCategoryOption | null>(null);
  const [profile, setProfile] = useState<CategoryProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSearch = query.trim().length >= 2;

  const loadSearch = useCallback(async () => {
    if (!canSearch) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await searchEbayCategories({ q: query.trim(), limit: 100 });
      setResults(items);
    } catch (e: any) {
      setError(e?.message || 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [canSearch, query]);

  useEffect(() => {
    const handle = setTimeout(() => void loadSearch(), 300);
    return () => clearTimeout(handle);
  }, [loadSearch]);

  const selectCategory = useCallback(async (cat: EbayCategoryOption) => {
    setSelected(cat);
    setError(null);
    setProfile(null);
    setLoading(true);
    try {
      const loaded = await fetchCategoryProfile(cat.id);
      setProfile(
        loaded || {
          id: cat.id,
          breadcrumb: cat.breadcrumb,
          enabled: false,
          canonicalAttributes: [],
          attributeAliases: {},
          notes: '',
        }
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to load category profile');
    } finally {
      setLoading(false);
    }
  }, []);

  const canonicalText = useMemo(() => {
    const list = profile?.canonicalAttributes || [];
    return list.join('\n');
  }, [profile?.canonicalAttributes]);

  const aliasesText = useMemo(() => {
    const obj = profile?.attributeAliases || {};
    return JSON.stringify(obj, null, 2);
  }, [profile?.attributeAliases]);

  const onSave = useCallback(async () => {
    if (!selected || !profile) return;
    setSaving(true);
    setError(null);
    try {
      await saveCategoryProfile(profile.id, profile);
      const refreshed = await fetchCategoryProfile(profile.id);
      if (refreshed) setProfile(refreshed);
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [profile, selected]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('categories.title')}</h1>
          <p className="text-sm text-slate-400">{t('categories.subtitle')}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-5 space-y-3">
        <label className="text-xs uppercase tracking-widest text-slate-400">{t('categories.searchLabel')}</label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-white"
          placeholder={t('categories.searchPlaceholder')}
        />
        <div className="text-xs text-slate-400">
          {canSearch ? t('categories.searchHintReady') : t('categories.searchHint')}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-950/40 px-4 py-3 text-sm text-rose-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-slate-100">{t('categories.results')}</p>
            {loading && <p className="text-xs text-slate-400">{t('common.loading') || 'Loading…'}</p>}
          </div>
          <div className="max-h-[60vh] overflow-auto space-y-2">
            {results.map((cat) => {
              const active = selected?.id === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => void selectCategory(cat)}
                  className={`w-full text-left rounded-xl border px-3 py-2 transition ${
                    active ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500'
                  }`}
                >
                  <p className="text-sm font-semibold text-white">{cat.name}</p>
                  <p className="text-xs text-slate-400 break-words">{cat.breadcrumb}</p>
                  <p className="text-[11px] text-slate-500">ID: {cat.id}</p>
                </button>
              );
            })}
            {!loading && canSearch && results.length === 0 && (
              <p className="text-sm text-slate-400">{t('categories.noResults')}</p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-5 space-y-4">
          <p className="text-sm font-semibold text-slate-100">{t('categories.profile')}</p>
          {!selected || !profile ? (
            <p className="text-sm text-slate-400">{t('categories.selectHint')}</p>
          ) : (
            <>
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('categories.selected')}</p>
                <p className="text-sm text-white font-semibold">{selected.name}</p>
                <p className="text-xs text-slate-400 break-words">{selected.breadcrumb}</p>
                <p className="text-[11px] text-slate-500">ID: {selected.id}</p>
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-slate-100">
                <input
                  type="checkbox"
                  checked={Boolean(profile.enabled)}
                  onChange={(e) => setProfile((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))}
                />
                {t('categories.enabled')}
              </label>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-widest text-slate-400">{t('categories.canonicalAttributes')}</label>
                <textarea
                  value={canonicalText}
                  onChange={(e) => {
                    const lines = e.target.value
                      .split('\n')
                      .map((l) => l.trim())
                      .filter(Boolean);
                    setProfile((prev) => (prev ? { ...prev, canonicalAttributes: lines } : prev));
                  }}
                  rows={8}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-white font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-widest text-slate-400">{t('categories.attributeAliases')}</label>
                <textarea
                  value={aliasesText}
                  onChange={(e) => {
                    const raw = safeString(e.target.value);
                    try {
                      const parsed = raw ? JSON.parse(raw) : {};
                      setProfile((prev) => (prev ? { ...prev, attributeAliases: parsed } : prev));
                      setError(null);
                    } catch (err: any) {
                      setError(err?.message || 'Invalid JSON');
                    }
                  }}
                  rows={10}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-white font-mono text-sm"
                />
                <p className="text-xs text-slate-400">{t('categories.attributeAliasesHint')}</p>
              </div>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-widest text-slate-400">{t('categories.notes')}</label>
                <textarea
                  value={profile.notes || ''}
                  onChange={(e) => setProfile((prev) => (prev ? { ...prev, notes: e.target.value } : prev))}
                  rows={3}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-white text-sm"
                />
              </div>

              <button
                type="button"
                onClick={() => void onSave()}
                disabled={saving}
                className="w-full rounded-2xl bg-sky-600 text-white font-semibold py-3 disabled:opacity-50"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

