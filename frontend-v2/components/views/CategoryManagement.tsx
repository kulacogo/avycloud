import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { EbayCategoryOption } from '../../types';
import { fetchCategoryProfile, saveCategoryProfile, searchEbayCategories } from '../../api/client';

/* ═══════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════
   Icons (inline SVG helpers)
   ═══════════════════════════════════════════════════════════ */

const IconFolder: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 5a2 2 0 012-2h3l2 2h3a2 2 0 012 2v5a2 2 0 01-2 2H4a2 2 0 01-2-2V5z" />
  </svg>
);

const IconFile: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 2h8v12H4zM7 2v3h3" />
  </svg>
);

const IconChevronRight: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3 1l4 4-4 4" />
  </svg>
);

const IconSearch: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M11 11l3 3" />
  </svg>
);

const IconRefresh: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M14 8a6 6 0 01-6 6M2 8a6 6 0 016-6" />
    <path d="M10 5l2-2 2 2M6 11l-2 2-2-2" />
  </svg>
);

const IconSettings: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 4a2 2 0 012-2h3l2 2h3a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
  </svg>
);

const IconTemplate: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 4h12M5 4v9M11 4v9M2 7h12" />
  </svg>
);

const IconMapping: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 4h12M2 8h12M2 12h8" />
    <circle cx="14" cy="12" r="1.5" />
  </svg>
);

const IconCheck: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 8.5l3.5 3.5 6.5-7" />
  </svg>
);

const IconExternalLink: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 8.5v4a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 12.5v-7A1.5 1.5 0 013.5 4H8" />
    <path d="M10 2h4v4M6.5 9.5L14 2" />
  </svg>
);

const IconPlus: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 3v10M3 8h10" />
  </svg>
);

const IconNotes: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 4h8M4 7h8M4 10h5M4 13h6" />
  </svg>
);

/* ═══════════════════════════════════════════════════════════
   Tree Node Component
   ═══════════════════════════════════════════════════════════ */

interface TreeCategoryNode {
  cat: EbayCategoryOption;
  depth: number;
}

