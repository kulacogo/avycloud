import React from 'react';
import {
  adminCreateGroup,
  adminDeleteGroup,
  adminInviteUser,
  adminListGroups,
  adminListUsers,
  adminSetUserGroups,
  adminUpdateGroup,
  type AdminGroupRecord,
  type AdminUserRecord,
} from '../../api/client';
import { Notice } from '../shared/Notice';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const ROLE_OPTIONS = ['admin', 'manager', 'operation', 'catalog'] as const;

const normalizeId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

export const AdminGroupManagement: React.FC = () => {
  const [groups, setGroups] = React.useState<AdminGroupRecord[]>([]);
  const [users, setUsers] = React.useState<AdminUserRecord[]>([]);
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [newGroupName, setNewGroupName] = React.useState('');
  const [newGroupId, setNewGroupId] = React.useState('');
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const [g, u] = await Promise.all([adminListGroups(500), adminListUsers(500)]);
      setGroups(g.sort((a, b) => String(a.id).localeCompare(String(b.id))));
      setUsers(u);
      if (!selectedGroupId && g.length) setSelectedGroupId(g[0].id);
    } catch (e: any) {
      setError(e?.message || 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) || null;
  const members = selectedGroupId
    ? users.filter((u) => Array.isArray((u as any).groupIds) && (u as any).groupIds.includes(selectedGroupId))
    : [];

  const create = async () => {
    setError(null);
    try {
      const name = newGroupName.trim();
      if (!name) return;
      await adminCreateGroup({ name, groupId: newGroupId.trim() || undefined, roleIds: [] });
      setNewGroupName('');
      setNewGroupId('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to create group');
    }
  };

  const toggleGroupRole = async (roleId: string) => {
    if (!selectedGroup) return;
    const current = Array.isArray(selectedGroup.roleIds) ? selectedGroup.roleIds : [];
    const next = current.includes(roleId) ? current.filter((r) => r !== roleId) : [...current, roleId];
    setError(null);
    try {
      await adminUpdateGroup(selectedGroup.id, { roleIds: next });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update group roles');
    }
  };

  const addUserToGroup = async (uid: string) => {
    if (!selectedGroupId) return;
    const user = users.find((u) => ((u.uid as string) || u.id) === uid);
    if (!user) return;
    const current = Array.isArray((user as any).groupIds) ? (user as any).groupIds : [];
    const next = Array.from(new Set([...current, selectedGroupId]));
    setError(null);
    try {
      await adminSetUserGroups(uid, next);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to add user to group');
    }
  };

  const removeUserFromGroup = async (uid: string) => {
    if (!selectedGroupId) return;
    const user = users.find((u) => ((u.uid as string) || u.id) === uid);
    if (!user) return;
    const current = Array.isArray((user as any).groupIds) ? (user as any).groupIds : [];
    const next = current.filter((g: string) => g !== selectedGroupId);
    setError(null);
    try {
      await adminSetUserGroups(uid, next);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to remove user from group');
    }
  };

  const deleteSelectedGroup = async () => {
    if (!selectedGroupId) return;
    setDeleteDialogOpen(true);
    return;
  };

  const confirmDeleteSelectedGroup = async () => {
    if (!selectedGroupId) return;
    setError(null);
    setNotice(null);
    try {
      await adminDeleteGroup(selectedGroupId);
      setSelectedGroupId(null);
      await load();
      setNotice({ tone: 'success', title: 'Gruppe geloescht' });
    } catch (e: any) {
      setError(e?.message || 'Failed to delete group');
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">Gruppen</h2>
        <p className="text-sm text-[var(--text-tertiary)]">
          Best practice: Rechte werden primaer ueber Rollen vergeben. Gruppen buendeln Rollen; User koennen zusaetzlich direkte
          Overrides bekommen (sparsam nutzen).
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-[var(--error-bg)] p-3 text-sm text-[var(--error)] ring-1 ring-[var(--error-border)]">
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      <ConfirmDialog
        open={deleteDialogOpen}
        title="Gruppe loeschen?"
        tone="danger"
        description={
          selectedGroupId ? (
            <span>
              Gruppe <b>{selectedGroupId}</b> wird dauerhaft geloescht.
            </span>
          ) : (
            'Gruppe wird dauerhaft geloescht.'
          )
        }
        confirmLabel="Loeschen"
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={async () => {
          await confirmDeleteSelectedGroup();
          setDeleteDialogOpen(false);
        }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Gruppen</h3>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-secondary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
            >
              Refresh
            </button>
          </div>

          <div className="space-y-2">
            <input
              value={newGroupName}
              onChange={(e) => {
                setNewGroupName(e.target.value);
                if (!newGroupId.trim()) setNewGroupId(normalizeId(e.target.value));
              }}
              placeholder="Group name (z.B. Lager-Team)"
              className="w-full rounded-lg bg-[var(--bg)] border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--avy-purple)] transition-colors duration-200"
            />
            <input
              value={newGroupId}
              onChange={(e) => setNewGroupId(e.target.value)}
              placeholder="groupId (optional, z.B. lager-team)"
              className="w-full rounded-lg bg-[var(--bg)] border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--avy-purple)] transition-colors duration-200"
            />
            <button
              type="button"
              onClick={create}
              disabled={!newGroupName.trim()}
              className="w-full rounded-lg bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white transition-all duration-200"
            >
              Gruppe erstellen
            </button>
          </div>

          <div className="space-y-1">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedGroupId(g.id)}
                className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
                  selectedGroupId === g.id
                    ? 'bg-[var(--avy-purple-glow)] text-[var(--avy-purple)] border border-[var(--avy-purple)]/20'
                    : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] border border-transparent'
                }`}
              >
                <div className="font-semibold text-[var(--text-primary)]">{g.name || g.id}</div>
                <div className="text-xs text-[var(--text-tertiary)]">{g.id}</div>
              </button>
            ))}
            {groups.length === 0 && <div className="text-sm text-[var(--text-tertiary)]">Keine Gruppen.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Details</h3>
              <p className="text-xs text-[var(--text-tertiary)]">Gruppe: {selectedGroup?.id || '\u2014'}</p>
            </div>
            <button
              type="button"
              onClick={deleteSelectedGroup}
              disabled={!selectedGroupId}
              className="rounded-lg bg-[var(--error-bg)] text-[var(--error)] border border-[var(--error-border)] hover:bg-[var(--error)] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold transition-all duration-200"
            >
              Gruppe loeschen
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Rollen der Gruppe</div>
            <div className="flex flex-wrap gap-3">
              {ROLE_OPTIONS.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedGroup?.roleIds?.includes(role))}
                    onChange={() => toggleGroupRole(role)}
                    disabled={!selectedGroup}
                  />
                  <span>{role}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Members</div>
              <div className="space-y-1 max-h-[320px] overflow-auto">
                {members.map((u) => {
                  const uid = (u.uid as string) || u.id;
                  return (
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--text-primary)] truncate">{u.email || uid}</div>
                        <div className="text-xs text-[var(--text-tertiary)] truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUserFromGroup(uid)}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
                      >
                        Entfernen
                      </button>
                    </div>
                  );
                })}
                {selectedGroupId && members.length === 0 && (
                  <div className="text-sm text-[var(--text-tertiary)]">Keine Members.</div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold text-[var(--text-primary)]">User hinzufuegen</div>
              <div className="space-y-1 max-h-[320px] overflow-auto">
                {users.map((u) => {
                  const uid = (u.uid as string) || u.id;
                  const inGroup = Boolean(selectedGroupId && Array.isArray((u as any).groupIds) && (u as any).groupIds.includes(selectedGroupId));
                  return (
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--text-primary)] truncate">{u.email || uid}</div>
                        <div className="text-xs text-[var(--text-tertiary)] truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        disabled={!selectedGroupId || inGroup}
                        onClick={() => addUserToGroup(uid)}
                        className="rounded-lg bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-semibold text-white transition-all duration-200"
                      >
                        {inGroup ? '\u2713' : 'Add'}
                      </button>
                    </div>
                  );
                })}
                {users.length === 0 && <div className="text-sm text-[var(--text-tertiary)]">Keine Users geladen.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
