import React from "react";
import { createPortal } from "react-dom";
import { ROLE_CATALOG, roleDisplayName } from "./roleCatalog";
import { initials } from "./teamWorkspaceModel";

export const fieldClass =
  "w-full min-w-0 rounded-xl border border-app-border bg-app-bg px-3 py-2.5 text-sm text-txt-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent-dim";
export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-app-border px-3 py-2 text-sm font-medium text-txt-primary transition hover:bg-app-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const tones: Record<string, string> = {
  admin: "bg-warning-dim text-warning",
  manager: "bg-accent-dim text-accent",
  employee: "bg-success-dim text-success",
  partner: "bg-info-dim text-info",
  developer: "bg-app-elevated text-txt-primary",
  viewer: "bg-app-elevated text-txt-secondary",
};
export function TeamAvatar({
  name,
  role = "viewer",
  small = false,
}: {
  name: string;
  role?: string;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-2xl font-semibold ${small ? "h-9 w-9 text-xs" : "h-12 w-12 text-base"} ${tones[role] || tones.viewer}`}
    >
      {initials(name)}
    </span>
  );
}
export function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-medium ${tones[role] || tones.viewer}`}
    >
      {roleDisplayName(role)}
    </span>
  );
}
export function TeamIcon({
  kind,
  className = "h-5 w-5",
}: {
  kind: "team" | "chart" | "shield" | "arrow" | "check" | "close";
  className?: string;
}) {
  const paths = {
    team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87",
    chart: "M4 19V9M10 19V5M16 19v-7M22 19H2",
    shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    check: "m5 12 4 4 10-10",
    close: "m6 6 12 12M6 18 18 6",
  };
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
      {kind === "team" && <circle cx="9" cy="7" r="4" />}
    </svg>
  );
}
export function TeamEmpty({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-app-border px-5 py-12 text-center">
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-app-elevated text-txt-muted">
        <TeamIcon kind="team" />
      </span>
      <h3 className="font-semibold text-txt-primary">{title}</h3>
      <div className="mx-auto mt-2 max-w-md text-sm text-txt-secondary">
        {children}
      </div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function TeamError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger bg-danger-dim p-4 text-sm text-danger"
    >
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold underline"
        >
          Erneut versuchen
        </button>
      )}
    </div>
  );
}
export function TeamSkeleton() {
  return (
    <div
      role="status"
      aria-label="Team wird geladen"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-56 motion-safe:animate-pulse rounded-2xl border border-app-border bg-app-surface p-5"
        >
          <div className="h-12 w-12 rounded-2xl bg-app-elevated" />
          <div className="mt-5 h-3 w-3/4 rounded bg-app-elevated" />
          <div className="mt-3 h-3 w-1/2 rounded bg-app-elevated" />
        </div>
      ))}
    </div>
  );
}
export function RolePicker({
  value,
  onChange,
  owner = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  owner?: boolean;
  disabled?: boolean;
}) {
  const name = React.useId();
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-3 text-sm font-semibold">Zugriffsprofil</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {ROLE_CATALOG.filter((role) =>
          owner ? role.id === "admin" : role.id !== "admin",
        ).map((role) => (
          <label
            key={role.id}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition hover:bg-app-elevated ${value === role.id ? "border-accent bg-accent-dim" : "border-app-border"}`}
          >
            <input
              type="radio"
              name={name}
              checked={value === role.id}
              disabled={owner}
              onChange={() => onChange(role.id)}
              className="mt-1 accent-accent"
            />
            <span>
              <span className="block text-sm font-semibold">{role.name}</span>
              <span className="mt-1 block text-xs leading-relaxed text-txt-secondary">
                {role.description}
              </span>
            </span>
          </label>
        ))}
      </div>
      {owner && (
        <p className="text-xs text-txt-muted">
          Das Administratorprofil ist deinem Inhaberkonto fest zugeordnet.
        </p>
      )}
    </fieldset>
  );
}
// Native modal supplies focus containment, Escape and focus restoration. Portal
// avoids clipping inside the workspace; edits never leave the page underneath.
export function TeamDialog({
  open,
  title,
  children,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const id = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-app-border bg-app-surface p-0 text-txt-primary shadow-2xl backdrop:bg-black/60"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-app-border bg-app-surface px-6 py-4">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          aria-label="Schließen"
          className="rounded-lg p-2 text-txt-muted hover:bg-app-elevated"
        >
          <TeamIcon kind="close" />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