const TreeNodeRow: React.FC<{
  cat: EbayCategoryOption;
  depth: number;
  isSelected: boolean;
  onClick: () => void;
}> = ({ cat, depth, isSelected, onClick }) => {
  const paddingLeft = 12 + depth * 18;
  const isLeaf = cat.leaf !== false;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full flex items-center gap-1 py-1.5 pr-4 cursor-pointer
        transition-all duration-100 border-l-[3px] text-left
        ${isSelected
          ? 'bg-[rgba(99,91,255,0.12)] border-l-[var(--avy-purple)]'
          : 'border-l-transparent hover:bg-[var(--surface-hover)]'
        }
      `}
      style={{ paddingLeft }}
    >
      {/* Icon */}
      <div className={`w-4 h-4 flex-shrink-0 mr-1 ${isSelected ? 'text-[var(--avy-purple)]' : 'text-[var(--text-tertiary)]'}`}>
        {isLeaf ? <IconFile className="w-4 h-4" /> : <IconFolder className="w-4 h-4" />}
      </div>

      {/* Label */}
      <span
        className={`text-[13px] flex-1 truncate ${
          isSelected ? 'text-[var(--avy-purple)] font-semibold' : 'text-[var(--text-primary)]'
        }`}
      >
        {cat.name || cat.breadcrumb}
      </span>

      {/* ID badge */}
      <span
        className={`text-[11px] font-medium px-1.5 rounded-full flex-shrink-0 ${
          isSelected
            ? 'bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)]'
            : 'bg-[var(--surface-secondary)] text-[var(--text-tertiary)]'
        }`}
      >
        {cat.id}
      </span>
    </button>
  );
};

/* ═══════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════ */

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

  /* Breadcrumb segments from selected category */
  const breadcrumbParts = useMemo(() => {
    if (!selected?.breadcrumb) return [];
    return selected.breadcrumb.split(/\s*>\s*/).filter(Boolean);
  }, [selected?.breadcrumb]);

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */

  return (
    <section className="space-y-5">
      {/* ── Page Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {t('categories.title')}
          </h1>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">
            {t('categories.subtitle')}
          </p>
        </div>
        <div className="flex gap-2.5 items-center">
          <button
            type="button"
            onClick={() => void loadSearch()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold
              bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)]
              hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]
              transition-all duration-200"
          >
            <IconRefresh className="w-[15px] h-[15px]" />
            {t('categories.searchLabel')}
          </button>
        </div>
      </div>

      {/* ── Error Banner ── */}
      {error && (
        <div className="rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {/* ── Content Area ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Split Panels */}
        <div
          className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] bg-[var(--surface)] border border-[var(--border)]
            rounded-xl overflow-hidden min-h-[600px]"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          {/* ── LEFT PANEL: Search & Category List ── */}
          <div className="border-r border-[var(--border)] flex flex-col overflow-hidden lg:border-r lg:border-b-0 border-b">
            {/* Panel Header */}
            <div className="px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-2.5">
                {t('categories.results')}
              </h3>

              {/* Search Input */}
              <div className="relative">
                <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-[var(--text-tertiary)] pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('categories.searchPlaceholder')}
                  className="w-full py-[7px] pl-8 pr-3 border border-[var(--border)] rounded-md
                    bg-[var(--bg)] text-[var(--text-primary)] text-[13px] font-inherit
                    outline-none transition-all duration-200
                    placeholder:text-[var(--text-tertiary)]
                    focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] focus:bg-[var(--surface)]"
                />
              </div>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-1.5">
                {canSearch ? t('categories.searchHintReady') : t('categories.searchHint')}
              </p>
            </div>

            {/* Category List */}
            <div className="flex-1 overflow-y-auto py-2 scrollbar-thin">
              {loading && results.length === 0 && (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--avy-purple)] rounded-full animate-spin" />
                </div>
              )}

              {results.map((cat) => {
                const isActive = selected?.id === cat.id;
                return (
                  <TreeNodeRow
                    key={cat.id}
                    cat={cat}
                    depth={0}
                    isSelected={isActive}
                    onClick={() => void selectCategory(cat)}
                  />
                );
              })}

              {!loading && canSearch && results.length === 0 && (
                <p className="text-[13px] text-[var(--text-tertiary)] text-center py-8">
                  {t('categories.noResults')}
                </p>
              )}

              {!canSearch && results.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <IconSearch className="w-8 h-8 text-[var(--text-tertiary)] mb-3 opacity-40" />
                  <p className="text-[13px] text-[var(--text-tertiary)]">
                    {t('categories.searchHint')}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT PANEL: Profile Editor ── */}
          <div className="flex flex-col overflow-hidden">
            {/* Panel Header */}
            <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between flex-shrink-0">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('categories.profile')}
              </h3>
              {selected && breadcrumbParts.length > 0 && (
                <div className="text-[12px] text-[var(--text-tertiary)] flex items-center gap-1 flex-wrap">
                  {breadcrumbParts.map((part, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <IconChevronRight className="w-2.5 h-2.5 flex-shrink-0" />}
                      {i === breadcrumbParts.length - 1 ? (
                        <span className="text-[var(--text-secondary)] font-medium">{part}</span>
                      ) : (
                        <span>{part}</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>

            {/* Panel Body */}
            <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
              {!selected || !profile ? (
                <div className="flex flex-col items-center justify-center h-full py-20 text-center">
                  <IconFolder className="w-10 h-10 text-[var(--text-tertiary)] mb-3 opacity-30" />
                  <p className="text-sm text-[var(--text-tertiary)]">
                    {t('categories.selectHint')}
                  </p>
                </div>
              ) : (
                <>
                  {/* ── Section: Profile Settings ── */}
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-4 pb-2 border-b border-[var(--border)] flex items-center gap-2">
                    <IconSettings className="w-4 h-4 text-[var(--avy-purple)]" />
                    {t('categories.selected')}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                    {/* Category Name */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        Kategorie
                      </label>
                      <input
                        type="text"
                        readOnly
                        value={selected.name || selected.breadcrumb}
                        className="w-full px-3 py-2 border border-[var(--border)] rounded-md
                          bg-[var(--surface-secondary)] text-[var(--text-secondary)] text-[13px]
                          cursor-default outline-none"
                      />
                    </div>
                    {/* Category ID */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                        eBay Kategorie-ID
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={selected.id}
                          className="flex-1 px-3 py-2 border border-[var(--border)] rounded-md
                            bg-[var(--surface-secondary)] text-[var(--text-secondary)] text-[13px]
                            cursor-default outline-none"
                        />
                        <a
                          href={`https://www.ebay.de/b/${selected.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--avy-purple)] text-[12px] font-medium hover:underline flex-shrink-0"
                        >
                          <IconExternalLink className="w-3 h-3" />
                          eBay
                        </a>
                      </div>
                    </div>
                  </div>

                  {/* Enabled toggle */}
                  <div className="mb-5 flex items-center gap-2.5">
                    <label className="inline-flex items-center gap-2.5 text-[13px] text-[var(--text-primary)] cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={Boolean(profile.enabled)}
                        onChange={(e) =>
                          setProfile((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))
                        }
                        className="accent-[var(--avy-purple)] w-4 h-4 rounded"
                      />
                      {t('categories.enabled')}
                    </label>
                  </div>

                  {/* ── Section: Canonical Attributes ── */}
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-4 pb-2 border-b border-[var(--border)] flex items-center gap-2 mt-2">
                    <IconMapping className="w-4 h-4 text-[var(--avy-purple)]" />
                    {t('categories.canonicalAttributes')}
                  </div>

                  <div className="mb-5">
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
                      placeholder="brand&#10;model&#10;color&#10;condition"
                      className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-md
                        text-[13px] text-[var(--text-primary)] font-mono leading-relaxed
                        min-h-[140px] resize-y outline-none transition-all duration-200
                        placeholder:text-[var(--text-tertiary)]
                        focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] focus:bg-[var(--surface)]"
                    />
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                      Ein kanonischer Attribut-Key pro Zeile
                    </p>
                  </div>

                  {/* ── Section: Attribute Aliases ── */}
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-4 pb-2 border-b border-[var(--border)] flex items-center gap-2 mt-2">
                    <IconTemplate className="w-4 h-4 text-[var(--avy-purple)]" />
                    {t('categories.attributeAliases')}
                  </div>

                  <div className="mb-5">
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
                      className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-md
                        text-[12px] text-[var(--text-primary)] font-mono leading-relaxed
                        min-h-[140px] resize-y outline-none transition-all duration-200
                        placeholder:text-[var(--text-tertiary)]
                        focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] focus:bg-[var(--surface)]"
                    />
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                      {t('categories.attributeAliasesHint')}
                    </p>
                  </div>

                  {/* ── Section: Notes ── */}
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-4 pb-2 border-b border-[var(--border)] flex items-center gap-2 mt-2">
                    <IconNotes className="w-4 h-4 text-[var(--avy-purple)]" />
                    {t('categories.notes')}
                  </div>

                  <div className="mb-5">
                    <textarea
                      value={profile.notes || ''}
                      onChange={(e) =>
                        setProfile((prev) => (prev ? { ...prev, notes: e.target.value } : prev))
                      }
                      rows={3}
                      placeholder="Notizen..."
                      className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-md
                        text-[13px] text-[var(--text-primary)] leading-relaxed
                        min-h-[80px] resize-y outline-none transition-all duration-200
                        placeholder:text-[var(--text-tertiary)]
                        focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] focus:bg-[var(--surface)]"
                    />
                  </div>

                  {/* ── Footer Actions ── */}
                  <div className="flex items-center justify-end gap-2.5 pt-5 mt-2 border-t border-[var(--border)]">
                    <button
                      type="button"
                      onClick={() => {
                        if (selected) void selectCategory(selected);
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold
                        bg-transparent text-[var(--text-secondary)] border border-transparent
                        hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]
                        transition-all duration-200"
                    >
                      {t('categories.searchLabel') === 'eBay Kategorie suchen' ? 'Zuruecksetzen' : 'Reset'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onSave()}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold
                        bg-[var(--avy-purple)] text-white
                        hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px
                        active:translate-y-0
                        disabled:opacity-50 disabled:cursor-not-allowed
                        transition-all duration-200"
                      style={{ boxShadow: '0 1px 2px rgba(99,91,255,0.2)' }}
                    >
                      <IconCheck className="w-[15px] h-[15px]" />
                      {saving ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
