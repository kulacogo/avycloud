import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';
import { PageHeader } from '../ui/PageHeader';
import { HelpDisclosure } from '../ui/HelpDisclosure';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations';

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin"
        subtitle="Benutzer, Rollen, LLM-Konfiguration und Bulk-Aktionen verwalten. Änderungen hier wirken systemweit."
      >
        <HelpDisclosure title="Was kann ich hier tun? (Kurz erklärt)">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <b>Users / Groups / Roles</b>: Zugriff und Berechtigungen verwalten.
            </li>
            <li>
              <b>LLM</b>: Prompts/Scopes konfigurieren.
            </li>
            <li>
              <b>Bulk</b>: Konsolidierte Bulk-Aktionen (z. B. Preis/Titel/Kategorie/K‑Typ, Export) anstoßen.
            </li>
            <li>
              <b>Integrations</b>: Marktplatz-/Account-Verbindungen (z. B. eBay OAuth) und Listing-Snapshots verwalten.
            </li>
          </ul>
        </HelpDisclosure>
      </PageHeader>

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
          onClick={() => setTab('bulk')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'bulk' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
          }`}
        >
          Bulk
        </button>
        <button
          type="button"
          onClick={() => setTab('integrations')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === 'integrations' ? 'bg-sky-600 text-white' : 'bg-slate-800/70 text-slate-200 hover:bg-slate-700'
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

