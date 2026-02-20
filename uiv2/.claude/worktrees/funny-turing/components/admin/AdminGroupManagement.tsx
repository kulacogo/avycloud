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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Admin: Groups</h2>
        <p className="text-sm text-slate-400">
          Best practice: Rechte werden primär über Rollen vergeben. Gruppen bündeln Rollen; User können zusätzlich direkte
          Overrides bekommen (sparsam nutzen).
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
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
        <div className="rounded-2xl border border-white/10 bg-slate-800/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Gruppen</h3>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-white"
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
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
            />
            <input
              value={newGroupId}
              onChange={(e) => setNewGroupId(e.target.value)}
              placeholder="groupId (optional, z.B. lager-team)"
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={create}
              disabled={!newGroupName.trim()}
              className="w-full rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2.5 font-semibold text-white"
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
                  selectedGroupId === g.id ? 'bg-sky-700/50 text-white' : 'bg-slate-900/30 text-slate-200 hover:bg-slate-700/40'
                }`}
              >
                <div className="font-semibold">{g.name || g.id}</div>
                <div className="text-xs text-slate-400">{g.id}</div>
              </button>
            ))}
            {groups.length === 0 && <div className="text-sm text-slate-400">Keine Gruppen.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-slate-800/60 p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold">Details</h3>
              <p className="text-xs text-slate-400">Gruppe: {selectedGroup?.id || '—'}</p>
            </div>
            <button
              type="button"
              onClick={deleteSelectedGroup}
              disabled={!selectedGroupId}
              className="rounded-xl bg-rose-700 hover:bg-rose-600 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white"
            >
              Gruppe löschen
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Rollen der Gruppe</div>
            <div className="flex flex-wrap gap-3">
              {ROLE_OPTIONS.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm text-slate-200">
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
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-xl bg-slate-900/30 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 truncate">{u.email || uid}</div>
                        <div className="text-xs text-slate-400 truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUserFromGroup(uid)}
                        className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Entfernen
                      </button>
                    </div>
                  );
                })}
                {selectedGroupId && members.length === 0 && (
                  <div className="text-sm text-slate-400">Keine Members.</div>
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
                    <div key={uid} className="flex items-center justify-between gap-2 rounded-xl bg-slate-900/20 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 truncate">{u.email || uid}</div>
                        <div className="text-xs text-slate-400 truncate">{uid}</div>
                      </div>
                      <button
                        type="button"
                        disabled={!selectedGroupId || inGroup}
                        onClick={() => addUserToGroup(uid)}
                        className="rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        {inGroup ? '✓' : 'Add'}
                      </button>
                    </div>
                  );
                })}
                {users.length === 0 && <div className="text-sm text-slate-400">Keine Users geladen.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

