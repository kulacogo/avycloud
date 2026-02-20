import React from 'react';
import { UserPlus } from 'lucide-react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Benutzer' },
  { id: 'roles', label: 'Rollen' },
  { id: 'groups', label: 'Gruppen' },
  { id: 'llm', label: 'LLM-Konfiguration' },
  { id: 'integrations', label: 'Integrationen' },
  { id: 'bulk', label: 'Bulk Actions' },
];

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Administration</h1>
          <div className="page-header-sub">System- und Benutzerverwaltung</div>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-primary" type="button">
            <UserPlus size={14} />
            Benutzer einladen
          </button>
        </div>
      </div>

      <div className="content">
        {/* Tab Navigation (Desktop) */}
        <div className="tab-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab-btn${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Panels */}
        {tab === 'users' && (
          <div className="tab-panel" key="users">
            <AdminUserManagement />
          </div>
        )}
        {tab === 'groups' && (
          <div className="tab-panel" key="groups">
            <AdminGroupManagement />
          </div>
        )}
        {tab === 'roles' && (
          <div className="tab-panel" key="roles">
            <AdminRoleManagement />
          </div>
        )}
        {tab === 'llm' && (
          <div className="tab-panel" key="llm">
            <AdminLlmManagement />
          </div>
        )}
        {tab === 'integrations' && (
          <div className="tab-panel" key="integrations">
            <AdminIntegrations />
          </div>
        )}
        {tab === 'bulk' && (
          <div className="tab-panel" key="bulk">
            <AdminBulkActions />
          </div>
        )}
      </div>
    </>
  );
};
