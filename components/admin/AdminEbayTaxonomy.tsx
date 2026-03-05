import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchEbayTaxonomyCategories, fetchEbayTaxonomyCategoryAspects } from '../../api/client';
import type { EbayCategoryTaxonomyEntry, EbayCategoryAspectCatalog } from '../../types';
import { Notice } from '../ui/Notice';
import { PageHeader } from '../ui/PageHeader';
import { HelpDisclosure } from '../ui/HelpDisclosure';

type TreeNode = {
  breadcrumb: string;
  id: string | null;
  name: string;
  leaf: boolean;
  banned: boolean;
  children: TreeNode[];
};

const splitBreadcrumb = (breadcrumb: string): string[] =>
  String(breadcrumb || '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeSearch = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const buildTree = (items: EbayCategoryTaxonomyEntry[]): TreeNode[] => {
  const nodeByBreadcrumb = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const getOrCreateNode = (breadcrumb: string, name: string, parent: TreeNode | null): TreeNode => {
    const existing = nodeByBreadcrumb.get(breadcrumb);
    if (existing) return existing;
    const created: TreeNode = {
      breadcrumb,
      id: null,
      name: name || breadcrumb.split('>').pop()?.trim() || breadcrumb,
      leaf: false,
      banned: false,
      children: [],
    };
    nodeByBreadcrumb.set(breadcrumb, created);
    if (parent) {
      parent.children.push(created);
    } else {
      roots.push(created);
    }
    return created;
  };

  items.forEach((item) => {
    const parts = splitBreadcrumb(item.breadcrumb);
    if (!parts.length) return;
    let parent: TreeNode | null = null;
    let path = '';
    parts.forEach((part) => {
      path = path ? `${path} > ${part}` : part;
      parent = getOrCreateNode(path, part, parent);
    });
    const leafNode = nodeByBreadcrumb.get(path);
    if (leafNode) {
      leafNode.id = String(item.id || '').trim() || null;
      leafNode.name = String(item.name || leafNode.name || parts[parts.length - 1] || '').trim() || leafNode.name;
      leafNode.leaf = Boolean(item.leaf);
      leafNode.banned = Boolean(item.banned);
    }
  });

  const sortRecursive = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    nodes.forEach((node) => sortRecursive(node.children));
  };
  sortRecursive(roots);

  return roots;
};

const computeVisibleSet = (items: EbayCategoryTaxonomyEntry[], search: string): Set<string> | null => {
  const needle = normalizeSearch(search);
  if (!needle) return null;
  const visible = new Set<string>();
  const includeAncestors = (breadcrumb: string) => {
    const parts = splitBreadcrumb(breadcrumb);
    let path = '';
    parts.forEach((part) => {
      path = path ? `${path} > ${part}` : part;
      visible.add(path);
    });
  };
  items.forEach((item) => {
    const hay = normalizeSearch(`${item.breadcrumb} ${item.name || ''} ${item.id || ''}`);
    if (!hay.includes(needle)) return;
    includeAncestors(item.breadcrumb);
  });
  return visible;
};

const classForBadge = (tone: 'required' | 'recommended' | 'optional'): string => {
  if (tone === 'required') return 'border-danger/40 bg-danger-dim text-danger';
  if (tone === 'recommended') return 'border-amber-500/40 bg-amber-900/20 text-amber-100';
  return 'border-app-border/40 bg-app-bg/30 text-txt-primary';
};

