import type {
  AdminUserRecord,
  AdminRoleRecord,
  PerformanceRow,
} from "../../api/client";

export type TeamFilter = "all" | "operative" | "reading" | "disabled";
export const userId = (user: AdminUserRecord) => user.uid || user.id;
export const profileId = (user: AdminUserRecord) =>
  user.roles?.[0] || "unassigned";
export const displayName = (user: AdminUserRecord) =>
  user.displayName ||
  [user.firstName, user.lastName].filter(Boolean).join(" ") ||
  user.username ||
  user.email ||
  "Ohne Namen";
export const initials = (name: string) =>
  name
    .split("@")[0]
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
export const normalizeSearch = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase();

export function matchesTeamFilter(user: AdminUserRecord, filter: TeamFilter) {
  if (filter === "all") return true;
  if (filter === "disabled") return Boolean(user.disabled);
  if (user.disabled) return false;
  return (
    filter === "operative"
      ? ["admin", "manager", "employee"]
      : ["partner", "viewer", "developer"]
  ).includes(profileId(user));
}
export function filterTeam(
  users: AdminUserRecord[],
  query = "",
  role = "all",
  filter: TeamFilter = "all",
) {
  const needle = normalizeSearch(query.trim());
  return users
    .filter(
      (user) =>
        matchesTeamFilter(user, filter) &&
        (role === "all" || profileId(user) === role) &&
        normalizeSearch(
          [displayName(user), user.email, user.username]
            .filter(Boolean)
            .join(" "),
        ).includes(needle),
    )
    .sort(
      (a, b) =>
        Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) ||
        displayName(a).localeCompare(displayName(b), "de"),
    );
}

export const METRICS = [
  {
    key: "erfasst",
    label: "Erfasst",
    unit: "Produkte",
    detail: "Eindeutige Produkte je Konto",
    color: "var(--accent)",
  },
  {
    key: "eingelagert",
    label: "Eingelagert",
    unit: "Buchungen",
    detail: "Gebuchte Wareneingänge",
    color: "var(--info)",
  },
  {
    key: "kommissioniert",
    label: "Kommissioniert",
    unit: "Vorgänge",
    detail: "Abgeschlossene Pick-Vorgänge",
    color: "var(--warning)",
  },
  {
    key: "verpackt",
    label: "Verpackt",
    unit: "Vorgänge",
    detail: "Abgeschlossene Pack-Vorgänge",
    color: "var(--success)",
  },
  {
    key: "angereichert",
    label: "Produktpflege",
    unit: "Produkte",
    detail: "Eindeutige bearbeitete Produkte je Konto",
    color: "var(--text-secondary)",
  },
] as const;
export type MetricKey = (typeof METRICS)[number]["key"];
export const metricValue = (row: PerformanceRow, key: MetricKey) =>
  Number.isFinite(Number(row[key])) ? Math.max(0, Number(row[key])) : 0;
export const hasActivity = (row: PerformanceRow) =>
  METRICS.some((m) => metricValue(row, m.key) > 0);
