import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminJobsManagement } from './AdminJobsManagement';
import { AdminRulebookManagement } from './AdminRulebookManagement';
import { AdminProductCoverageDashboard } from './AdminProductCoverageDashboard';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'jobs' | 'rulebook';

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <div className="space-y-6">
      <AdminProductCoverageDashboard />

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

