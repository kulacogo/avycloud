import React from "react";
import {
  adminInviteUser,
  adminListUsers,
  adminSetUserRoles,
  adminSetUserProfile,
  adminDeleteUser,
  type AdminUserRecord,
} from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { Notice } from "../ui/Notice";
import { ROLE_CATALOG, roleDisplayName, userDisplayName, isLegacyRole } from "./roleCatalog";

const normalizeEmail = (value: string) => value.trim().toLowerCase();

type EditForm = { firstName: string; lastName: string; username: string; roles: string[] };

export const AdminUserManagement: React.FC = () => {
  const { user } = useAuth();
  const currentUid = user?.uid;

  const [users, setUsers] = React.useState<AdminUserRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ tone: "success" | "info" | "warning" | "error"; title: string } | null>(null);

  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRoles, setInviteRoles] = React.useState<string[]>([]);
  const [inviting, setInviting] = React.useState(false);

  const [editingUid, setEditingUid] = React.useState<string | null>(null);
  const [editForm, setEditForm] = React.useState<EditForm>({ firstName: "", lastName: "", username: "", roles: [] });
  const [saving, setSaving] = React.useState(false);
  const [busyUid, setBusyUid] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setUsers(await adminListUsers(500));
    } catch (e: any) {
      setError(e?.message || "Mitarbeiter konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const invite = async () => {
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      await adminInviteUser(normalizeEmail(inviteEmail), inviteRoles);
      setInviteEmail("");
      setInviteRoles([]);
      await load();
      setNotice({ tone: "success", title: "Einladung wurde versendet" });
    } catch (e: any) {
      setError(e?.message || "Einladung fehlgeschlagen");
    } finally {
      setInviting(false);
    }
  };

  const startEdit = (u: AdminUserRecord) => {
    setEditingUid((u.uid as string) || u.id);
    setEditForm({
      firstName: u.firstName || "",
      lastName: u.lastName || "",
      username: u.username || "",
      roles: Array.isArray(u.roles) ? [...u.roles] : [],
    });
  };

  const saveEdit = async (u: AdminUserRecord) => {
    const uid = (u.uid as string) || u.id;
    const originalRoles = Array.isArray(u.roles) ? u.roles : [];
    // Self-lockout guard: warn if you remove your own admin rights.
    const removingOwnAdmin =
      uid === currentUid && originalRoles.includes("admin") && !editForm.roles.includes("admin");
    if (removingOwnAdmin && !window.confirm("Du entfernst dir selbst die Administrator-Rechte. Wirklich fortfahren?")) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminSetUserProfile(uid, {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        username: editForm.username,
      });
      await adminSetUserRoles(uid, editForm.roles);
      setEditingUid(null);
      await load();
      setNotice({ tone: "success", title: "Gespeichert" });
    } catch (e: any) {
      setError(e?.message || "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (u: AdminUserRecord) => {
    const uid = (u.uid as string) || u.id;
    const label = userDisplayName(u);
    if (!window.confirm(`Konto „${label}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;
    setBusyUid(uid);
    setError(null);
    try {
      await adminDeleteUser(uid);
      await load();
      setNotice({ tone: "success", title: "Konto gelöscht" });
    } catch (e: any) {
      setError(e?.message || "Löschen fehlgeschlagen");
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">Mitarbeiter</h2>
        <p className="text-sm text-txt-muted">Mitarbeiter einladen, Namen und Rollen pflegen, Konten entfernen.</p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}
      {notice ? <Notice tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)} /> : null}

      {/* Einladen */}
      <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
        <h3 className="font-semibold">Mitarbeiter einladen</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="name@trendocean.de"
            className="md:col-span-2 rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={inviting || !inviteEmail.trim()}
            onClick={invite}
            className="rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2.5 font-semibold text-txt-primary"
          >
            {inviting ? "Sende…" : "Einladung senden"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {ROLE_CATALOG.map((role) => (
            <label
              key={role.id}
              title={role.description}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                inviteRoles.includes(role.id)
                  ? "border-accent bg-accent/10 text-txt-primary"
                  : "border-app-border text-txt-secondary hover:bg-white/5"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={inviteRoles.includes(role.id)}
                onChange={() => setInviteRoles((prev) => toggle(prev, role.id))}
              />
              <span>{role.name}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-txt-muted">Die Einladung enthält einen Link zum Passwort-Setzen und zur E-Mail-Bestätigung.</p>
      </div>

      {/* Liste */}
      <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Team ({users.length})</h3>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-txt-primary"
          >
            Aktualisieren
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-txt-muted">Lade…</div>
        ) : users.length === 0 ? (
          <div className="text-sm text-txt-muted">Noch keine Mitarbeiter.</div>
        ) : (
          <div className="space-y-2">
            {users.map((u) => {
              const uid = (u.uid as string) || u.id;
              const roles = Array.isArray(u.roles) ? u.roles : [];
              const isEditing = editingUid === uid;
              return (
                <div key={uid} className="rounded-xl border border-app-border bg-app-bg/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-txt-primary truncate">
                        {userDisplayName(u)}
                        {uid === currentUid ? <span className="ml-2 text-xs text-accent">(Du)</span> : null}
                      </div>
                      <div className="text-xs text-txt-muted truncate">{u.email || uid}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isEditing && (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(u)}
                            className="rounded-lg bg-app-elevated border border-white/[0.08] hover:bg-white/10 px-3 py-1.5 text-xs font-semibold text-txt-primary"
                          >
                            Bearbeiten
                          </button>
                          <button
                            type="button"
                            disabled={busyUid === uid || uid === currentUid}
                            title={uid === currentUid ? "Du kannst dein eigenes Konto nicht löschen" : "Konto löschen"}
                            onClick={() => remove(u)}
                            className="rounded-lg border border-danger/30 text-danger hover:bg-danger-dim disabled:opacity-40 px-3 py-1.5 text-xs font-semibold"
                          >
                            {busyUid === uid ? "…" : "Löschen"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Rollen-Chips (Anzeige) */}
                  {!isEditing && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {roles.length === 0 ? (
                        <span className="text-xs text-warning">Keine Rolle — kann nicht arbeiten</span>
                      ) : (
                        roles.map((r) => (
                          <span
                            key={r}
                            className={`rounded-md px-2 py-0.5 text-xs ${
                              isLegacyRole(r) ? "bg-warning-dim text-warning" : "bg-app-elevated text-txt-secondary"
                            }`}
                          >
                            {roleDisplayName(r)}
                          </span>
                        ))
                      )}
                    </div>
                  )}

                  {/* Editor */}
                  {isEditing && (
                    <div className="mt-3 space-y-4 border-t border-white/5 pt-3">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          value={editForm.firstName}
                          onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                          placeholder="Vorname"
                          className="rounded-lg bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary outline-none focus:border-accent"
                        />
                        <input
                          value={editForm.lastName}
                          onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                          placeholder="Nachname"
                          className="rounded-lg bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary outline-none focus:border-accent"
                        />
                        <input
                          value={editForm.username}
                          onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                          placeholder="Benutzername (optional)"
                          className="rounded-lg bg-app-bg/60 border border-app-border px-3 py-2 text-sm text-txt-primary outline-none focus:border-accent"
                        />
                      </div>
                      <div>
                        <div className="text-xs text-txt-muted mb-1.5">Rollen — die Rechte mehrerer Rollen addieren sich.</div>
                        <div className="flex flex-wrap gap-2">
                          {ROLE_CATALOG.map((role) => (
                            <label
                              key={role.id}
                              title={role.description}
                              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                                editForm.roles.includes(role.id)
                                  ? "border-accent bg-accent/10 text-txt-primary"
                                  : "border-app-border text-txt-secondary hover:bg-white/5"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="sr-only"
                                checked={editForm.roles.includes(role.id)}
                                onChange={() => setEditForm((f) => ({ ...f, roles: toggle(f.roles, role.id) }))}
                              />
                              <span>{role.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => saveEdit(u)}
                          className="rounded-lg bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
                        >
                          {saving ? "Speichere…" : "Speichern"}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => setEditingUid(null)}
                          className="rounded-lg bg-app-elevated border border-white/[0.08] hover:bg-white/10 px-4 py-2 text-sm font-semibold text-txt-primary"
                        >
                          Abbrechen
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
