import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';
import { PageHeader } from '../ui/PageHeader';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations';

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <div className="space-y-6">
      <PageHeader title="Admin" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'users' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('groups')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'groups' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          Groups
        </button>
        <button
          type="button"
          onClick={() => setTab('roles')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'roles' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          Roles
        </button>
        <button
          type="button"
          onClick={() => setTab('llm')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'llm' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          LLM
        </button>
        <button
          type="button"
          onClick={() => setTab('bulk')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'bulk' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          Bulk
        </button>
        <button
          type="button"
          onClick={() => setTab('integrations')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'integrations' ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-primary)] hover:bg-[var(--surface)]'
          }`}
        >
          Integrations
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
      ) : tab === 'integrations' ? (
        <AdminIntegrations />
      ) : (
        <AdminRoleManagement />
      )}
    </div>
  );
};

