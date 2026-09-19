import React from "react";
import { adminListRoles, type AdminRoleRecord } from "../../api/client";
import { ROLE_CATALOG } from "./roleCatalog";

const capabilities = [
  ["Produkte, Bestellungen und Lager ansehen", "products", "read"],
  ["Produkte erfassen und pflegen", "products", "write"],
  ["Einlagern und Bestand buchen", "warehouse", "write"],
  ["Kommissionieren", "orders", "pick"],
  ["Packen und Gewicht erfassen", "orders", "pack"],
  ["Versenden und Labels drucken", "orders", "ship"],
  ["Lieferadresse korrigieren", "orders", "edit"],
  ["Lager und Versand konfigurieren", "warehouse", "configure"],
  ["Produkte löschen", "products", "delete"],
  ["Retouren annehmen", "returns", "process"],
  ["Geld erstatten", "returns", "refund"],
  ["Finanzberichte und Rechnungen lesen", "admin", "reports.read"],
  ["Rechnungen und Finanzdaten ändern", "invoices", "write"],
  ["Technische Diagnose ansehen", "system", "read"],
  ["Unternehmensdaten und Zugänge verwalten", "settings", "company.write"],
  ["Konten und Zugriffsprofile verwalten", "admin", "users.write"],
] as const;

export const AdminRoleManagement: React.FC = () => {
  const [roles, setRoles] = React.useState<AdminRoleRecord[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { let active = true; adminListRoles().then(r => { if (active) setRoles(r); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  return <div className="space-y-5">
    <div><h2 className="text-xl font-bold">Zugriffsprofile</h2><p className="mt-1 text-sm text-txt-secondary">Ein Konto, ein Profil. Der Administrator verwaltet die Zuordnung unter „Mitarbeiter“.</p></div>
    <div className="rounded-xl border border-accent/25 bg-accent-dim p-4 text-sm text-txt-primary">Vollzugriff ist dem Inhaber vorbehalten. Operative Arbeit benötigt kein Administratorprofil. Finanz- und Verwaltungsrechte sind davon getrennt.</div>
    {error ? <p role="alert" className="text-danger">{error}</p> : roles.length === 0 ? <p className="text-txt-muted">Profile werden geladen …</p> : <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{ROLE_CATALOG.map(role => <div key={role.id} className="rounded-xl border border-app-border bg-app-surface p-4"><h3 className="font-semibold">{role.name}</h3><p className="mt-2 text-sm text-txt-secondary">{role.description}</p></div>)}</div>
      <div className="overflow-x-auto rounded-xl border border-app-border bg-app-surface"><table className="w-full text-sm"><caption className="p-4 text-left font-semibold">Was jedes Profil darf</caption><thead><tr><th scope="col" className="p-3 text-left">Aufgabe</th>{ROLE_CATALOG.map(role => <th key={role.id} scope="col" className="min-w-28 p-3 text-center font-medium">{role.name}</th>)}</tr></thead><tbody>{capabilities.map(([label, mod, action]) => <tr key={label} className="border-t border-app-border"><th scope="row" className="p-3 text-left font-normal">{label}</th>{ROLE_CATALOG.map(role => { const p = roles.find(r => r.id === role.id)?.permissions; const allowed = p?.['*']?.['*'] === true || p?.[mod]?.[action] === true; return <td key={role.id} className={`p-3 text-center ${allowed ? 'text-success' : 'text-txt-muted'}`}><span aria-label={allowed ? 'Erlaubt' : 'Gesperrt'}>{allowed ? '✓' : '—'}</span></td>; })}</tr>)}</tbody></table></div>
    </>}
  </div>;
};
