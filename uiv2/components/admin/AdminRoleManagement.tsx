import React from 'react';
import { Star, CheckSquare, Warehouse, Eye, RefreshCw, Pencil, Save } from 'lucide-react';
import { adminListRoles, adminUpdateRole, type AdminRoleRecord } from '../../api/client';

type PermissionMatrix = Record<string, Record<string, boolean>>;

const MODULES: Array<{ id: string; label: string; actions: string[] }> = [
  {
    id: 'admin',
    label: 'Admin',
    actions: [
      'users.read',
      'users.write',
      'roles.read',
      'roles.write',
      'groups.read',
      'groups.write',
      'llm.read',
      'llm.write',
      'reports.read',
      'reports.generate',
    ],
  },
  { id: 'dashboard', label: 'Dashboard', actions: ['read'] },
  { id: 'products', label: 'Products', actions: ['read', 'write', 'delete'] },
  { id: 'categories', label: 'Categories', actions: ['read', 'write'] },
  { id: 'inventories', label: 'Inventories', actions: ['read'] },
  { id: 'warehouse', label: 'Warehouse', actions: ['read', 'write'] },
  { id: 'orders', label: 'Orders', actions: ['read', 'pick', 'pack'] },
  { id: 'baselinker', label: 'BaseLinker', actions: ['read', 'sync'] },
  { id: 'identify', label: 'Identify', actions: ['run'] },
  { id: 'jobs', label: 'Jobs', actions: ['read'] },
  { id: 'ai', label: 'AI', actions: ['chat', 'improve'] },
];

const getPermission = (matrix: PermissionMatrix | undefined, moduleId: string, action: string) =>
  Boolean(matrix?.[moduleId]?.[action]);

const setPermission = (matrix: PermissionMatrix, moduleId: string, action: string, allowed: boolean) => {
  const next: PermissionMatrix = { ...(matrix || {}) };
  const mod = { ...(next[moduleId] || {}) };
  mod[action] = allowed;
  next[moduleId] = mod;
  return next;
};

const countPermissions = (matrix: PermissionMatrix | undefined): number => {
  if (!matrix) return 0;
  let count = 0;
  for (const mod of Object.values(matrix)) {
    for (const v of Object.values(mod)) {
      if (v) count++;
    }
  }
  return count;
};

const ROLE_ICONS: Record<string, { icon: React.ReactNode; bg: string }> = {
  admin: { icon: <Star size={20} strokeWidth={1.5} style={{ color: 'var(--avy-purple)' }} />, bg: 'var(--avy-purple-glow)' },
  manager: { icon: <CheckSquare size={20} strokeWidth={1.5} style={{ color: 'var(--info)' }} />, bg: 'var(--info-bg)' },
  operation: { icon: <Warehouse size={20} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />, bg: 'var(--surface-secondary)' },
  catalog: { icon: <Eye size={20} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />, bg: 'var(--surface-secondary)' },
};

export const AdminRoleManagement: React.FC = () => {
  const [roles, setRoles] = React.useState<AdminRoleRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [savingRoleId, setSavingRoleId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedRoleId, setExpandedRoleId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const list = await adminListRoles();
      // prefer stable order
      const sorted = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      setRoles(sorted);
    } catch (e: any) {
      setError(e?.message || 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const updateLocalPermission = (roleId: string, moduleId: string, action: string, allowed: boolean) => {
    setRoles((prev) =>
      prev.map((r) => {
        if (r.id !== roleId) return r;
        const current = (r.permissions || {}) as PermissionMatrix;
        return { ...r, permissions: setPermission(current, moduleId, action, allowed) };
      })
    );
  };

  const saveRole = async (role: AdminRoleRecord) => {
    setSavingRoleId(role.id);
    setError(null);
    try {
      await adminUpdateRole(role.id, { permissions: role.permissions || {} });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to save role');
    } finally {
      setSavingRoleId(null);
    }
  };

  return (
    <>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-5)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-5)' }}>
        <button type="button" onClick={load} disabled={loading} className="btn btn-secondary btn-sm">
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Lade...</div>
      ) : (
        <div className="role-grid">
          {roles.map((role) => {
            const matrix = (role.permissions || {}) as PermissionMatrix;
            const permCount = countPermissions(matrix);
            const iconConfig = ROLE_ICONS[role.id] || ROLE_ICONS.catalog;
            const isExpanded = expandedRoleId === role.id;

            return (
              <div key={role.id} className="role-card">
                <div className="role-card-header">
                  <div className="role-card-icon" style={{ background: iconConfig.bg }}>
                    {iconConfig.icon}
                  </div>
                </div>
                <div className="role-card-name">{role.name || role.id}</div>
                <div className="role-card-desc">{role.id}</div>
                <div className="role-card-meta">
                  <div className="role-card-stat">
                    <div className="role-card-stat-value">{permCount}</div>
                    <div className="role-card-stat-label">Berechtigungen</div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="role-card-permissions">
                    <div style={{ overflowX: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Modul</th>
                            <th>Rechte</th>
                          </tr>
                        </thead>
                        <tbody>
                          {MODULES.map((mod) => (
                            <tr key={mod.id}>
                              <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{mod.label}</td>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                  {mod.actions.map((action) => (
                                    <label key={action} className="toggle-row" style={{ fontSize: '12px' }}>
                                      <input
                                        type="checkbox"
                                        checked={getPermission(matrix, mod.id, action)}
                                        onChange={(e) => updateLocalPermission(role.id, mod.id, action, e.target.checked)}
                                      />
                                      <span>{mod.id}.{action}</span>
                                    </label>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="role-card-footer">
                  {isExpanded && (
                    <button
                      type="button"
                      onClick={() => saveRole(role)}
                      disabled={savingRoleId === role.id}
                      className="btn btn-primary btn-sm"
                      style={{ marginRight: '8px' }}
                    >
                      <Save size={12} />
                      {savingRoleId === role.id ? 'Speichere...' : 'Speichern'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setExpandedRoleId(isExpanded ? null : role.id)}
                  >
                    <Pencil size={12} />
                    {isExpanded ? 'Schliessen' : 'Bearbeiten'}
                  </button>
                </div>
              </div>
            );
          })}
          {roles.length === 0 && (
            <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Rollen gefunden.</div>
          )}
        </div>
      )}
    </>
  );
};
