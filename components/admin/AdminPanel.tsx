import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminJobsManagement } from './AdminJobsManagement';
import { AdminRulebookManagement } from './AdminRulebookManagement';
import { AdminProductCoverageDashboard } from './AdminProductCoverageDashboard';
import { fetchProducts } from '../../api/client';
import type { Product } from '../../types';
import { InventoryDrilldownPanel } from '../InventoryDrilldownPanel';
import { PageHeader } from '../ui/PageHeader';
import { HelpDisclosure } from '../ui/HelpDisclosure';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'jobs' | 'rulebook';

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');
  const [products, setProducts] = React.useState<Product[]>([]);
  const [productsError, setProductsError] = React.useState<string | null>(null);
  const [productsLoading, setProductsLoading] = React.useState(false);
  const [drilldown, setDrilldown] = React.useState<{ title: string; ids: string[] } | null>(null);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      setProductsLoading(true);
      setProductsError(null);
      try {
        const list = await fetchProducts();
        if (!ignore) setProducts(Array.isArray(list) ? list : []);
      } catch (e: any) {
        if (!ignore) setProductsError(e?.message || String(e));
      } finally {
        if (!ignore) setProductsLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const openProductInNewTab = React.useCallback((productId: string) => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}${window.location.pathname}#/sheet/${encodeURIComponent(productId)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin"
        subtitle="Benutzer, Rollen, Jobs und Regelwerk verwalten. Änderungen hier wirken systemweit."
      >
        <HelpDisclosure title="Was kann ich hier tun? (Kurz erklärt)">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <b>Data coverage</b>: Überblick über Datenqualität (Titel-Regeln, GPSR, K‑Typ, Preise) inkl. Drilldown.
            </li>
            <li>
              <b>Jobs</b>: Backend-Jobs starten (z. B. GPSR-Web-Enrich für Menge ≥ 1).
            </li>
            <li>
              <b>Rulebook</b>: Regeln ändern und anschließend “Initial Run + Delta Sync” starten, damit Produkte + BaseLinker aktualisiert werden.
            </li>
          </ul>
        </HelpDisclosure>
      </PageHeader>

      <AdminProductCoverageDashboard onOpenDrilldown={(payload) => setDrilldown(payload)} />

      {productsError ? (
        <div className="rounded-xl bg-rose-900/30 p-3 text-sm text-rose-200 ring-1 ring-rose-700/40">
          Drilldown list unavailable: {productsError}
        </div>
      ) : null}

      {drilldown && drilldown.ids?.length ? (
        <InventoryDrilldownPanel
          title={drilldown.title}
          products={products}
          ids={drilldown.ids}
          onClose={() => setDrilldown(null)}
          onOpenProductInNewTab={openProductInNewTab}
        />
      ) : productsLoading ? (
        <div className="rounded-xl bg-slate-900/40 p-3 text-xs text-slate-400 ring-1 ring-slate-700/40">
          Loading products for drilldown…
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'users' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('groups')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'groups' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Groups
        </button>
        <button
          type="button"
          onClick={() => setTab('roles')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'roles' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Roles
        </button>
        <button
          type="button"
          onClick={() => setTab('llm')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'llm' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          LLM
        </button>
        <button
          type="button"
          onClick={() => setTab('jobs')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'jobs' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Jobs
        </button>
        <button
          type="button"
          onClick={() => setTab('rulebook')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'rulebook' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Rulebook
        </button>
      </div>

      {tab === 'users' ? (
        <AdminUserManagement />
      ) : tab === 'groups' ? (
        <AdminGroupManagement />
      ) : tab === 'llm' ? (
        <AdminLlmManagement />
      ) : tab === 'jobs' ? (
        <AdminJobsManagement />
      ) : tab === 'rulebook' ? (
        <AdminRulebookManagement />
      ) : (
        <AdminRoleManagement />
      )}
    </div>
  );
};

