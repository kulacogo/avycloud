import React from 'react';
import { Pencil, Trash2, RefreshCw, Copy } from 'lucide-react';
import { adminInviteUser, adminListUsers, adminSetUserRoles, type AdminUserRecord } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Notice } from '../ui/Notice';

const ROLE_OPTIONS = ['admin', 'manager', 'operation', 'catalog'] as const;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const getInitials = (email: string) => {
  const name = email.split('@')[0] || '';
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const AVATAR_COLORS = [
  'linear-gradient(135deg, #635BFF, #0070F3)',
  'linear-gradient(135deg, #0E9F6E, #059669)',
  'linear-gradient(135deg, #D97706, #F59E0B)',
  'linear-gradient(135deg, #DC2626, #F87171)',
  'linear-gradient(135deg, #5E6E80, #8898AA)',
];

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
    <>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-5)' }}>
          {error}
        </div>
      )}

      {notice ? (
        <Notice tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)} details={notice.details} />
      ) : null}

      {/* Invite Card */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">User einladen</span>
        </div>
        <div style={{ padding: 'var(--space-5) var(--space-6)' }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">E-Mail Adresse</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@trendocean.de"
                className="form-input"
              />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="button"
                disabled={inviting || !inviteEmail.trim()}
                onClick={invite}
                className="btn btn-primary"
              >
                {inviting ? 'Sende...' : 'Invite senden'}
              </button>
            </div>
            <div className="form-group full">
              <label className="form-label">Rollen zuweisen</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                {ROLE_OPTIONS.map((role) => (
                  <label key={role} className="toggle-row">
                    <input
                      type="checkbox"
                      checked={inviteRoles.includes(role)}
                      onChange={() => toggleInviteRole(role)}
                    />
                    <span>{role}</span>
                  </label>
                ))}
              </div>
              <div className="form-hint" style={{ marginTop: '8px' }}>
                Der Invite enthalt <strong>Passwort-Reset</strong> + <strong>E-Mail-Verifizierung</strong>.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Alle Benutzer ({users.length})</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="button" onClick={load} disabled={loading} className="btn btn-secondary btn-sm">
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 'var(--space-6)', fontSize: '13px', color: 'var(--text-tertiary)' }}>Lade...</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th className="hide-mobile">UID</th>
                  <th>Rollen</th>
                  <th style={{ textAlign: 'right' }}>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => {
                  const uid = (u.uid as string) || u.id;
                  const roles = Array.isArray(u.roles) ? u.roles : [];
                  const email = u.email || '';
                  return (
                    <tr key={uid}>
                      <td>
                        <div className="user-cell">
                          <div
                            className="avatar"
                            style={{ background: AVATAR_COLORS[idx % AVATAR_COLORS.length] }}
                          >
                            {getInitials(email || uid)}
                          </div>
                          <div>
                            <div className="user-cell-name">{email || uid}</div>
                            <div className="user-cell-email">{uid}</div>
                          </div>
                        </div>
                      </td>
                      <td className="hide-mobile" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                        {uid}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {ROLE_OPTIONS.map((role) => (
                            <label key={role} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                              <input
                                type="checkbox"
                                checked={roles.includes(role)}
                                onChange={() => {
                                  const next = roles.includes(role)
                                    ? roles.filter((r) => r !== role)
                                    : [...roles, role];
                                  updateUserRoles(uid, next);
                                }}
                                style={{ accentColor: 'var(--avy-purple)' }}
                              />
                              <span className={`role-badge ${role}`}>{role}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="action-group" style={{ justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="action-btn"
                            title="Email kopieren"
                            onClick={() => {
                              navigator.clipboard?.writeText(String(email)).catch(() => {});
                            }}
                          >
                            <Copy size={14} />
                          </button>
                          <button type="button" className="action-btn" title="Bearbeiten">
                            <Pencil size={14} />
                          </button>
                          <button type="button" className="action-btn danger" title="Loeschen">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: 'var(--space-8)' }}>
                      Keine Users gefunden.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
};
