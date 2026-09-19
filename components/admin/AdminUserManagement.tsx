import React from "react";
import {
  adminInviteUser,
  adminSetUserRoles,
  adminSetUserProfile,
  adminDeleteUser,
  type AdminUserRecord,
} from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { Notice } from "../ui/Notice";
import { SearchIcon, RefreshIcon, PlusCircleIcon } from "../icons/Icons";
import { ROLE_CATALOG, roleDisplayName } from "./roleCatalog";
import { useTeamDirectory } from "./useTeamDirectory";
import {
  displayName,
  userId,
  profileId,
  filterTeam,
  matchesTeamFilter,
  type TeamFilter,
} from "./teamWorkspaceModel";
import {
  TeamAvatar,
  RoleBadge,
  TeamDialog,
  RolePicker,
  TeamEmpty,
  TeamError,
  TeamSkeleton,
  TeamIcon,
  fieldClass,
  primaryButton,
  secondaryButton,
} from "./TeamPrimitives";

type EditForm = {
  firstName: string;
  lastName: string;
  username: string;
  role: string;
};
const formFor = (user: AdminUserRecord): EditForm => ({
  firstName: user.firstName || "",
  lastName: user.lastName || "",
  username: user.username || "",
  role: profileId(user),
});
const FILTERS: { id: TeamFilter; label: string; detail: string }[] = [
  { id: "all", label: "Konten insgesamt", detail: "Dein gesamtes Team" },
  {
    id: "operative",
    label: "Operativ tätig",
    detail: "Admin, Manager & Mitarbeiter",
  },
  {
    id: "reading",
    label: "Mit Lesezugriff",
    detail: "Partner, Lesen & Entwicklung",
  },
  { id: "disabled", label: "Deaktiviert", detail: "Kein Zugang zur Anwendung" },
];

