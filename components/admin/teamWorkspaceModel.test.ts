import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  filterTeam,
  matchesTeamFilter,
  performanceRows,
  sortPerformance,
  metricValue,
  hasActivity,
  CAPABILITIES,
  allowsCapability,
  compareCapabilities,
  initials,
} from "./teamWorkspaceModel.ts";
import type { AdminUserRecord, PerformanceRow } from "../../api/client";
const require = createRequire(import.meta.url);
const { defaultRoles } = require("../../backend/lib/access-profiles.js");
const roles = Object.entries(defaultRoles()).map(([id, role]) => ({
  id,
  ...(role as any),
}));
const users: AdminUserRecord[] = [
  {
    id: "h",
    firstName: "Hüseyin",
    lastName: "Işık",
    email: "hu@example.test",
    roles: ["employee"],
  },
  { id: "e", displayName: "Efe", roles: ["manager"] },
  { id: "p", displayName: "Partner", roles: ["partner"] },
  { id: "s", displayName: "Scanner", roles: ["employee"], disabled: true },
];
const row = (uid: string, count = 0): PerformanceRow => ({
  uid,
  name: uid,
  erfasst: 0,
  eingelagert: 0,
  kommissioniert: 0,
  verpackt: count,
  angereichert: 0,
});
test("team search handles Turkish names, email and compound filters without mutating records", () => {
  assert.equal(filterTeam(users, "huseyin isik")[0]?.id, "h");
  assert.equal(filterTeam(users, "hu@example")[0]?.id, "h");
  assert.equal(filterTeam(users, "", "employee", "operative").length, 1);
  assert.equal(filterTeam(users, "", "all", "reading")[0]?.id, "p");
  assert.equal(filterTeam(users, "", "all", "disabled")[0]?.id, "s");
  assert.equal(matchesTeamFilter(users[3], "operative"), false);
  assert.deepEqual(
    users.map((u) => u.id),
    ["h", "e", "p", "s"],
  );
  assert.equal(initials("Hüseyin Işık"), "HI");
});
test("performance preserves historical attribution and counts, enriches names and adds only enabled idle accounts", () => {
  const original = [row("h", 20), row("former-shared-account", 8), row("s", 2)];
  const joined = performanceRows(original, users);
  assert.equal(joined.find((r) => r.uid === "h")?.name, "Hüseyin Işık");
  assert.equal(
    joined.find((r) => r.uid === "former-shared-account")?.verpackt,
    8,
  );
  assert.equal(joined.find((r) => r.uid === "s")?.verpackt, 2);
  assert.equal(joined.find((r) => r.uid === "e")?.verpackt, 0);
  assert.equal(
    joined.reduce((sum, r) => sum + r.verpackt, 0),
    30,
  );
  assert.equal(original[0].name, "h");
  assert.equal(
    performanceRows([], users).some((r) => r.uid === "s"),
    false,
  );
});
test("performance sorting is stable by name on ties, reversible and non-mutating", () => {
  const rows = [row("C", 4), row("B", 12), row("A", 12)];
  assert.deepEqual(
    sortPerformance(rows, "verpackt").map((r) => r.uid),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    sortPerformance(rows, "verpackt", false).map((r) => r.uid),
    ["C", "A", "B"],
  );
  assert.deepEqual(
    sortPerformance(rows, "name", false).map((r) => r.uid),
    ["A", "B", "C"],
  );
  assert.equal(rows[0].uid, "C");
  assert.equal(hasActivity(row("idle")), false);
  assert.equal(hasActivity(row("active", 1)), true);
  for (const value of [-2, NaN, Infinity])
    assert.equal(metricValue(row("invalid", value), "verpackt"), 0);
});
test("role overview reflects production policy for pack weight and protected areas", () => {
  const employee = roles.find((r) => r.id === "employee");
  const manager = roles.find((r) => r.id === "manager");
  const partner = roles.find((r) => r.id === "partner");
  const admin = roles.find((r) => r.id === "admin");
  assert.equal(
    allowsCapability(
      employee,
      CAPABILITIES.find((c) => c.label === "Packen & Gewicht erfassen")!,
    ),
    true,
  );
  for (const capability of CAPABILITIES.filter(
    (c) => c.group === "Sensible Bereiche",
  )) {
    assert.equal(
      allowsCapability(employee, capability),
      false,
      capability.label,
    );
    assert.equal(
      allowsCapability(manager, capability),
      false,
      capability.label,
    );
    assert.equal(allowsCapability(admin, capability), true, capability.label);
  }
  assert.equal(
    allowsCapability(
      partner,
      CAPABILITIES.find(
        (c) => c.label === "Finanzberichte & Rechnungen lesen",
      )!,
    ),
    true,
  );
  assert.equal(
    allowsCapability(
      partner,
      CAPABILITIES.find((c) => c.label === "Finanzdaten & Rechnungen ändern")!,
    ),
    false,
  );
});
test("compound capability requires every permission and missing roles fail closed", () => {
  const capability = CAPABILITIES[0];
  assert.equal(
    allowsCapability(
      { id: "partial", permissions: { products: { read: true } } },
      capability,
    ),
    false,
  );
  assert.equal(allowsCapability(undefined, capability), false);
  assert.equal(
    allowsCapability(
      {
        id: "module",
        permissions: {
          products: { "*": true },
          orders: { "*": true },
          warehouse: { "*": true },
        },
      },
      capability,
    ),
    true,
  );
});
test("role comparison returns only actual differences and supports task search", () => {
  const diff = compareCapabilities(roles, ["employee", "manager"], true);
  assert.equal(
    diff.some((c) => c.label === "Packen & Gewicht erfassen"),
    false,
  );
  assert.equal(
    diff.some((c) => c.label === "Lieferadressen korrigieren"),
    true,
  );
  assert.equal(
    compareCapabilities(roles, ["employee", "employee"], true).length,
    0,
  );
  assert.equal(
    compareCapabilities(roles, ["employee", "manager"], false, "Finanz").length,
    2,
  );
});
