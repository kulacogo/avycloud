import React from 'react';
import { Plus, RefreshCw, Trash2, UserPlus, UserMinus } from 'lucide-react';
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

const AVATAR_COLORS = [
  'linear-gradient(135deg, #635BFF, #0070F3)',
  'linear-gradient(135deg, #0E9F6E, #059669)',
  'linear-gradient(135deg, #D97706, #F59E0B)',
  'linear-gradient(135deg, #DC2626, #F87171)',
  'linear-gradient(135deg, #5E6E80, #8898AA)',
];

const getInitials = (email: string) => {
  const name = email.split('@')[0] || '';
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

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
    <>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-5)' }}>
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

      {/* Header with new group creation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>Gruppen verwalten</div>
          <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Organisiere Benutzer in Arbeitsgruppen</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" onClick={load} disabled={loading} className="btn btn-secondary btn-sm">
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {/* Create Group Card */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">Neue Gruppe erstellen</span>
        </div>
        <div style={{ padding: 'var(--space-5) var(--space-6)' }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Gruppenname</label>
              <input
                value={newGroupName}
                onChange={(e) => {
                  setNewGroupName(e.target.value);
                  if (!newGroupId.trim()) setNewGroupId(normalizeId(e.target.value));
                }}
                placeholder="z.B. Lager-Team"
                className="form-input"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Group ID <span className="form-label-sub">(optional)</span></label>
              <input
                value={newGroupId}
                onChange={(e) => setNewGroupId(e.target.value)}
                placeholder="z.B. lager-team"
                className="form-input"
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
            <button type="button" onClick={create} disabled={!newGroupName.trim()} className="btn btn-primary">
              <Plus size={14} />
              Gruppe erstellen
            </button>
          </div>
        </div>
      </div>

      {/* Group Cards Grid */}
      <div className="group-grid" style={{ marginBottom: 'var(--space-6)' }}>
        {groups.map((g) => {
          const groupMembers = users.filter((u) => Array.isArray((u as any).groupIds) && (u as any).groupIds.includes(g.id));
          const isSelected = selectedGroupId === g.id;
          return (
            <div
              key={g.id}
              className="group-card"
              style={{
                cursor: 'pointer',
                borderColor: isSelected ? 'var(--avy-purple)' : undefined,
                boxShadow: isSelected ? 'var(--shadow-focus)' : undefined,
              }}
              onClick={() => setSelectedGroupId(g.id)}
            >
              <div className="group-card-name">{g.name || g.id}</div>
              <div className="group-card-desc">{g.id}</div>
              <div className="group-card-members">
                <div className="group-card-avatars">
                  {groupMembers.slice(0, 3).map((u, idx) => {
                    const uid = (u.uid as string) || u.id;
                    return (
                      <div
                        key={uid}
                        className="avatar"
                        style={{ background: AVATAR_COLORS[idx % AVATAR_COLORS.length] }}
                      >
                        {getInitials(u.email || uid)}
                      </div>
                    );
                  })}
                </div>
                <span className="group-card-count">
                  {groupMembers.length} {groupMembers.length === 1 ? 'Mitglied' : 'Mitglieder'}
                </span>
              </div>
              <div className="group-card-footer">
                <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setSelectedGroupId(g.id); }}>
                  Bearbeiten
                </button>
              </div>
            </div>
          );
        })}
        {groups.length === 0 && (
          <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Gruppen.</div>
        )}
      </div>

      {/* Selected Group Detail */}
      {selectedGroup && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Details: {selectedGroup.name || selectedGroup.id}</span>
            <button type="button" onClick={deleteSelectedGroup} disabled={!selectedGroupId} className="btn btn-danger btn-sm">
              <Trash2 size={12} />
              Gruppe loeschen
            </button>
          </div>
          <div style={{ padding: 'var(--space-5) var(--space-6)' }}>
            {/* Group Roles */}
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: 'var(--space-3)' }}>Rollen der Gruppe</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                {ROLE_OPTIONS.map((role) => (
                  <label key={role} className="toggle-row">
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

            {/* Members + Add User side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}>
              {/* Members */}
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: 'var(--space-3)' }}>Members</div>
                <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {members.map((u) => {
                    const uid = (u.uid as string) || u.id;
                    return (
                      <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-secondary)' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email || uid}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{uid}</div>
                        </div>
                        <button type="button" onClick={() => removeUserFromGroup(uid)} className="btn btn-secondary btn-sm">
                          <UserMinus size={12} />
                        </button>
                      </div>
                    );
                  })}
                  {selectedGroupId && members.length === 0 && (
                    <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Members.</div>
                  )}
                </div>
              </div>

              {/* Add User */}
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: 'var(--space-3)' }}>User hinzufuegen</div>
                <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {users.map((u) => {
                    const uid = (u.uid as string) || u.id;
                    const inGroup = Boolean(selectedGroupId && Array.isArray((u as any).groupIds) && (u as any).groupIds.includes(selectedGroupId));
                    return (
                      <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-secondary)', opacity: inGroup ? 0.5 : 1 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email || uid}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{uid}</div>
                        </div>
                        <button
                          type="button"
                          disabled={!selectedGroupId || inGroup}
                          onClick={() => addUserToGroup(uid)}
                          className="btn btn-primary btn-sm"
                        >
                          <UserPlus size={12} />
                        </button>
                      </div>
                    );
                  })}
                  {users.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Users geladen.</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
