import React from "react";
import { AdminUserManagement } from "./AdminUserManagement";
import { AdminGroupManagement } from "./AdminGroupManagement";
import { AdminRoleManagement } from "./AdminRoleManagement";
import { MitarbeiterLeistung } from "./MitarbeiterLeistung";
import { PageHeader } from "../ui/PageHeader";

type Tab = "users" | "groups" | "roles" | "leistung";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "users", label: "Mitarbeiter" },
  { id: "leistung", label: "Leistung" },
  { id: "groups", label: "Gruppen" },
  { id: "roles", label: "Rollen & Rechte" },
];

export const MitarbeiterRollen: React.FC = () => {
  const [tab, setTab] = React.useState<Tab>("users");

  return (
    <div className="space-y-5">
      <PageHeader title="Mitarbeiter & Rollen" />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t.id ? "bg-accent text-txt-primary" : "bg-app-surface text-txt-secondary hover:bg-white/10"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "users" ? (
        <AdminUserManagement />
      ) : tab === "leistung" ? (
        <MitarbeiterLeistung />
      ) : tab === "groups" ? (
        <AdminGroupManagement />
      ) : (
        <AdminRoleManagement />
      )}
    </div>
  );
};