export const AdminUserManagement: React.FC<{
  roleFilter?: string;
  roleFilterVersion?: number;
  onClearRoleFilter?: () => void;
  onViewPerformance?: (uid: string) => void;
}> = ({
  roleFilter = "all",
  roleFilterVersion = 0,
  onClearRoleFilter,
  onViewPerformance,
}) => {
  const { user } = useAuth();
  const directory = useTeamDirectory();
  const users = directory.data || [];
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<TeamFilter>("all");
  const [role, setRole] = React.useState(roleFilter);
  React.useEffect(() => {
    setRole(roleFilter);
    if (roleFilter !== "all") {
      setFilter("all");
      setQuery("");
    }
  }, [roleFilter, roleFilterVersion]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<AdminUserRecord | "invite" | null>(
    null,
  );
  const [form, setForm] = React.useState<EditForm>({
    firstName: "",
    lastName: "",
    username: "",
    role: "employee",
  });
  const [email, setEmail] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [editorError, setEditorError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<AdminUserRecord | null>(null);
  const filtered = filterTeam(users, query, role, filter);
  const changed =
    editor &&
    editor !== "invite" &&
    JSON.stringify(form) !== JSON.stringify(formFor(editor));
  const openEditor = (target: AdminUserRecord | "invite") => {
    setEditorError(null);
    setEmail("");
    setEditor(target);
    setForm(
      target === "invite"
        ? { firstName: "", lastName: "", username: "", role: "employee" }
        : formFor(target),
    );
  };
  const resetFilters = () => {
    setQuery("");
    setFilter("all");
    setRole("all");
    onClearRoleFilter?.();
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    setEditorError(null);
    let nameSaved = false;
    try {
      if (editor === "invite") {
        await adminInviteUser(email.trim().toLowerCase(), [form.role]);
        setNotice(
          "Einladung versendet. Der Mitarbeiter kann jetzt sein persönliches Konto einrichten.",
        );
      } else {
        const before = formFor(editor);
        if (
          ["firstName", "lastName", "username"].some(
            (key) =>
              form[key as keyof EditForm] !== before[key as keyof EditForm],
          )
        ) {
          await adminSetUserProfile(userId(editor), {
            firstName: form.firstName,
            lastName: form.lastName,
            username: form.username,
          });
          nameSaved = true;
        }
        if (form.role !== before.role)
          await adminSetUserRoles(userId(editor), [form.role]);
        setNotice(`Änderungen für ${displayName(editor)} gespeichert.`);
      }
      setEditor(null);
      await directory.refetch();
    } catch (error: any) {
      setEditorError(
        `${nameSaved ? "Name gespeichert, Zugriffsprofil noch nicht geändert. " : ""}${error?.message || "Speichern fehlgeschlagen. Bitte erneut versuchen."}`,
      );
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!removing || saving) return;
    setSaving(true);
    setEditorError(null);
    try {
      await adminDeleteUser(userId(removing));
      setRemoving(null);
      setNotice("Konto gelöscht.");
      await directory.refetch();
    } catch (error: any) {
      setEditorError(error?.message || "Konto konnte nicht gelöscht werden.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Dein Team im Überblick
          </h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Persönliche Konten. Klare Aufgaben. Passender Zugriff.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => directory.refetch()}
            disabled={directory.isFetching}
            className={secondaryButton}
            aria-label="Team aktualisieren"
          >
            <RefreshIcon
              className={`h-4 w-4 ${directory.isFetching ? "motion-safe:animate-spin" : ""}`}
            />
          </button>
          <button
            type="button"
            className={primaryButton}
            onClick={() => openEditor("invite")}
          >
            <PlusCircleIcon className="h-4 w-4" />
            Mitarbeiter einladen
          </button>
        </div>
      </div>
      {notice && (
        <Notice
          tone="success"
          title={notice}
          onDismiss={() => setNotice(null)}
        />
      )}
      {directory.error && (
        <TeamError
          message={directory.error.message}
          onRetry={() => directory.refetch()}
        />
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setRole("all");
              setQuery("");
              onClearRoleFilter?.();
            }}
            className={`group rounded-2xl border p-4 text-left transition hover:border-accent ${filter === item.id ? "border-accent bg-accent-dim" : "border-app-border bg-app-surface"}`}
          >
            <span className="text-xs font-medium text-txt-secondary">
              {item.label}
            </span>
            <span className="my-2 block text-3xl font-semibold tracking-tight tabular-nums">
              {directory.isPending || directory.error
                ? "—"
                : users.filter((u) => matchesTeamFilter(u, item.id)).length}
            </span>
            <span className="text-xs text-txt-muted">{item.detail}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[180px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-txt-muted" />
          <input
            aria-label="Mitarbeiter suchen"
            placeholder="Name oder E-Mail suchen …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={`${fieldClass} pl-10`}
          />
        </label>
        <select
          aria-label="Nach Zugriffsprofil filtern"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className={`${fieldClass} sm:!w-56`}
        >
          <option value="all">Alle Zugriffsprofile</option>
          {ROLE_CATALOG.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {(query || role !== "all" || filter !== "all") && (
          <button
            type="button"
            onClick={resetFilters}
            className="text-sm text-accent hover:underline"
          >
            Filter zurücksetzen
          </button>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-txt-muted">
        <span aria-live="polite">
          {directory.isPending
            ? "Team wird geladen …"
            : directory.error && !directory.data
              ? "Konten nicht verfügbar"
              : `${filtered.length} von ${users.length} Konten`}
        </span>
        <span className="hidden sm:inline">
          Jeder Zugriff ist einem Konto zugeordnet
        </span>
      </div>
      {directory.isPending ? (
        <TeamSkeleton />
      ) : directory.error && !directory.data ? null : filtered.length === 0 ? (
        <TeamEmpty
          title={
            users.length ? "Keine passenden Konten" : "Hier beginnt dein Team"
          }
          action={
            users.length ? (
              <button
                type="button"
                className={secondaryButton}
                onClick={resetFilters}
              >
                Alle Konten anzeigen
              </button>
            ) : (
              <button
                type="button"
                className={primaryButton}
                onClick={() => openEditor("invite")}
              >
                Ersten Mitarbeiter einladen
              </button>
            )
          }
        >
          {users.length
            ? "Passe deine Suche oder die ausgewählten Filter an."
            : "Lade Mitarbeiter ein und gib jedem ein passendes Zugriffsprofil."}
        </TeamEmpty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((account) => {
            const id = userId(account),
              profile = profileId(account),
              name = displayName(account);
            return (
              <article
                key={id}
                className={`group flex min-w-0 flex-col rounded-2xl border border-app-border bg-app-surface p-5 transition hover:border-accent hover:shadow-app ${account.disabled ? "opacity-75" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <TeamAvatar name={name} role={profile} />
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] ${account.disabled ? "bg-app-elevated text-txt-muted" : "bg-success-dim text-success"}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {account.disabled ? "Deaktiviert" : "Zugang aktiv"}
                  </span>
                </div>
                <h3 className="mt-4 truncate font-semibold" title={name}>
                  {name}
                  {id === user?.uid && (
                    <span className="ml-2 text-xs font-normal text-txt-muted">
                      Du
                    </span>
                  )}
                </h3>
                <p
                  className="mt-1 truncate text-xs text-txt-muted"
                  title={account.email || ""}
                >
                  {account.email || "Keine E-Mail hinterlegt"}
                </p>
                <div className="mt-4">
                  <RoleBadge role={profile} />
                </div>
                <p className="mb-5 mt-2 line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-txt-secondary">
                  {account.disabled
                    ? "Dieses Konto kann AvyCloud nicht verwenden."
                    : ROLE_CATALOG.find((r) => r.id === profile)?.description ||
                      "Bitte ein Zugriffsprofil zuordnen."}
                </p>
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-app-border pt-4">
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
                    onClick={() => openEditor(account)}
                    aria-label={`Profil bearbeiten: ${name}`}
                  >
                    Profil bearbeiten
                    <TeamIcon kind="arrow" className="h-4 w-4" />
                  </button>
                  {onViewPerformance && (
                    <button
                      type="button"
                      onClick={() => onViewPerformance(id)}
                      className="rounded-lg p-2 text-txt-muted hover:bg-app-elevated hover:text-accent"
                      title="Leistung ansehen"
                      aria-label={`Leistung ansehen: ${name}`}
                    >
                      <TeamIcon kind="chart" className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <TeamDialog
        open={Boolean(editor)}
        title={
          editor === "invite"
            ? "Mitarbeiter einladen"
            : "Mitarbeiter bearbeiten"
        }
        busy={saving}
        onClose={() => setEditor(null)}
      >
        <form onSubmit={save} className="space-y-5 p-6">
          {editorError && <TeamError message={editorError} />}
          {editor === "invite" ? (
            <label className="block text-sm font-medium">
              E-Mail-Adresse
              <input
                autoFocus
                type="email"
                required
                maxLength={254}
                placeholder="name@trendocean.de"
                value={email}
                disabled={saving}
                onChange={(event) => setEmail(event.target.value)}
                className={`${fieldClass} mt-2`}
              />
              <span className="mt-2 block text-xs font-normal text-txt-muted">
                Die Einladung enthält Links zum Passwort-Setzen und zur
                E-Mail-Bestätigung.
              </span>
            </label>
          ) : (
            editor && (
              <>
                <div className="flex items-center gap-3">
                  <TeamAvatar
                    name={displayName(editor)}
                    role={profileId(editor)}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {displayName(editor)}
                    </p>
                    <p className="truncate text-xs text-txt-muted">
                      {editor.email}
                    </p>
                  </div>
                </div>
                {editor.disabled && (
                  <p className="rounded-xl bg-warning-dim p-3 text-sm text-warning">
                    Das Konto ist deaktiviert. Eine Profiländerung aktiviert es
                    nicht.
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["firstName", "Vorname"],
                      ["lastName", "Nachname"],
                      ["username", "Benutzername (optional)"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="text-sm font-medium">
                      {label}
                      <input
                        value={form[key]}
                        disabled={saving}
                        onChange={(event) =>
                          setForm((previous) => ({
                            ...previous,
                            [key]: event.target.value,
                          }))
                        }
                        className={`${fieldClass} mt-1.5`}
                      />
                    </label>
                  ))}
                </div>
              </>
            )
          )}
          <RolePicker
            value={form.role}
            owner={Boolean(
              editor && editor !== "invite" && profileId(editor) === "admin",
            )}
            disabled={saving}
            onChange={(value) =>
              setForm((previous) => ({ ...previous, role: value }))
            }
          />
          {editor && editor !== "invite" && profileId(editor) !== form.role && (
            <p className="rounded-xl bg-accent-dim p-3 text-sm">
              Profilwechsel:{" "}
              <strong>{roleDisplayName(profileId(editor))}</strong> →{" "}
              <strong>{roleDisplayName(form.role)}</strong>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border pt-5">
            {editor &&
            editor !== "invite" &&
            profileId(editor) !== "admin" &&
            userId(editor) !== user?.uid ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setRemoving(editor);
                  setEditor(null);
                  setEditorError(null);
                }}
                className="text-xs text-danger hover:underline"
              >
                Konto löschen
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className={secondaryButton}
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                className={primaryButton}
                disabled={
                  saving || (editor === "invite" ? !email.trim() : !changed)
                }
              >
                {saving
                  ? "Wird gespeichert …"
                  : editor === "invite"
                    ? "Einladung senden"
                    : "Änderungen speichern"}
              </button>
            </div>
          </div>
        </form>
      </TeamDialog>
      <TeamDialog
        open={Boolean(removing)}
        title="Konto wirklich löschen?"
        busy={saving}
        onClose={() => setRemoving(null)}
      >
        <div className="space-y-5 p-6">
          <p className="text-sm text-txt-secondary">
            Das Konto von{" "}
            <strong className="text-txt-primary">
              {removing && displayName(removing)}
            </strong>{" "}
            wird dauerhaft entfernt. Dieser Schritt kann nicht rückgängig
            gemacht werden.
          </p>
          {editorError && <TeamError message={editorError} />}
          <div className="flex justify-end gap-2">
            <button
              autoFocus
              type="button"
              className={secondaryButton}
              disabled={saving}
              onClick={() => setRemoving(null)}
            >
              Abbrechen
            </button>
            <button
              type="button"
              className="rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={saving}
              onClick={remove}
            >
              {saving ? "Wird gelöscht …" : "Endgültig löschen"}
            </button>
          </div>
        </div>
      </TeamDialog>
    </div>
  );
};
