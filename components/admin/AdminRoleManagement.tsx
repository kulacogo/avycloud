import React from "react";
import { adminListRoles, adminUpdateRole, type AdminRoleRecord } from "../../api/client";
import { PERMISSION_MODULES, roleDisplayName, isLegacyRole } from "./roleCatalog";

type PermissionMatrix = Record<string, Record<string, boolean>>;

const getPermission = (matrix: PermissionMatrix | undefined, moduleId: string, action: string) =>
  Boolean(matrix?.[moduleId]?.[action]);

const setPermission = (matrix: PermissionMatrix, moduleId: string, action: string, allowed: boolean) => {
  const next: PermissionMatrix = { ...(matrix || {}) };
  const mod = { ...(next[moduleId] || {}) };
  mod[action] = allowed;
  next[moduleId] = mod;
  return next;
};

const isFullAccess = (matrix: PermissionMatrix | undefined) => matrix?.["*"]?.["*"] === true;

// Preferred display order: the 7 job roles first, then anything else.
const ROLE_ORDER = ["betrachter", "lager-versand", "produktpflege", "einkauf-bestand", "buchhaltung", "leitung", "admin"];
const roleRank = (id: string) => {
  const i = ROLE_ORDER.indexOf(id);
  return i === -1 ? ROLE_ORDER.length + 1 : i;
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
      const sorted = [...list].sort((a, b) => roleRank(String(a.id)) - roleRank(String(b.id)));
      setRoles(sorted);
    } catch (e: any) {
      setError(e?.message || "Rollen konnten nicht geladen werden");
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
      setError(e?.message || "Speichern fehlgeschlagen");
    } finally {
      setSavingRoleId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Rollen & Rechte</h2>
          <p className="text-sm text-txt-muted">Was jede Rolle darf. Ein Mitarbeiter kann mehrere Rollen haben — die Rechte addieren sich.</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
        >
          Aktualisieren
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-txt-muted">Lade…</div>
      ) : (
        <div className="space-y-5">
          {roles.map((role) => {
            const matrix = (role.permissions || {}) as PermissionMatrix;
            const fullAccess = isFullAccess(matrix);
            return (
              <div key={role.id} className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">
                      {roleDisplayName(String(role.id))}
                      {isLegacyRole(String(role.id)) ? (
                        <span className="ml-2 text-xs text-warning">wird nicht mehr verwendet</span>
                      ) : null}
                    </h3>
                    <p className="text-xs text-txt-muted">Rollen-Kennung: {role.id}</p>
                  </div>
                  {!fullAccess && (
                    <button
                      type="button"
                      onClick={() => saveRole(role)}
                      disabled={savingRoleId === role.id}
                      className="rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
                    >
                      {savingRoleId === role.id ? "Speichere…" : "Speichern"}
                    </button>
                  )}
                </div>

                {fullAccess ? (
                  <p className="text-sm text-txt-secondary">Vollzugriff auf alles. Diese Rolle lässt sich nicht einschränken.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                    {PERMISSION_MODULES.map((mod) => (
                      <div key={mod.id} className="border-t border-white/5 pt-2">
                        <div className="text-sm font-medium text-txt-secondary mb-1.5">{mod.label}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {mod.actions.map((a) => (
                            <label key={a.action} className="flex items-center gap-2 text-sm text-txt-primary cursor-pointer">
                              <input
                                type="checkbox"
                                checked={getPermission(matrix, mod.id, a.action)}
                                onChange={(e) => updateLocalPermission(String(role.id), mod.id, a.action, e.target.checked)}
                              />
                              <span>{a.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {roles.length === 0 && <div className="text-sm text-txt-muted">Keine Rollen gefunden.</div>}
        </div>
      )}
    </div>
  );
};
