import React from 'react';
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

export const AdminRoleManagement: React.FC = () => {
  const [roles, setRoles] = React.useState<AdminRoleRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [savingRoleId, setSavingRoleId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Admin: Roles & Rechte</h2>
          <p className="text-sm text-slate-400">Rechte pro Role definieren (Backend ist Source of Truth).</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400">Lade…</div>
      ) : (
        <div className="space-y-5">
          {roles.map((role) => {
            const matrix = (role.permissions || {}) as PermissionMatrix;
            return (
              <div key={role.id} className="rounded-2xl border border-white/10 bg-slate-800/60 p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">{role.id}</h3>
                    <p className="text-xs text-slate-400">{role.name || ''}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => saveRole(role)}
                    disabled={savingRoleId === role.id}
                    className="rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white"
                  >
                    {savingRoleId === role.id ? 'Speichere…' : 'Speichern'}
                  </button>
                </div>

                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="text-left py-2 pr-3">Modul</th>
                        <th className="text-left py-2 pr-3">Rechte</th>
                      </tr>
                    </thead>
                    <tbody>
                      {MODULES.map((mod) => (
                        <tr key={mod.id} className="border-t border-white/5">
                          <td className="py-2 pr-3 text-slate-200 whitespace-nowrap">{mod.label}</td>
                          <td className="py-2 pr-3">
                            <div className="flex flex-wrap gap-3">
                              {mod.actions.map((action) => (
                                <label key={action} className="flex items-center gap-2 text-xs text-slate-100">
                                  <input
                                    type="checkbox"
                                    checked={getPermission(matrix, mod.id, action)}
                                    onChange={(e) => updateLocalPermission(role.id, mod.id, action, e.target.checked)}
                                  />
                                  <span>
                                    {mod.id}.{action}
                                  </span>
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
            );
          })}
          {roles.length === 0 && <div className="text-sm text-slate-400">Keine Rollen gefunden.</div>}
        </div>
      )}
    </div>
  );
};

