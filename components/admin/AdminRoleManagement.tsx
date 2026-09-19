import React from "react";
import { useQuery } from "@tanstack/react-query";
import { adminListRoles } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { SearchIcon } from "../icons/Icons";
import { ROLE_CATALOG, roleDisplayName } from "./roleCatalog";
import { useTeamDirectory } from "./useTeamDirectory";
import {
  profileId,
  displayName,
  userId,
  PERMISSION_GROUPS,
  allowsCapability,
  compareCapabilities,
} from "./teamWorkspaceModel";
import {
  TeamAvatar,
  RoleBadge,
  TeamIcon,
  TeamError,
  TeamSkeleton,
  TeamEmpty,
  fieldClass,
} from "./TeamPrimitives";

export const AdminRoleManagement: React.FC<{
  active?: boolean;
  onViewMembers?: (role: string) => void;
}> = ({ active = true, onViewMembers }) => {
  const { user } = useAuth();
  const directory = useTeamDirectory();
  const result = useQuery({
    queryKey: ["team-access-profiles", user?.uid],
    queryFn: adminListRoles,
    enabled: active && Boolean(user?.uid),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [selected, setSelected] = React.useState("employee");
  const [comparison, setComparison] = React.useState("manager");
  const [differences, setDifferences] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const ids = [
    selected,
    ...(comparison && comparison !== selected ? [comparison] : []),
  ];
  const capabilities = compareCapabilities(
    result.data || [],
    ids,
    differences && ids.length > 1,
    query,
  );
  const profile = ROLE_CATALOG.find((role) => role.id === selected)!;
  const members = (directory.data || []).filter(
    (account) => profileId(account) === selected,
  );
  const memberCount = (role: string) =>
    (directory.data || []).filter((account) => profileId(account) === role)
      .length;
  const pick = (id: string) => {
    if (id === comparison) setComparison(selected);
    setSelected(id);
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Zugriff mit klaren Grenzen
          </h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Profil auswählen, Aufgaben prüfen und Unterschiede vergleichen.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface px-3 py-2 text-xs text-txt-secondary">
          <TeamIcon kind="shield" className="h-4 w-4 text-accent" />
          Ein Konto · Ein Profil
        </span>
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-warning/25 bg-warning-dim p-4">
        <TeamIcon
          kind="shield"
          className="mt-0.5 h-5 w-5 shrink-0 text-warning"
        />
        <p className="text-sm leading-relaxed text-txt-secondary">
          <strong className="text-txt-primary">
            Vollzugriff bleibt beim Inhaber.
          </strong>{" "}
          Mitarbeiter können wiegen, packen und versenden. Finanzen,
          Unternehmensdaten und Rechteverwaltung sind separat geschützt.
        </p>
      </div>
      {result.error && (
        <TeamError
          message={result.error.message}
          onRetry={() => result.refetch()}
        />
      )}
      {directory.error && (
        <TeamError
          message="Die Zuordnung der Konten konnte nicht geladen werden."
          onRetry={() => directory.refetch()}
        />
      )}
      {result.isPending ? (
        <TeamSkeleton />
      ) : (
        result.data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {ROLE_CATALOG.map((role) => (
                <button
                  type="button"
                  key={role.id}
                  aria-pressed={selected === role.id}
                  aria-label={`Profil ansehen: ${role.name}`}
                  onClick={() => pick(role.id)}
                  className={`flex flex-col rounded-2xl border p-4 text-left transition hover:border-accent ${selected === role.id ? "border-accent bg-accent-dim" : "border-app-border bg-app-surface"}`}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <RoleBadge role={role.id} />
                    <span className="text-xs text-txt-muted">
                      {directory.isPending || directory.error
                        ? "—"
                        : memberCount(role.id)}{" "}
                      {memberCount(role.id) === 1 ? "Konto" : "Konten"}
                    </span>
                  </span>
                  <span className="mt-3 flex-1 text-xs leading-relaxed text-txt-secondary">
                    {role.description}
                  </span>
                  <span
                    className={`mt-3 inline-flex items-center gap-1.5 text-xs font-medium ${selected === role.id ? "text-accent" : "text-txt-muted"}`}
                  >
                    {selected === role.id ? "Ausgewählt" : "Profil ansehen"}
                    <TeamIcon
                      kind={selected === role.id ? "check" : "arrow"}
                      className="h-3.5 w-3.5"
                    />
                  </span>
                </button>
              ))}
            </div>
            <section className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border p-5">
                <div>
                  <h3 className="font-semibold">{profile.name} im Detail</h3>
                  <p className="mt-1 text-xs text-txt-muted">
                    {members.length
                      ? `${members.length} ${members.length === 1 ? "zugeordnetes Konto" : "zugeordnete Konten"}${members.some((account) => account.disabled) ? " · einschließlich deaktivierter Konten" : ""}`
                      : directory.isPending || directory.error
                        ? "Kontozuordnung nicht verfügbar"
                        : "Noch keinem Konto zugeordnet"}
                  </p>
                </div>
                {members.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex -space-x-1.5">
                      {members.slice(0, 4).map((account) => (
                        <span
                          key={userId(account)}
                          title={`${displayName(account)}${account.disabled ? " (deaktiviert)" : ""}`}
                          className="rounded-2xl ring-2 ring-app-surface"
                        >
                          <TeamAvatar
                            name={displayName(account)}
                            role={selected}
                            small
                          />
                        </span>
                      ))}
                    </div>
                    {onViewMembers && (
                      <button
                        type="button"
                        onClick={() => onViewMembers(selected)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                      >
                        Konten ansehen
                        <TeamIcon kind="arrow" className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-3 p-5">
                <label className="min-w-[190px] flex-1 text-xs text-txt-secondary">
                  Vergleichen mit
                  <select
                    aria-label="Vergleichsprofil"
                    value={comparison}
                    onChange={(event) => setComparison(event.target.value)}
                    className={`${fieldClass} mt-1.5`}
                  >
                    <option value="">Ohne Vergleich</option>
                    {ROLE_CATALOG.filter((role) => role.id !== selected).map(
                      (role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="relative min-w-[190px] flex-1">
                  <SearchIcon className="absolute bottom-3 left-3 h-4 w-4 text-txt-muted" />
                  <input
                    aria-label="Berechtigungen suchen"
                    placeholder="Aufgabe suchen …"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className={`${fieldClass} pl-10`}
                  />
                </label>
                <label
                  className={`flex min-h-10 items-center gap-2 text-xs ${ids.length < 2 ? "text-txt-muted" : "text-txt-secondary"}`}
                >
                  <input
                    type="checkbox"
                    checked={differences}
                    disabled={ids.length < 2}
                    onChange={(event) => setDifferences(event.target.checked)}
                    className="accent-accent"
                  />
                  Nur Unterschiede
                </label>
              </div>
              {capabilities.length === 0 ? (
                <div className="px-5 pb-5">
                  <TeamEmpty title="Keine passenden Berechtigungen">
                    {query
                      ? "Versuche einen anderen Suchbegriff."
                      : "Für die gezeigten Aufgaben haben diese Profile die gleichen Rechte."}
                  </TeamEmpty>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Berechtigungen von{" "}
                      {ids.map(roleDisplayName).join(" und ")}
                    </caption>
                    <thead>
                      <tr className="bg-app-bg">
                        <th
                          scope="col"
                          className="px-5 py-3 text-left text-xs font-medium text-txt-muted"
                        >
                          Aufgabe
                        </th>
                        {ids.map((id) => (
                          <th
                            key={id}
                            scope="col"
                            className="w-36 px-3 py-3 text-center text-xs font-semibold"
                          >
                            {roleDisplayName(id)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    {PERMISSION_GROUPS.map((group) => {
                      const items = capabilities.filter(
                        (item) => item.group === group,
                      );
                      return (
                        items.length > 0 && (
                          <tbody key={group}>
                            <tr>
                              <th
                                scope="rowgroup"
                                colSpan={ids.length + 1}
                                className="border-t border-app-border bg-app-elevated px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-txt-secondary"
                              >
                                {group}
                              </th>
                            </tr>
                            {items.map((item) => (
                              <tr
                                key={item.label}
                                className="border-t border-app-border"
                              >
                                <th
                                  scope="row"
                                  className="px-5 py-3 text-left text-xs font-normal sm:text-sm"
                                >
                                  {item.label}
                                </th>
                                {ids.map((id) => {
                                  const allowed = allowsCapability(
                                    result.data.find((role) => role.id === id),
                                    item,
                                  );
                                  return (
                                    <td
                                      key={id}
                                      className="px-3 py-3 text-center"
                                    >
                                      <span
                                        className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs ${allowed ? "bg-success-dim text-success" : "text-txt-muted"}`}
                                      >
                                        <TeamIcon
                                          kind={allowed ? "check" : "close"}
                                          className="h-3.5 w-3.5"
                                        />
                                        <span className="hidden sm:inline">
                                          {allowed ? "Erlaubt" : "Gesperrt"}
                                        </span>
                                        <span className="sr-only sm:hidden">
                                          {allowed ? "Erlaubt" : "Gesperrt"}
                                        </span>
                                      </span>
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        )
                      );
                    })}
                  </table>
                </div>
              )}
              <div className="border-t border-app-border p-4 text-xs leading-relaxed text-txt-muted">
                Die Übersicht zeigt die hinterlegten Zugriffsprofile.
                Zuordnungen änderst du im Mitarbeiterprofil. Bei deaktivierten
                Konten bleibt der Zugang unabhängig vom Profil gesperrt.
              </div>
            </section>
          </>
        )
      )}
    </div>
  );
};
