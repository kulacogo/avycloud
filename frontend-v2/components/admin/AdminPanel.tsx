import React from 'react';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminRoleManagement } from './AdminRoleManagement';
import { AdminGroupManagement } from './AdminGroupManagement';
import { AdminLlmManagement } from './AdminLlmManagement';
import { AdminBulkActions } from './AdminBulkActions';
import { AdminIntegrations } from './AdminIntegrations';
import { AdminEbayTaxonomy } from './AdminEbayTaxonomy';

type Tab = 'users' | 'groups' | 'roles' | 'llm' | 'bulk' | 'integrations' | 'ebay';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'roles', label: 'Roles' },
  { id: 'groups', label: 'Groups' },
  { id: 'llm', label: 'LLM Configuration' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'bulk', label: 'Bulk Actions' },
  { id: 'ebay', label: 'eBay' },
];

export const AdminPanel: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>('users');

  return (
    <div className="flex flex-col min-h-0">
      {/* ═══════ PAGE HEADER ═══════ */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            Administration
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--text-tertiary)]">
            System- & Benutzerverwaltung
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'users' && (
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--avy-purple,#635BFF)] px-4 py-2 text-[13px] font-semibold text-white transition-all hover:bg-[var(--avy-purple-hover,#5148E5)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 1v12M1 7h12" />
              </svg>
              Invite User
            </button>
          )}
          {tab === 'roles' && (
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--avy-purple,#635BFF)] px-4 py-2 text-[13px] font-semibold text-white transition-all hover:bg-[var(--avy-purple-hover,#5148E5)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 1v12M1 7h12" />
              </svg>
              New Role
            </button>
          )}
          {tab === 'integrations' && (
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--avy-purple,#635BFF)] px-4 py-2 text-[13px] font-semibold text-white transition-all hover:bg-[var(--avy-purple-hover,#5148E5)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 1v12M1 7h12" />
              </svg>
              Add Integration
            </button>
          )}
          {tab === 'llm' && (
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[13px] font-semibold text-[var(--text-secondary)] transition-all hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] hover:shadow-[var(--shadow-sm)]">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 8.5v3a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 11.5v-3M7 1v8M4 4l3-3 3 3" />
              </svg>
              Export Logs
            </button>
          )}
        </div>
      </div>

      {/* ═══════ TAB NAVIGATION (Desktop pills) ═══════ */}
      <div className="mt-5 mb-6">
        <nav
          className="hidden sm:flex items-center gap-1 rounded-lg bg-[var(--surface-secondary)] p-1 overflow-x-auto"
          aria-label="Admin tabs"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-4 py-[7px] text-[13px] font-medium transition-all duration-200 ${
                tab === t.id
                  ? 'bg-[var(--surface)] text-[var(--text-primary)] font-semibold shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] bg-transparent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Mobile tab dropdown */}
        <div className="sm:hidden">
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as Tab)}
            className="w-full appearance-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm font-medium text-[var(--text-primary)] outline-none focus:border-[var(--avy-purple,#635BFF)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] cursor-pointer bg-[length:12px_12px] bg-[right_12px_center] bg-no-repeat"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='12' height='12' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%238898AA' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")`,
            }}
          >
            {TABS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ═══════ TAB CONTENT ═══════ */}
      <div key={tab} className="animate-slide-up">
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
    </div>
  );
};
