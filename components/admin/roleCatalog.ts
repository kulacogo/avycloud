// Shared, human-readable role + permission catalog for the "Mitarbeiter & Rollen"
// area. Keeps the UI in plain German and out of dev-jargon (module.action codes).
// The backend (lib/rbac.js) stays the source of truth for what each role grants;
// this only makes it understandable.

export type RoleInfo = { id: string; name: string; description: string };

// Display labels only. The server owns the permission matrix.
export const ROLE_CATALOG: RoleInfo[] = [
  {
    id: "admin",
    name: "Administrator",
    description:
      "Inhaber · vollständiger Zugriff einschließlich Finanzen und Verwaltung.",
  },
  {
    id: "manager",
    name: "Manager",
    description:
      "Standard: Operative Abläufe, Rechnungen, Auftragskorrekturen, Regeln und Lagerkonfiguration.",
  },
  {
    id: "employee",
    name: "Mitarbeiter",
    description:
      "Standard: Erfassen, Produkte pflegen, einlagern, kommissionieren, wiegen, packen, versenden und drucken.",
  },
  {
    id: "partner",
    name: "Gesellschafter / Partner",
    description:
      "Standard: Operative Daten und Finanzberichte lesen. Keine Änderungen.",
  },
  {
    id: "viewer",
    name: "Nur Lesen",
    description:
      "Standard: Operative Daten ansehen. Keine Änderungen oder Finanzberichte.",
  },
  {
    id: "developer",
    name: "Entwickler · Lesen",
    description:
      "Standard: Operative Daten und technische Diagnose. Keine Änderungen, Finanzen, Zugangsdaten oder Personalverwaltung.",
  },
];
export const roleDisplayName = (id: string): string =>
  ROLE_CATALOG.find((role) => role.id === id)?.name || "Nicht zugeordnet";
export const isLegacyRole = (id: string): boolean =>
  !ROLE_CATALOG.some((role) => role.id === id);

// Plain-German labels for the permission matrix, grouped by module.
export type PermModule = {
  id: string;
  label: string;
  actions: Array<{ action: string; label: string; requires: string[] }>;
};

// Kept in parity with the server allowlist by rolePermissionEditor.test.ts.
export const PERMISSION_MODULES: PermModule[] = [
  {
    "id": "dashboard",
    "label": "Dashboard",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      }
    ]
  },
  {
    "id": "products",
    "label": "Produkte",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Bearbeiten",
        "requires": [
          "products.read"
        ]
      },
      {
        "action": "delete",
        "label": "Löschen",
        "requires": [
          "products.read"
        ]
      }
    ]
  },
  {
    "id": "identify",
    "label": "Erfassung",
    "actions": [
      {
        "action": "run",
        "label": "Produkte erfassen",
        "requires": [
          "products.read",
          "products.write",
          "jobs.read"
        ]
      }
    ]
  },
  {
    "id": "categories",
    "label": "Kategorien",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Bearbeiten",
        "requires": [
          "categories.read"
        ]
      }
    ]
  },
  {
    "id": "inventories",
    "label": "Bestände",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      }
    ]
  },
  {
    "id": "warehouse",
    "label": "Lager",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Ein- & auslagern",
        "requires": [
          "warehouse.read"
        ]
      },
      {
        "action": "configure",
        "label": "Konfigurieren",
        "requires": [
          "warehouse.read"
        ]
      },
      {
        "action": "settings.read",
        "label": "Einstellungen ansehen",
        "requires": [
          "warehouse.read"
        ]
      }
    ]
  },
  {
    "id": "orders",
    "label": "Bestellungen",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "pick",
        "label": "Picken",
        "requires": [
          "orders.read",
          "products.read",
          "warehouse.read",
          "warehouse.write"
        ]
      },
      {
        "action": "pack",
        "label": "Packen & wiegen",
        "requires": [
          "orders.read",
          "products.read",
          "warehouse.read"
        ]
      },
      {
        "action": "ship",
        "label": "Versenden & drucken",
        "requires": [
          "orders.read",
          "products.read",
          "warehouse.read"
        ]
      },
      {
        "action": "edit",
        "label": "Bearbeiten",
        "requires": [
          "orders.read"
        ]
      },
      {
        "action": "settings.read",
        "label": "Einstellungen ansehen",
        "requires": [
          "orders.read"
        ]
      },
      {
        "action": "write",
        "label": "Einstellungen bearbeiten",
        "requires": [
          "orders.read"
        ]
      }
    ]
  },
  {
    "id": "invoices",
    "label": "Rechnungen",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen & herunterladen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Erstellen & korrigieren",
        "requires": [
          "invoices.read",
          "orders.read"
        ]
      }
    ]
  },
  {
    "id": "returns",
    "label": "Retouren",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "process",
        "label": "Bearbeiten",
        "requires": [
          "returns.read"
        ]
      },
      {
        "action": "refund",
        "label": "Geld erstatten",
        "requires": [
          "returns.read"
        ]
      }
    ]
  },
  {
    "id": "admin",
    "label": "Finanzen",
    "actions": [
      {
        "action": "reports.read",
        "label": "Finanzen ansehen",
        "requires": []
      },
      {
        "action": "reports.write",
        "label": "Finanzdaten bearbeiten",
        "requires": [
          "admin.reports.read"
        ]
      }
    ]
  },
  {
    "id": "admin",
    "label": "KI-Einstellungen",
    "actions": [
      {
        "action": "llm.read",
        "label": "KI-Einstellungen ansehen",
        "requires": []
      },
      {
        "action": "llm.write",
        "label": "KI-Einstellungen bearbeiten",
        "requires": [
          "admin.llm.read"
        ]
      }
    ]
  },
  {
    "id": "settings",
    "label": "Unternehmensdaten",
    "actions": [
      {
        "action": "company.read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "company.write",
        "label": "Bearbeiten",
        "requires": [
          "settings.company.read"
        ]
      }
    ]
  },
  {
    "id": "rules",
    "label": "Automatik-Regeln",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Bearbeiten",
        "requires": [
          "rules.read"
        ]
      }
    ]
  },
  {
    "id": "ai",
    "label": "KI-Assistent",
    "actions": [
      {
        "action": "chat",
        "label": "Chat",
        "requires": [
          "products.read",
          "products.write"
        ]
      },
      {
        "action": "improve",
        "label": "Optimieren",
        "requires": [
          "products.read",
          "products.write"
        ]
      }
    ]
  },
  {
    "id": "integrations",
    "label": "Marktplatz-Anbindungen",
    "actions": [
      {
        "action": "status",
        "label": "Status ansehen",
        "requires": []
      },
      {
        "action": "read",
        "label": "Konfiguration ansehen",
        "requires": []
      },
      {
        "action": "write",
        "label": "Verbinden & konfigurieren",
        "requires": [
          "integrations.read"
        ]
      }
    ]
  },
  {
    "id": "system",
    "label": "Systemdiagnose",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      }
    ]
  },
  {
    "id": "jobs",
    "label": "Hintergrundaufträge",
    "actions": [
      {
        "action": "read",
        "label": "Ansehen",
        "requires": []
      }
    ]
  }
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
