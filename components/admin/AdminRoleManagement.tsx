import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminListRoles, adminUpdateRole } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { SearchIcon } from "../icons/Icons";
import {
  ROLE_CATALOG,
  PERMISSION_MODULES,
  roleDisplayName,
} from "./roleCatalog";
import { useTeamDirectory } from "./useTeamDirectory";
import { profileId } from "./teamWorkspaceModel";
import {
  RoleBadge,
  TeamError,
  TeamSkeleton,
  fieldClass,
} from "./TeamPrimitives";
import {
  permissionEnabled,
  togglePermission,
  samePermissions,
  type PermissionMatrix,
} from "./rolePermissionEditor";
import type { AdminRoleRecord } from "../../api/client";

export const AdminRoleManagement: React.FC<{
  active?: boolean;
  onViewMembers?: (role: string) => void;
}> = ({ active = true, onViewMembers }) => {
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  const client = useQueryClient();
  const directory = useTeamDirectory();
  const queryKey = ["team-access-profiles", user?.uid];
  const result = useQuery({
    queryKey,
    queryFn: adminListRoles,
    enabled: active && Boolean(user?.uid),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [selected, setSelected] = React.useState("manager");
  const [query, setQuery] = React.useState("");
  const [drafts, setDrafts] = React.useState<
    Record<string, { permissions: PermissionMatrix; revision: number }>
  >({});
  const role = result.data?.find((item) => item.id === selected);
  const draft = drafts[selected];
  const permissions = draft?.permissions || role?.permissions || {};
  const editable =
    role?.editable === true && hasPermission("admin", "roles.write");
  const dirty = Boolean(draft);
  const clearDraft = (id: string) =>
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  const mutation = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { permissions: PermissionMatrix; revision: number };
    }) => adminUpdateRole(id, patch),
    onSuccess: (saved, { id }) => {
      client.setQueryData<AdminRoleRecord[]>(queryKey, (previous) =>
        previous?.map((item) =>
          item.id === id ? { ...item, ...saved } : item,
        ),
      );
      clearDraft(id);
      toast.success(`${roleDisplayName(id)}: Rechte gespeichert.`);
    },
  });
  React.useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);
  const count = (id: string) =>
    (directory.data || []).filter((account) => profileId(account) === id)
      .length;
  const change = (module: string, action: string, enabled: boolean) => {
    const next = togglePermission(permissions, module, action, enabled);
    mutation.reset();
    if (samePermissions(next, role?.permissions || {})) clearDraft(selected);
    else
      setDrafts((previous) => ({
        ...previous,
        [selected]: {
          permissions: next,
          revision: draft?.revision ?? role?.revision ?? 0,
        },
      }));
  };
  const modules = PERMISSION_MODULES.map((module) => ({
    ...module,
    actions: module.actions.filter((action) =>
      `${module.label} ${action.label}`
        .toLocaleLowerCase("de")
        .includes(query.trim().toLocaleLowerCase("de")),
    ),
  })).filter((module) => module.actions.length);

  return (
    <div className="space-y-4">
      {result.error && (
        <TeamError
          message={result.error.message}
          onRetry={() => result.refetch()}
        />
      )}
      {directory.error && (
        <TeamError
          message="Konten konnten nicht geladen werden."
          onRetry={() => directory.refetch()}
        />
      )}
      {result.isPending ? (
        <TeamSkeleton />
      ) : (
        result.data && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {ROLE_CATALOG.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected === item.id}
                  disabled={mutation.isPending}
                  onClick={() => {
                    setSelected(item.id);
                    mutation.reset();
                  }}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 text-left transition hover:border-accent ${selected === item.id ? "border-accent bg-accent-dim" : "border-app-border bg-app-surface"}`}
                >
                  <RoleBadge role={item.id} />
                  <span className="text-xs text-txt-muted">
                    {drafts[item.id]
                      ? "Ungespeichert"
                      : directory.isPending || directory.error
                        ? "—"
                        : `${count(item.id)} ${count(item.id) === 1 ? "Konto" : "Konten"}`}
                  </span>
                </button>
              ))}
            </div>
            <section className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-semibold">{roleDisplayName(selected)}</h2>
                  {selected === "admin" && (
                    <span className="text-xs text-txt-muted">
                      Vollzugriff · Nur Inhaber
                    </span>
                  )}
                  {onViewMembers && (
                    <button
                      type="button"
                      className="text-xs text-accent hover:underline"
                      onClick={() => onViewMembers(selected)}
                    >
                      Konten ansehen →
                    </button>
                  )}
                </div>
                <label className="relative w-full sm:w-64">
                  <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-txt-muted" />
                  <input
                    aria-label="Berechtigungen suchen"
                    placeholder="Berechtigung suchen …"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className={`${fieldClass} pl-10`}
                  />
                </label>
              </div>
              <div className="divide-y divide-app-border">
                {modules.map((module) => (
                  <div
                    key={`${module.id}-${module.label}`}
                    className="grid gap-3 px-5 py-3.5 lg:grid-cols-[190px_1fr]"
                  >
                    <h3 className="text-sm font-medium">{module.label}</h3>
                    <div className="flex flex-wrap gap-x-5 gap-y-3">
                      {module.actions.map((action) => (
                        <label
                          key={action.action}
                          className={`inline-flex items-center gap-2 text-sm ${editable ? "cursor-pointer" : "text-txt-secondary"}`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`${module.label}: ${action.label}`}
                            checked={permissionEnabled(
                              permissions,
                              module.id,
                              action.action,
                            )}
                            disabled={!editable || mutation.isPending}
                            onChange={(event) =>
                              change(
                                module.id,
                                action.action,
                                event.target.checked,
                              )
                            }
                            className="h-4 w-4 rounded accent-accent disabled:opacity-60"
                          />
                          {action.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {!modules.length && (
                  <p className="p-5 text-sm text-txt-muted">
                    Keine passende Berechtigung.
                  </p>
                )}
                <div className="flex justify-between gap-3 px-5 py-3 text-xs text-txt-muted">
                  <span>Konten & Rechteverwaltung</span>
                  <span>Nur Inhaber</span>
                </div>
              </div>
            </section>
            {dirty && (
              <div className="sticky bottom-3 z-10 rounded-xl border border-accent bg-app-surface p-3 shadow-lg">
                {mutation.error && (
                  <div
                    role="alert"
                    className="mb-3 flex flex-wrap items-center gap-3 text-sm text-danger"
                  >
                    {mutation.error.message}
                    <button
                      type="button"
                      className="underline"
                      onClick={async () => {
                        const refreshed = await result.refetch();
                        if (!refreshed.error) {
                          clearDraft(selected);
                          mutation.reset();
                        }
                      }}
                    >
                      Neu laden
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm">
                    {roleDisplayName(selected)} · Ungespeicherte Änderungen
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={mutation.isPending}
                      className="rounded-lg border border-app-border px-4 py-2 text-sm"
                      onClick={() => {
                        clearDraft(selected);
                        mutation.reset();
                      }}
                    >
                      Verwerfen
                    </button>
                    <button
                      type="button"
                      disabled={mutation.isPending}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      onClick={() =>
                        draft && mutation.mutate({ id: selected, patch: draft })
                      }
                    >
                      {mutation.isPending ? "Speichert …" : "Rechte speichern"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
};
