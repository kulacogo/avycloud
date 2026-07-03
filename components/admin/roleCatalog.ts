// Shared, human-readable role + permission catalog for the "Mitarbeiter & Rollen"
// area. Keeps the UI in plain German and out of dev-jargon (module.action codes).
// The backend (lib/rbac.js) stays the source of truth for what each role grants;
// this only makes it understandable.

export type RoleInfo = { id: string; name: string; description: string };

// The 7 job-based roles (mirrors lib/rbac.js). Ordered from least to most powerful.
export const ROLE_CATALOG: RoleInfo[] = [
  { id: "betrachter", name: "Betrachter", description: "Darf alles ansehen, aber nichts ändern." },
  { id: "lager-versand", name: "Lager & Versand", description: "Kommissionieren, packen, versenden, Retouren annehmen." },
  { id: "produktpflege", name: "Produktpflege", description: "Produkte anlegen/bearbeiten, erfassen, Angebote pflegen." },
  { id: "einkauf-bestand", name: "Einkauf & Bestand", description: "Wareneingang buchen, Bestände korrigieren, Einkaufspreise." },
  { id: "buchhaltung", name: "Buchhaltung", description: "Rechnungen, Erstattungen freigeben, Finanzzahlen." },
  { id: "leitung", name: "Leitung", description: "Alles Operative inkl. Marktplätze & Firmendaten." },
  { id: "admin", name: "Administrator", description: "Vollzugriff inkl. Mitarbeiter & Rechte verwalten." },
];

// Legacy roles kept for backward-compatibility; shown only if a user still holds one.
const LEGACY_ROLE_NAMES: Record<string, string> = {
  manager: "Manager (veraltet)",
  operation: "Operation (veraltet)",
  catalog: "Catalog (veraltet)",
};

const ROLE_NAME_BY_ID: Record<string, string> = {
  ...Object.fromEntries(ROLE_CATALOG.map((r) => [r.id, r.name])),
  ...LEGACY_ROLE_NAMES,
};

export const roleDisplayName = (id: string): string => ROLE_NAME_BY_ID[id] || id;

export const isLegacyRole = (id: string): boolean => id in LEGACY_ROLE_NAMES;

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
    ],
  },
  {
    id: "orders",
    label: "Bestellungen",
    actions: [
      { action: "read", label: "Ansehen" },
      { action: "pick", label: "Kommissionieren" },
      { action: "pack", label: "Packen" },
      { action: "ship", label: "Versenden" },
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
