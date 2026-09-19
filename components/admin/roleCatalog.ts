// Shared, human-readable role + permission catalog for the "Mitarbeiter & Rollen"
// area. Keeps the UI in plain German and out of dev-jargon (module.action codes).
// The backend (lib/rbac.js) stays the source of truth for what each role grants;
// this only makes it understandable.

export type RoleInfo = { id: string; name: string; description: string };

// Display labels only. The server owns the permission matrix.
export const ROLE_CATALOG: RoleInfo[] = [
  { id: "admin", name: "Administrator", description: "Inhaber · vollständiger Zugriff einschließlich Finanzen und Verwaltung." },
  { id: "manager", name: "Manager", description: "Alle operativen Abläufe, Auftragskorrekturen, Regeln und Lagerkonfiguration." },
  { id: "employee", name: "Mitarbeiter", description: "Erfassen, Produkte pflegen, einlagern, kommissionieren, wiegen, packen, versenden und drucken." },
  { id: "partner", name: "Gesellschafter / Partner", description: "Operative Daten und Finanzberichte lesen. Keine Änderungen." },
  { id: "viewer", name: "Nur Lesen", description: "Operative Daten ansehen. Keine Änderungen oder Finanzberichte." },
  { id: "developer", name: "Entwickler · Lesen", description: "Operative Daten und technische Diagnose. Keine Änderungen, Finanzen, Zugangsdaten oder Personalverwaltung." },
];
export const roleDisplayName = (id: string): string => ROLE_CATALOG.find(role => role.id === id)?.name || "Nicht zugeordnet";
export const isLegacyRole = (id: string): boolean => !ROLE_CATALOG.some(role => role.id === id);

// Plain-German labels for the permission matrix, grouped by module.
export type PermModule = { id: string; label: string; actions: Array<{ action: string; label: string }> };

export const PERMISSION_MODULES: PermModule[] = [
  { id: "dashboard", label: "Dashboard", actions: [{ action: "read", label: "Ansehen" }] },
  {
    id: "products",
    label: "Produkte",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Bearbeiten" },
      { action: "delete", label: "Löschen" },
    ],
  },
  {
    id: "categories",
    label: "Kategorien",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Bearbeiten" },
    ],
  },
  { id: "inventories", label: "Bestände", actions: [{ action: "read", label: "Ansehen" }] },
  {
    id: "warehouse",
    label: "Lager",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Buchen (Ein-/Auslagern)" },
      { action: "configure", label: "Lager konfigurieren" },
    ],
  },
  {
    id: "orders",
    label: "Bestellungen",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "pick", label: "Kommissionieren" },
      { action: "pack", label: "Packen & Gewicht erfassen" },
      { action: "ship", label: "Versenden & Labels drucken" },
      { action: "edit", label: "Bearbeiten" },
    ],
  },
  {
    id: "invoices",
    label: "Rechnungen",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Erstellen" },
    ],
  },
  {
    id: "returns",
    label: "Retouren",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "process", label: "Bearbeiten" },
      { action: "refund", label: "Geld erstatten" },
    ],
  },
  { id: "identify", label: "Produkt erfassen", actions: [{ action: "run", label: "Ausführen" }] },
  {
    id: "ai",
    label: "KI-Assistent",
    actions: [
      { action: "chat", label: "Chat" },
      { action: "improve", label: "Optimierung" },
    ],
  },
  {
    id: "integrations",
    label: "Integrationen",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Verbinden" },
    ],
  },
  {
    id: "settings",
    label: "Firmendaten",
    actions: [
      { action: "company.read", label: "Ansehen" },
      { action: "company.write", label: "Bearbeiten" },
    ],
  },
  {
    id: "rules",
    label: "Automatik-Regeln",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "write", label: "Bearbeiten" },
    ],
  },
  { id: "jobs", label: "Hintergrund-Jobs", actions: [{ action: "read", label: "Ansehen" }] },
  {
    id: "admin",
    label: "Administration",
    actions: [
      { action: "users.read", label: "Mitarbeiter ansehen" },
      { action: "users.write", label: "Mitarbeiter verwalten" },
      { action: "roles.read", label: "Rollen ansehen" },
      { action: "roles.write", label: "Rollen verwalten" },
      { action: "groups.read", label: "Gruppen ansehen" },
      { action: "groups.write", label: "Gruppen verwalten" },
      { action: "reports.read", label: "Finanzberichte ansehen" },
      { action: "llm.read", label: "KI-Einstellungen ansehen" },
      { action: "llm.write", label: "KI-Einstellungen bearbeiten" },
    ],
  },
];

export const userDisplayName = (u: {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string | null;
}): string => {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return u.displayName || full || u.username || u.email || "—";
};
