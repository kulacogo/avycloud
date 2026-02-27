import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';
import { AdminEbayTaxonomy } from './AdminEbayTaxonomy';
import { PageHeader } from '../ui/PageHeader';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations' | 'ebay';

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <div className="space-y-5">
      <PageHeader title="Admin" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'users' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('groups')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'groups' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          Groups
        </button>
        <button
          type="button"
          onClick={() => setTab('roles')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'roles' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          Roles
        </button>
        <button
          type="button"
          onClick={() => setTab('llm')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'llm' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          LLM
        </button>
        <button
          type="button"
          onClick={() => setTab('bulk')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'bulk' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          Bulk
        </button>
        <button
          type="button"
          onClick={() => setTab('integrations')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'integrations' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          Integrations
        </button>
        <button
          type="button"
          onClick={() => setTab('ebay')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'ebay' ? 'bg-sky-600 text-white' : 'bg-slate-800/40 text-slate-200 hover:bg-white/10'
          }`}
        >
          eBay
        </button>
      </div>

      {tab === 'users' ? (
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
      ) : (
        <AdminRoleManagement />
      )}
    </div>
  );
};

