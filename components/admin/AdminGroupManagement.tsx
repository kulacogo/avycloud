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
import { Notice } from '../ui/Notice';
import { ConfirmDialog } from '../ui/ConfirmDialog';

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
      setNotice({ tone: 'success', title: 'Gruppe gelöscht' });
    } catch (e: any) {
      setError(e?.message || 'Failed to delete group');
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">Admin: Groups</h2>
        <p className="text-sm text-txt-muted">
          Best practice: Rechte werden primär über Rollen vergeben. Gruppen bündeln Rollen; User können zusätzlich direkte
          Overrides bekommen (sparsam nutzen).
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      <ConfirmDialog
        open={deleteDialogOpen}
        title="Gruppe löschen?"
        tone="danger"
        description={
          selectedGroupId ? (
            <span>
              Gruppe <b>{selectedGroupId}</b> wird dauerhaft gelöscht.
            </span>
          ) : (
            'Gruppe wird dauerhaft gelöscht.'
          )
        }
        confirmLabel="Löschen"
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={async () => {
          await confirmDeleteSelectedGroup();
          setDeleteDialogOpen(false);
        }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Gruppen</h3>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-txt-primary"
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
              className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
            />
            <input
              value={newGroupId}
              onChange={(e) => setNewGroupId(e.target.value)}
              placeholder="groupId (optional, z.B. lager-team)"
              className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={create}
              disabled={!newGroupName.trim()}
              className="w-full rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2.5 font-semibold text-txt-primary"
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
                className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                  selectedGroupId === g.id ? 'bg-accent/50 text-txt-primary' : 'bg-app-bg/30 text-txt-secondary hover:bg-app-elevated/40'
                }`}
              >
                <div className="font-semibold">{g.name || g.id}</div>
                <div className="text-xs text-txt-muted">{g.id}</div>
              </button>
            ))}
            {groups.length === 0 && <div className="text-sm text-txt-muted">Keine Gruppen.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold">Details</h3>
              <p className="text-xs text-txt-muted">Gruppe: {selectedGroup?.id || '—'}</p>
            </div>
            <button
              type="button"
              onClick={deleteSelectedGroup}
              disabled={!selectedGroupId}
              className="rounded-xl bg-danger hover:bg-danger/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
            >
              Gruppe löschen
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Rollen der Gruppe</div>
            <div className="flex flex-wrap gap-3">
              {ROLE_OPTIONS.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm text-txt-secondary">
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
              <div className="text-sm font-semibold">Members</div>
              <div className="space-y-1 max-h-[320px] overflow-auto">
                {members.map((u) => {
                  const uid = (u.uid as string) || u.id;
                  return (
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-xl bg-app-bg/30 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-txt-primary truncate">{u.email || uid}</div>
                        <div className="text-xs text-txt-muted truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUserFromGroup(uid)}
                        className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 px-3 py-1.5 text-xs font-semibold text-txt-primary"
                      >
                        Entfernen
                      </button>
                    </div>
                  );
                })}
                {selectedGroupId && members.length === 0 && (
                  <div className="text-sm text-txt-muted">Keine Members.</div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">User hinzufügen</div>
              <div className="space-y-1 max-h-[320px] overflow-auto">
                {users.map((u) => {
                  const uid = (u.uid as string) || u.id;
                  const inGroup = Boolean(selectedGroupId && Array.isArray((u as any).groupIds) && (u as any).groupIds.includes(selectedGroupId));
                  return (
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-xl bg-app-bg/20 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-txt-primary truncate">{u.email || uid}</div>
                        <div className="text-xs text-txt-muted truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        disabled={!selectedGroupId || inGroup}
                        onClick={() => addUserToGroup(uid)}
                        className="rounded-xl bg-accent hover:bg-accent disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-txt-primary"
                      >
                        {inGroup ? '✓' : 'Add'}
                      </button>
                    </div>
                  );
                })}
                {users.length === 0 && <div className="text-sm text-txt-muted">Keine Users geladen.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

