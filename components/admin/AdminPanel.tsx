import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';
import { AdminEbayTaxonomy } from './AdminEbayTaxonomy';
import { AdminIdentifyRunsDashboard } from './AdminIdentifyRunsDashboard';
import { AdminSystemHealth } from './AdminSystemHealth';
import { PageHeader } from '../ui/PageHeader';

type Tab = 'health' | 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations' | 'ebay' | 'identify-runs';

export const AdminPanel: React.FC = () => {
  // HARDEN-Wave-9 (2026-05-22): System-Health als Default-Tab beim Öffnen.
  // Damit sieht der Operator beim Klick auf "Admin" sofort den Live-Status.
  const [tab, setTab] = React.useState<Tab>('health');

  return (
    <div className="space-y-5">
      <PageHeader title="Admin" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab('health')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'health' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          System-Status
        </button>
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'users' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('groups')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'groups' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Groups
        </button>
        <button
          type="button"
          onClick={() => setTab('roles')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'roles' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Roles
        </button>
        <button
          type="button"
          onClick={() => setTab('llm')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'llm' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          LLM
        </button>
        <button
          type="button"
          onClick={() => setTab('bulk')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'bulk' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Bulk
        </button>
        <button
          type="button"
          onClick={() => setTab('integrations')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'integrations' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Integrations
        </button>
        <button
          type="button"
          onClick={() => setTab('ebay')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'ebay' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          eBay
        </button>
        <button
          type="button"
          onClick={() => setTab('identify-runs')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'identify-runs' ? 'bg-accent text-txt-primary' : 'bg-app-surface text-txt-secondary hover:bg-white/10'
          }`}
        >
          Identify Runs
        </button>
      </div>

      {tab === 'health' ? (
        <AdminSystemHealth />
      ) : tab === 'users' ? (
        <AdminUserManagement />
      ) : tab === 'groups' ? (
        <AdminGroupManagement />
      ) : tab === 'llm' ? (
        <AdminLlmManagement />
      ) : tab === 'bulk' ? (
        <AdminBulkActions />
      ) : tab === 'ebay' ? (
        <AdminEbayTaxonomy />
      ) : tab === 'integrations' ? (
        <AdminIntegrations />
      ) : tab === 'identify-runs' ? (
        <AdminIdentifyRunsDashboard />
      ) : (
        <AdminRoleManagement />
      )}
    </div>
  );
};