export const AdminEbayTaxonomy: React.FC = () => {
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [categoryItems, setCategoryItems] = useState<EbayCategoryTaxonomyEntry[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [includeBanned, setIncludeBanned] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedCategoryBreadcrumb, setSelectedCategoryBreadcrumb] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<EbayCategoryAspectCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [aspectSearch, setAspectSearch] = useState('');

  const loadCategories = useCallback(async () => {
    setLoadingCategories(true);
    setCategoriesError(null);
    try {
      const items = await fetchEbayTaxonomyCategories({ includeBanned });
      setCategoryItems(items);
    } catch (e: any) {
      setCategoriesError(e?.message || String(e));
      setCategoryItems([]);
    } finally {
      setLoadingCategories(false);
    }
  }, [includeBanned]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const treeRoots = useMemo(() => buildTree(categoryItems), [categoryItems]);
  const visibleSet = useMemo(() => computeVisibleSet(categoryItems, categorySearch), [categoryItems, categorySearch]);

  const loadCatalog = useCallback(async (categoryId: string, breadcrumb?: string) => {
    const id = String(categoryId || '').trim();
    if (!id) return;
    setSelectedCategoryId(id);
    setSelectedCategoryBreadcrumb(breadcrumb ? String(breadcrumb) : null);
    setLoadingCatalog(true);
    setCatalogError(null);
    setCatalog(null);
    try {
      const data = await fetchEbayTaxonomyCategoryAspects(id);
      setCatalog(data);
    } catch (e: any) {
      setCatalogError(e?.message || String(e));
      setCatalog(null);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const filteredCatalog = useMemo(() => {
    if (!catalog) return null;
    const needle = normalizeSearch(aspectSearch);
    if (!needle) return catalog;
    const match = (name: string) => normalizeSearch(name).includes(needle);
    const aspects = Array.isArray(catalog.aspects) ? catalog.aspects : [];
    return {
      ...catalog,
      requiredAspects: (catalog.requiredAspects || []).filter(match),
      recommendedAspects: (catalog.recommendedAspects || []).filter(match),
      optionalAspects: (catalog.optionalAspects || []).filter(match),
      allAspects: (catalog.allAspects || []).filter(match),
      aspects: aspects.filter((row) => match(row?.name)),
    };
  }, [aspectSearch, catalog]);

  const toggleExpanded = useCallback((breadcrumb: string) => {
    const key = String(breadcrumb || '').trim();
    if (!key) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderTreeNode = (node: TreeNode, depth = 0): React.ReactNode => {
    if (visibleSet && !visibleSet.has(node.breadcrumb)) return null;
    const isSelected = selectedCategoryId && node.id === selectedCategoryId;
    const indentPx = depth * 12;
    const hasChildren = node.children.length > 0;
    const searchActive = Boolean(visibleSet && categorySearch.trim());
    const isExpanded = searchActive ? true : expanded.has(node.breadcrumb);

    return (
      <div key={node.breadcrumb}>
        <div
          className={`w-full rounded-lg border px-3 py-1.5 text-sm transition ${
            isSelected
              ? 'border-accent bg-accent-dim'
              : 'border-app-border bg-app-bg/20 hover:bg-app-bg/35 hover:border-app-border/80'
          } ${node.banned ? 'opacity-60' : ''}`}
          style={{ paddingLeft: `${10 + indentPx}px` }}
          title={node.breadcrumb}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleExpanded(node.breadcrumb)}
              disabled={!hasChildren}
              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${
                hasChildren ? 'border-app-border bg-app-bg/40 text-txt-secondary hover:bg-app-bg/60' : 'border-transparent text-txt-muted'
              }`}
              aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : 'No children'}
            >
              {hasChildren ? (isExpanded ? '▾' : '▸') : '·'}
            </button>

            <button
              type="button"
              onClick={() => {
                if (!node.id) return;
                void loadCatalog(node.id, node.breadcrumb);
              }}
              disabled={!node.id || node.banned}
              className={`min-w-0 flex-1 text-left ${node.banned ? 'cursor-not-allowed' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-txt-primary">{node.name}</span>
                    {node.leaf ? (
                      <span className="rounded border border-success/40 bg-success-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                        leaf
                      </span>
                    ) : null}
                    {node.banned ? (
                      <span className="rounded border border-danger/40 bg-danger-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
                        banned
                      </span>
                    ) : null}
                  </div>
                  {node.id ? <div className="mt-0.5 text-[11px] text-txt-muted">ID: {node.id}</div> : null}
                </div>
                {hasChildren ? (
                  <span className="shrink-0 text-[11px] text-txt-muted">{node.children.length}</span>
                ) : null}
              </div>
            </button>
          </div>
        </div>

        {hasChildren && isExpanded ? (
          <div className="mt-1 space-y-1">{node.children.map((child) => renderTreeNode(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  const requiredCount = catalog?.requiredAspects?.length ?? 0;
  const recommendedCount = catalog?.recommendedAspects?.length ?? 0;
  const optionalCount = catalog?.optionalAspects?.length ?? 0;
  const allCount = catalog?.allAspects?.length ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="eBay: Kategorien & Parameter"
        subtitle="Links: Kategoriebaum. Rechts: Taxonomie-Aspects (Pflicht/Empfohlen/Optional) für die selektierte Kategorie."
        right={
          <button
            type="button"
            onClick={() => void loadCategories()}
            className="rounded-xl bg-app-elevated px-4 py-2 text-sm font-semibold text-txt-secondary hover:bg-app-elevated transition-colors"
            disabled={loadingCategories}
          >
            Aktualisieren
          </button>
        }
      >
        <HelpDisclosure title="Wichtig: Governance (LLM & Datenblatt)">
          <div className="space-y-2 text-sm text-txt-secondary">
            <p>
              Diese Ansicht zeigt die offiziellen eBay Item Specifics (Aspects) pro Kategorie. Alle AvyCloud-LLMs sollen
              <b> nur diese Keys</b> verwenden (de-DE Bezeichnungen) und keine neuen/anderen Parameter erfinden.
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-txt-secondary">
              <li>
                Pflichtfelder erkennt man an <b>required</b> (eBay: <code>aspectRequired: true</code>).
              </li>
              <li>
                Empfohlen/Optional kommt aus <code>aspectUsage</code> (RECOMMENDED/OPTIONAL).
              </li>
              <li>
                Kategorien unter den nicht verwendeten Root-Kategorien sind in AvyCloud gesperrt.
              </li>
            </ul>
          </div>
        </HelpDisclosure>
      </PageHeader>

      {categoriesError ? <Notice tone="error" title="Kategorien konnten nicht geladen werden" details={categoriesError} /> : null}

      <div className="grid grid-cols-1 xl:grid-cols-[520px_minmax(0,1fr)] gap-4">
        <div className="rounded-2xl border border-app-border bg-app-bg/40 p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-txt-primary">Kategoriebaum</p>
              <p className="text-xs text-txt-muted">
                {loadingCategories ? 'Lade…' : `Kategorien: ${categoryItems.length}`}
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-txt-secondary">
              <input
                type="checkbox"
                checked={includeBanned}
                onChange={(e) => setIncludeBanned(e.target.checked)}
              />
              Gesperrte Roots anzeigen
            </label>
          </div>

          <input
            value={categorySearch}
            onChange={(e) => setCategorySearch(e.target.value)}
            placeholder="Kategorie suchen (z.B. 'Autoelektrik', 'Motorrad', 'Batterie')"
            className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
          />

          <div className="max-h-[72vh] overflow-auto space-y-1 pr-1">
            {treeRoots.map((node) => renderTreeNode(node, 0))}
            {!loadingCategories && categoryItems.length === 0 ? (
              <div className="text-sm text-txt-muted">Keine Kategorien verfügbar.</div>
            ) : null}
            {!loadingCategories && categoryItems.length > 0 && visibleSet && visibleSet.size === 0 ? (
              <div className="text-sm text-txt-muted">Keine Treffer.</div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-app-border bg-app-bg/40 p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-txt-primary">Parameter (Aspects)</p>
              <p className="text-xs text-txt-muted">
                {selectedCategoryId ? (
                  <>
                    <span className="font-mono">ID {selectedCategoryId}</span>
                    {selectedCategoryBreadcrumb ? <span className="ml-2">• {selectedCategoryBreadcrumb}</span> : null}
                  </>
                ) : (
                  'Bitte links eine Kategorie auswählen.'
                )}
              </p>
              {catalog ? (
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className={`rounded border px-2 py-0.5 font-semibold uppercase tracking-wide ${classForBadge('required')}`}>
                    required: {requiredCount}
                  </span>
                  <span className={`rounded border px-2 py-0.5 font-semibold uppercase tracking-wide ${classForBadge('recommended')}`}>
                    recommended: {recommendedCount}
                  </span>
                  <span className={`rounded border px-2 py-0.5 font-semibold uppercase tracking-wide ${classForBadge('optional')}`}>
                    optional: {optionalCount}
                  </span>
                  <span className="rounded border border-accent/40 bg-accent-dim px-2 py-0.5 text-accent font-semibold uppercase tracking-wide">
                    all: {allCount}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="min-w-[260px]">
              <input
                value={aspectSearch}
                onChange={(e) => setAspectSearch(e.target.value)}
                placeholder="Aspects filtern (z.B. 'Marke', 'EAN')"
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                disabled={!catalog}
              />
            </div>
          </div>

          {catalogError ? <Notice tone="error" title="Aspects konnten nicht geladen werden" details={catalogError} /> : null}

          {!selectedCategoryId ? (
            <div className="rounded-xl border border-app-border bg-app-bg/20 p-4 text-sm text-txt-secondary">
              Wähle links eine Kategorie aus, um Pflicht/Empfohlen/Optional zu sehen.
            </div>
          ) : loadingCatalog ? (
            <div className="rounded-xl border border-app-border bg-app-bg/20 p-4 text-sm text-txt-secondary">
              Lade Aspects…
            </div>
          ) : !catalog ? (
            <div className="rounded-xl border border-app-border bg-app-bg/20 p-4 text-sm text-txt-secondary">
              Keine Aspect-Daten verfügbar.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="rounded-xl border border-app-border bg-app-bg/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-danger">Pflicht</p>
                <div className="mt-2 space-y-1 max-h-[52vh] overflow-auto pr-1">
                  {(filteredCatalog?.requiredAspects || []).map((name) => (
                    <div key={name} className="rounded border border-danger/30 bg-danger-dim px-2 py-1 text-sm text-txt-primary">
                      {name}
                    </div>
                  ))}
                  {filteredCatalog?.requiredAspects?.length === 0 ? (
                    <div className="text-sm text-txt-muted">-</div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-app-border bg-app-bg/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">Empfohlen</p>
                <div className="mt-2 space-y-1 max-h-[52vh] overflow-auto pr-1">
                  {(filteredCatalog?.recommendedAspects || []).map((name) => (
                    <div key={name} className="rounded border border-amber-500/30 bg-amber-900/10 px-2 py-1 text-sm text-txt-primary">
                      {name}
                    </div>
                  ))}
                  {filteredCatalog?.recommendedAspects?.length === 0 ? (
                    <div className="text-sm text-txt-muted">-</div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-app-border bg-app-bg/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">Optional</p>
                <div className="mt-2 space-y-1 max-h-[52vh] overflow-auto pr-1">
                  {(filteredCatalog?.optionalAspects || []).map((name) => (
                    <div key={name} className="rounded border border-app-border bg-app-bg/20 px-2 py-1 text-sm text-txt-primary">
                      {name}
                    </div>
                  ))}
                  {filteredCatalog?.optionalAspects?.length === 0 ? (
                    <div className="text-sm text-txt-muted">-</div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

