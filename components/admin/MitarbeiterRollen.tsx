import React from "react";
import { AdminUserManagement } from "./AdminUserManagement";
import { AdminRoleManagement } from "./AdminRoleManagement";
import { MitarbeiterLeistung } from "./MitarbeiterLeistung";
import { PageTitle } from "../ui/PageTitle";
import { TeamIcon } from "./TeamPrimitives";

type Tab = "users" | "leistung" | "roles";
const TABS = [
  { id: "users" as const, label: "Mitarbeiter", icon: "team" as const },
  { id: "leistung" as const, label: "Leistung", icon: "chart" as const },
  { id: "roles" as const, label: "Rollen & Rechte", icon: "shield" as const },
];
export const MitarbeiterRollen: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>("users");
  const [person, setPerson] = React.useState<string | null>(null);
  const [roleFilter, setRoleFilter] = React.useState("all");
  const [roleFilterVersion, setRoleFilterVersion] = React.useState(0);
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="mx-auto max-w-[1500px] space-y-6 pb-6">
      <PageTitle>Mitarbeiter &amp; Rollen</PageTitle>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border">
        <div
          role="tablist"
          aria-label="Teamverwaltung"
          className="flex min-w-0 max-w-full gap-1 overflow-x-auto"
        >
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              id={`team-tab-${item.id}`}
              aria-controls={`team-panel-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? TABS.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          TABS.length) %
                        TABS.length;
                setTab(TABS[next].id);
                refs.current[next]?.focus();
              }}
              className={`relative flex shrink-0 items-center gap-2 border-b-2 px-3 py-3.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-accent sm:px-5 ${tab === item.id ? "border-accent text-accent" : "border-transparent text-txt-muted hover:text-txt-primary"}`}
            >
              <TeamIcon
                kind={item.icon}
                className="hidden h-4 w-4 min-[400px]:block"
              />
              {item.label}
            </button>
          ))}
        </div>
        <span className="hidden items-center gap-1.5 pb-2 text-xs text-txt-muted lg:inline-flex">
          <TeamIcon kind="shield" className="h-3.5 w-3.5" />
          Teamverwaltung · Administrator
        </span>
      </div>
      {/* Keep filter/period state when changing tabs; data queries are shared. */}
      <div
        id="team-panel-users"
        role="tabpanel"
        aria-labelledby="team-tab-users"
        hidden={tab !== "users"}
      >
        <AdminUserManagement
          roleFilter={roleFilter}
          roleFilterVersion={roleFilterVersion}
          onClearRoleFilter={() => setRoleFilter("all")}
          onViewPerformance={(uid) => {
            setPerson(uid);
            setTab("leistung");
          }}
        />
      </div>
      <div
        id="team-panel-leistung"
        role="tabpanel"
        aria-labelledby="team-tab-leistung"
        hidden={tab !== "leistung"}
      >
        <MitarbeiterLeistung
          active={tab === "leistung"}
          selectedUid={person}
          onSelectUser={setPerson}
        />
      </div>
      <div
        id="team-panel-roles"
        role="tabpanel"
        aria-labelledby="team-tab-roles"
        hidden={tab !== "roles"}
      >
        <AdminRoleManagement
          active={tab === "roles"}
          onViewMembers={(role) => {
            setRoleFilter(role);
            setRoleFilterVersion((version) => version + 1);
            setTab("users");
          }}
        />
      </div>
    </div>
  );
};
