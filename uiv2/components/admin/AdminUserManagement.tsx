import React from 'react';
import { adminInviteUser, adminListUsers, adminSetUserRoles, type AdminUserRecord } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Notice } from '../ui/Notice';

const ROLE_OPTIONS = ['admin', 'manager', 'operation', 'catalog'] as const;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const AdminUserManagement: React.FC = () => {
  const { logout } = useAuth();
  const [users, setUsers] = React.useState<AdminUserRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRoles, setInviteRoles] = React.useState<string[]>([]);
  const [inviting, setInviting] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const list = await adminListUsers(500);
      setUsers(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const toggleInviteRole = (role: string) => {
    setInviteRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  const invite = async () => {
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      await adminInviteUser(normalizeEmail(inviteEmail), inviteRoles);
      setInviteEmail('');
      setInviteRoles([]);
      await load();
      setNotice({ tone: 'success', title: 'Invite wurde versendet' });
    } catch (e: any) {
      setError(e?.message || 'Invite failed');
    } finally {
      setInviting(false);
    }
  };

  const updateUserRoles = async (uid: string, roles: string[]) => {
    setError(null);
    try {
      await adminSetUserRoles(uid, roles);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update roles');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Admin: User Management</h2>
          <p className="text-sm text-slate-400">User anlegen, Rollen zuweisen, Zugang aktivieren via Mail-Links.</p>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-xl bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-white"
        >
          Logout
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
          {error}
        </div>
      )}

      {notice ? (
        <Notice tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)} details={notice.details} />
      ) : null}

      <div className="rounded-2xl border border-white/10 bg-slate-800/60 p-5 space-y-4">
        <h3 className="font-semibold">User einladen</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@trendocean.de"
            className="md:col-span-2 rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
          />
          <button
            type="button"
            disabled={inviting || !inviteEmail.trim()}
            onClick={invite}
            className="rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2.5 font-semibold text-white"
          >
            {inviting ? 'Sende…' : 'Invite senden'}
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {ROLE_OPTIONS.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={inviteRoles.includes(role)}
                onChange={() => toggleInviteRole(role)}
              />
              <span>{role}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-400">
          Der Invite enthält <strong>Passwort-Reset</strong> + <strong>E-Mail-Verifizierung</strong>.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-800/60 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Users</h3>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-white"
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-slate-400">Lade…</div>
        ) : (
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 pr-3">Email</th>
                  <th className="text-left py-2 pr-3">UID</th>
                  <th className="text-left py-2 pr-3">Roles</th>
                  <th className="text-left py-2 pr-3">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const uid = (u.uid as string) || u.id;
                  const roles = Array.isArray(u.roles) ? u.roles : [];
                  return (
                    <tr key={uid} className="border-t border-white/5">
                      <td className="py-2 pr-3 text-slate-100">{u.email || '—'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-400">{uid}</td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-2">
                          {ROLE_OPTIONS.map((role) => (
                            <label key={role} className="flex items-center gap-1 text-xs text-slate-200">
                              <input
                                type="checkbox"
                                checked={roles.includes(role)}
                                onChange={() => {
                                  const next = roles.includes(role)
                                    ? roles.filter((r) => r !== role)
                                    : [...roles, role];
                                  updateUserRoles(uid, next);
                                }}
                              />
                              <span>{role}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white"
                          onClick={() => {
                            navigator.clipboard?.writeText(String(u.email || '')).catch(() => {});
                          }}
                        >
                          Email kopieren
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-slate-400">
                      Keine Users gefunden.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