export function performanceRows(
  rows: PerformanceRow[],
  users: AdminUserRecord[],
) {
  const directory = new Map(users.map((user) => [userId(user), user]));
  const result = rows.map((row) => {
    const user = directory.get(row.uid);
    directory.delete(row.uid);
    return {
      ...row,
      name: user ? displayName(user) : row.name,
      email: user?.email || row.email,
    };
  });
  for (const [uid, user] of directory) {
    if (!user.disabled)
      result.push({
        uid,
        name: displayName(user),
        email: user.email,
        erfasst: 0,
        angereichert: 0,
        eingelagert: 0,
        kommissioniert: 0,
        verpackt: 0,
      });
  }
  return result;
}
export function sortPerformance(
  rows: PerformanceRow[],
  key: MetricKey | "name",
  descending = true,
) {
  return [...rows].sort((a, b) =>
    key === "name"
      ? (descending ? -1 : 1) * a.name.localeCompare(b.name, "de")
      : (descending ? -1 : 1) * (metricValue(a, key) - metricValue(b, key)) ||
        a.name.localeCompare(b.name, "de"),
  );
}
export const PERMISSION_GROUPS = [
  "Tagesgeschäft",
  "Steuerung",
  "Sensible Bereiche",
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
export const CAPABILITIES: Array<{
  label: string;
  group: PermissionGroup;
  checks: [string, string][];
}> = [
  {
    label: "Produkte, Bestellungen & Lager ansehen",
    group: "Tagesgeschäft",
    checks: [
      ["products", "read"],
      ["orders", "read"],
      ["warehouse", "read"],
    ],
  },
  {
    label: "Produkte erfassen & pflegen",
    group: "Tagesgeschäft",
    checks: [
      ["identify", "run"],
      ["products", "write"],
    ],
  },
  {
    label: "Einlagern & Bestand buchen",
    group: "Tagesgeschäft",
    checks: [["warehouse", "write"]],
  },
  {
    label: "Kommissionieren",
    group: "Tagesgeschäft",
    checks: [["orders", "pick"]],
  },
  {
    label: "Packen & Gewicht erfassen",
    group: "Tagesgeschäft",
    checks: [["orders", "pack"]],
  },
  {
    label: "Versenden & Labels drucken",
    group: "Tagesgeschäft",
    checks: [["orders", "ship"]],
  },
  {
    label: "Retouren annehmen",
    group: "Tagesgeschäft",
    checks: [["returns", "process"]],
  },
  {
    label: "Lieferadressen korrigieren",
    group: "Steuerung",
    checks: [["orders", "edit"]],
  },
  {
    label: "Lager & Versand konfigurieren",
    group: "Steuerung",
    checks: [
      ["warehouse", "configure"],
      ["orders", "write"],
    ],
  },
  {
    label: "Operative Regeln verwalten",
    group: "Steuerung",
    checks: [["rules", "write"]],
  },
  {
    label: "Produkte löschen",
    group: "Steuerung",
    checks: [["products", "delete"]],
  },
  {
    label: "Technische Diagnose ansehen",
    group: "Steuerung",
    checks: [["system", "read"]],
  },
  {
    label: "Finanzberichte & Rechnungen lesen",
    group: "Sensible Bereiche",
    checks: [
      ["admin", "reports.read"],
      ["invoices", "read"],
    ],
  },
  {
    label: "Finanzdaten & Rechnungen ändern",
    group: "Sensible Bereiche",
    checks: [
      ["admin", "reports.write"],
      ["invoices", "write"],
    ],
  },
  {
    label: "Geld erstatten",
    group: "Sensible Bereiche",
    checks: [["returns", "refund"]],
  },
  {
    label: "Unternehmensdaten & Zugänge verwalten",
    group: "Sensible Bereiche",
    checks: [
      ["settings", "company.write"],
      ["integrations", "write"],
    ],
  },
  {
    label: "Konten & Zugriffsprofile verwalten",
    group: "Sensible Bereiche",
    checks: [["admin", "users.write"]],
  },
];
export function allowsCapability(
  role: AdminRoleRecord | undefined,
  capability: (typeof CAPABILITIES)[number],
) {
  const p = role?.permissions;
  return capability.checks.every(
    ([module, action]) =>
      p?.["*"]?.["*"] === true ||
      p?.[module]?.["*"] === true ||
      p?.[module]?.[action] === true,
  );
}
export function compareCapabilities(
  roles: AdminRoleRecord[],
  ids: string[],
  differencesOnly: boolean,
  query = "",
) {
  return CAPABILITIES.filter(
    (capability) =>
      normalizeSearch(capability.label).includes(normalizeSearch(query)) &&
      (!differencesOnly ||
        new Set(
          ids.map((id) =>
            allowsCapability(
              roles.find((role) => role.id === id),
              capability,
            ),
          ),
        ).size > 1),
  );
}
