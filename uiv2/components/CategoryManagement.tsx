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
    <>
      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-text">
          <h1>{t('categories.title')}</h1>
          <div className="page-header-sub">{t('categories.subtitle')}</div>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" type="button" disabled={loading}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 8a6 6 0 01-6 6M2 8a6 6 0 016-6" />
              <path d="M10 5l2-2 2 2M6 11l-2 2-2-2" />
            </svg>
            {t('categories.refresh') || 'Kategorien aktualisieren'}
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="content-area">

        {/* Error Alert */}
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Split Panels */}
        <div className="split-panels">

          {/* LEFT: Category Search & Results */}
          <div className="panel-left">
            <div className="panel-left-header">
              <h3>{t('categories.searchLabel') || 'Kategorie-Baum'}</h3>
              <div className="tree-search">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M11 11l3 3" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('categories.searchPlaceholder')}
                />
              </div>
              <div className="form-hint" style={{ marginTop: 6 }}>
                {canSearch ? t('categories.searchHintReady') : t('categories.searchHint')}
              </div>
            </div>
            <div className="panel-left-body">
              {loading && results.length === 0 && (
                <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-tertiary)' }}>
                  {t('common.loading') || 'Loading...'}
                </div>
              )}
              {results.map((cat) => {
                const active = selected?.id === cat.id;
                return (
                  <div className="tree-node" key={cat.id}>
                    <div
                      className={`tree-node-row${active ? ' selected' : ''}`}
                      onClick={() => void selectCategory(cat)}
                    >
                      <span className="tree-node-label">{cat.name}</span>
                      <span className="tree-node-id">ID: {cat.id}</span>
                    </div>
                    {cat.breadcrumb && (
                      <div style={{
                        padding: '0 16px 6px 16px',
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        wordBreak: 'break-word',
                      }}>
                        {cat.breadcrumb}
                      </div>
                    )}
                  </div>
                );
              })}
              {!loading && canSearch && results.length === 0 && (
                <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-tertiary)' }}>
                  {t('categories.noResults')}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Profile Editor */}
          <div className="panel-right">
            <div className="panel-right-header">
              <h3>{t('categories.profile') || 'Profil-Editor'}</h3>
              {selected && (
                <div className="breadcrumb-trail">
                  <span>{selected.name}</span>
                </div>
              )}
            </div>
            <div className="panel-right-body">
              {!selected || !profile ? (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                  {t('categories.selectHint')}
                </div>
              ) : (
                <>
                  {/* Profile Settings Section */}
                  <div className="form-section-title">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 4a2 2 0 012-2h3l2 2h3a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
                    </svg>
                    {t('categories.selected') || 'Profil-Einstellungen'}
                  </div>

                  <div className="form-group">
                    <label className="form-label-upper">{t('categories.selected')}</label>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {selected.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', wordBreak: 'break-word', marginTop: 2 }}>
                      {selected.breadcrumb}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      ID: {selected.id}
                    </div>
                  </div>

                  {/* Enabled toggle */}
                  <div className="form-group">
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={Boolean(profile.enabled)}
                        onChange={(e) => setProfile((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))}
                      />
                      {t('categories.enabled')}
                    </label>
                  </div>

                  {/* Canonical Attributes */}
                  <div style={{ marginTop: 8 }} className="form-section-title">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 4h12M2 8h12M2 12h8" />
                    </svg>
                    {t('categories.canonicalAttributes')}
                  </div>

                  <div className="form-group">
                    <label className="form-label-upper">{t('categories.canonicalAttributes')}</label>
                    <textarea
                      className="form-input"
                      value={canonicalText}
                      onChange={(e) => {
                        const lines = e.target.value
                          .split('\n')
                          .map((l) => l.trim())
                          .filter(Boolean);
                        setProfile((prev) => (prev ? { ...prev, canonicalAttributes: lines } : prev));
                      }}
                      rows={8}
                      style={{ fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace", fontSize: 12, lineHeight: 1.6 }}
                    />
                  </div>

                  {/* Attribute Aliases */}
                  <div style={{ marginTop: 8 }} className="form-section-title">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 4h12M2 8h12M2 12h8" />
                      <circle cx="14" cy="12" r="1.5" />
                    </svg>
                    {t('categories.attributeAliases')}
                  </div>

                  <div className="form-group">
                    <label className="form-label-upper">{t('categories.attributeAliases')}</label>
                    <textarea
                      className="form-input"
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
                      style={{ fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace", fontSize: 12, lineHeight: 1.6 }}
                    />
                    <div className="form-hint">{t('categories.attributeAliasesHint')}</div>
                  </div>

                  {/* Notes */}
                  <div className="form-group">
                    <label className="form-label-upper">{t('categories.notes')}</label>
                    <textarea
                      className="form-input"
                      value={profile.notes || ''}
                      onChange={(e) => setProfile((prev) => (prev ? { ...prev, notes: e.target.value } : prev))}
                      rows={3}
                    />
                  </div>

                  {/* Footer Actions */}
                  <div className="editor-footer">
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void onSave()}
                      disabled={saving}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                        <path d="M3 8.5l3.5 3.5 6.5-7" />
                      </svg>
                      {saving ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  );
};
