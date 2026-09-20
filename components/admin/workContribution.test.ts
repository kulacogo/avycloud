import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contributionPoints,
  buildContributions,
  CONTRIBUTION_WEIGHTS,
} from "./workContribution.ts";
import type { PerformanceRow, AdminUserRecord } from "../../api/client";
const row = (
  uid: string,
  changes: Partial<PerformanceRow> = {},
): PerformanceRow => ({
  uid,
  name: uid,
  erfasst: 0,
  eingelagert: 0,
  kommissioniert: 0,
  verpackt: 0,
  angereichert: 0,
  productCareEdited: 0,
  ...changes,
});
const users: AdminUserRecord[] = [
  { id: "u1", roles: ["employee"] },
  { id: "u2", roles: ["manager"] },
  { id: "shared", disabled: true, roles: ["viewer"] },
];
test("Gesamtbeitrag berücksichtigt alle Tätigkeiten und nicht nur Verpacken", () => {
  for (const [key, weight] of Object.entries(CONTRIBUTION_WEIGHTS)) {
    assert.equal(
      contributionPoints(
        row("u1", {
          [key]: 3,
          ...(key === "angereichert" ? { productCareEdited: 3 } : {}),
        }),
      ),
      3 * weight,
    );
  }
  assert.equal(
    contributionPoints(row("u1", { erfasst: 2, verpackt: 1 })),
    2 * CONTRIBUTION_WEIGHTS.erfasst + CONTRIBUTION_WEIGHTS.verpackt,
  );
});
test("mehrfaches Speichern wird nicht erneut bewertet: es gelten die deduplizierten API-Zahlen", () => {
  assert.equal(
    contributionPoints(row("u1", { angereichert: 1, productCareEdited: 1 })),
    CONTRIBUTION_WEIGHTS.angereichert,
  );
  for (const value of [-1, NaN, Infinity])
    assert.equal(contributionPoints(row("u1", { verpackt: value })), 0);
});
test("Teamanteile beziehen sich auf den vollständigen bewertbaren Datenbestand", () => {
  const scores = buildContributions(
    [row("u1", { verpackt: 3 }), row("u2", { verpackt: 1 })],
    users,
    true,
  );
  assert.equal(scores[0].share, 75);
  assert.equal(scores[1].share, 25);
  assert.equal(scores.filter((r) => r.name === "u1")[0].share, 75);
});
test("historische und deaktivierte Konten bekommen keine persönliche Bewertung und verwässern den Vergleich nicht", () => {
  const scores = buildContributions(
    [
      row("u1", { verpackt: 1 }),
      row("shared", { verpackt: 1000 }),
      row("unknown", { verpackt: 1000 }),
    ],
    users,
    true,
  );
  assert.equal(scores.find((r) => r.uid === "u1")?.share, 100);
  assert.equal(scores.find((r) => r.uid === "shared")?.points, null);
  assert.equal(scores.find((r) => r.uid === "unknown")?.points, null);
});
test("fehlende oder unvollständige Daten erzeugen keine Scheinscores", () => {
  for (const complete of [false, undefined]) {
    const scores = buildContributions(
      [row("u1", { verpackt: 10 })],
      users,
      complete,
    );
    assert.equal(scores[0].points, null);
    assert.equal(scores[0].share, null);
    assert.equal(scores[0].status, "incomplete");
  }
});
test("Nullzeilen erhalten keine negative Leistungsnote", () => {
  const scores = buildContributions([row("u1")], users, true);
  assert.equal(scores[0].status, "no_activity");
  assert.equal(scores[0].share, null);
});
test("aufwendige Produktpflege wird zusätzlich zum Fotografieren und Erfassen bewertet", () => {
  assert.equal(
    contributionPoints(
      row("u1", {
        erfasst: 2,
        angereichert: 3,
        productCareEdited: 3,
        productCareOverlap: 2,
      }),
    ),
    2 * CONTRIBUTION_WEIGHTS.erfasst + 3 * CONTRIBUTION_WEIGHTS.angereichert,
  );
});
test("vom Betreiber beschriebene Reihenfolge bleibt bei gleichen Mengen erhalten", () => {
  const care = contributionPoints(
    row("u1", { angereichert: 1, productCareEdited: 1 }),
  );
  const capture = contributionPoints(row("u1", { erfasst: 1 }));
  const pack = contributionPoints(row("u1", { verpackt: 1 }));
  const pick = contributionPoints(row("u1", { kommissioniert: 1 }));
  assert.ok(care > capture && capture > pack && pack > pick);
});
test("Speicherungen ohne belegte Datenarbeit erhalten keine Pflegepunkte", () => {
  assert.equal(contributionPoints(row("u1", { angereichert: 99 })), 0);
  assert.equal(
    contributionPoints(row("u1", { angereichert: 2, productCareEdited: 100 })),
    2 * CONTRIBUTION_WEIGHTS.angereichert,
  );
  const [entry] = buildContributions(
    [row("u1", { angereichert: 3 })],
    users,
    true,
  );
  assert.equal(entry.status, "unverified");
  assert.equal(entry.share, null);
});
