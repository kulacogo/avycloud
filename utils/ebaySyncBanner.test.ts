import { describe, test } from "node:test";
import assert from "node:assert";
import { describeEbayListingSync } from "./ebaySyncBanner.ts";
import type { EbayListingSyncHealth } from "../api/client";

/**
 * Vorfall 2026-10-08: Das rote Banner bot bei leerem eBay-Tageskontingent
 * „eBay neu verbinden" an. Der Fehlertyp entscheidet jetzt, was der Bediener
 * sieht — und ob der Verbinden-Knopf überhaupt angeboten wird.
 */
function health(overrides: Partial<EbayListingSyncHealth> = {}): EbayListingSyncHealth {
  return {
    healthy: false,
    lastSuccessAtIso: "2026-10-08T04:03:16.880Z",
    staleMinutes: 120,
    lastError: { message: "eBay Trading skipped for GetMyeBaySelling: exceeded usage limit (shared quota cooldown 152s)", atIso: "2026-10-08T06:17:36.480Z" },
    errorKind: "quota",
    failingSinceIso: "2026-10-08T06:17:36.480Z",
    blockedReason: null,
    pendingConfirmation: false,
    staleLimitMinutes: 90,
    budget: { remaining: 0, limit: 5000, used: 5000, level: "exhausted", source: "probe", resetAtIso: "2026-10-08T07:00:00.000Z", reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, enabled: true },
    ...overrides,
  };
}

describe("describeEbayListingSync", () => {
  test("gesunder oder unbekannter Zustand → kein Banner", () => {
    assert.deepStrictEqual(describeEbayListingSync(null), { kind: "none" });
    assert.deepStrictEqual(describeEbayListingSync(health({ healthy: true })), { kind: "none" });
    assert.deepStrictEqual(describeEbayListingSync(health({ healthy: null })), { kind: "none" });
  });

  test("Kontingent leer → eigener Titel, Rest + Reset, KEIN Verbinden-Knopf", () => {
    const out = describeEbayListingSync(health());
    assert.strictEqual(out.kind, "quota");
    if (out.kind !== "quota") return;
    assert.strictEqual(out.title, "eBay-Tageskontingent erschöpft");
    assert.strictEqual(out.showReconnect, false);
    assert.ok(out.lines.some((l) => l.includes("0 von 5000")));
    assert.ok(out.lines.some((l) => l.includes("09:00") && l.includes("Neu verbinden hilft hier nicht")));
  });

  test("Spiegel nur PAUSIERT (Budget-Reserve, Stufe tight) → anderer Titel, Rest sichtbar, kein Verbinden-Knopf", () => {
    const out = describeEbayListingSync(
      health({
        lastError: { message: "Spiegel pausiert: Tagesbudget-Reserve erreicht (Rest 1400 von 5000)", atIso: "2026-10-08T12:00:00.000Z" },
        budget: { remaining: 1400, limit: 5000, used: 3600, level: "tight", source: "probe", resetAtIso: "2026-10-09T07:00:00.000Z", reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, enabled: true },
      })
    );
    assert.strictEqual(out.kind, "quota");
    if (out.kind !== "quota") return;
    assert.strictEqual(out.title, "eBay-Abgleich pausiert (Tagesbudget geschont)");
    assert.strictEqual(out.showReconnect, false);
    assert.ok(out.lines.some((l) => l.includes("1400 von 5000")));
    assert.ok(out.lines.some((l) => l.includes("Oversell-Schutz") || l.includes("Auftrags-Import")));
  });

  test("Kontingent leer ohne Budget-Stand → allgemeiner Reset-Hinweis, kein erfundener Rest", () => {
    const out = describeEbayListingSync(health({ budget: null }));
    assert.strictEqual(out.kind, "quota");
    if (out.kind !== "quota") return;
    assert.ok(!out.lines.some((l) => l.includes("Rest des Tageskontingents")));
    assert.ok(out.lines.some((l) => l.includes("Mitternacht US-Pazifik")));
  });

  test("Kontingent wieder frei (Stufe ok, Abgleich holt nach) → kein Folgetags-Reset, kein Knopf", () => {
    const out = describeEbayListingSync(
      health({
        budget: { remaining: 4900, limit: 5000, used: 100, level: "ok", source: "probe", resetAtIso: "2026-10-09T07:00:00.000Z", reserves: { floorP0: 10, reserveP1: 400, reserveP2: 1500 }, enabled: true },
      })
    );
    assert.strictEqual(out.kind, "quota");
    if (out.kind !== "quota") return;
    assert.strictEqual(out.title, "eBay-Kontingent wieder frei");
    assert.strictEqual(out.showReconnect, false);
    assert.ok(out.lines.some((l) => l.includes("nächsten Takt")));
    // Kein Folgetags-Reset (9.10.2026) — die erste Zeile nennt nur den letzten Erfolg (8.10.).
    assert.ok(!out.lines.some((l) => l.includes("9.10.2026")));
  });

  test("sonstiger Fehler (Netz/eBay-Fehler) → gestört, aber OHNE Verbinden-Knopf (neu verbinden heilt kein HTTP 500)", () => {
    const out = describeEbayListingSync(health({ errorKind: "other", lastError: { message: "Internal error to the application", atIso: null } }));
    assert.strictEqual(out.kind, "broken");
    if (out.kind !== "broken") return;
    assert.strictEqual(out.showReconnect, false);
    assert.ok(out.lines.some((l) => l.includes("Internal error")));
  });

  test("nur veraltet (errorKind null, z. B. Worker stand) → gestört ohne Knopf", () => {
    const out = describeEbayListingSync(health({ errorKind: null, lastError: null, failingSinceIso: null }));
    assert.strictEqual(out.kind, "broken");
    if (out.kind !== "broken") return;
    assert.strictEqual(out.showReconnect, false);
  });

  test("Fallback-Text ohne Budget nennt kein festes Zonenkürzel (MESZ gilt nur im Sommer)", () => {
    const out = describeEbayListingSync(health({ budget: null }));
    if (out.kind !== "quota") assert.fail("quota erwartet");
    assert.ok(!out.lines.some((l) => l.includes("MESZ")));
    assert.ok(out.lines.some((l) => l.includes("US-Pazifik")));
  });

  test("Anmeldefehler → gestört mit Fehlertext und Verbinden-Knopf", () => {
    const out = describeEbayListingSync(health({ errorKind: "auth", lastError: { message: "Invalid IAF token", atIso: null } }));
    assert.strictEqual(out.kind, "broken");
    if (out.kind !== "broken") return;
    assert.strictEqual(out.title, "Angebots-Abgleich mit eBay gestört");
    assert.strictEqual(out.showReconnect, true);
    assert.ok(out.lines.some((l) => l.includes("Invalid IAF token")));
  });

  test("Alt-Antwort ohne errorKind → wie bisher gestört + Verbinden-Knopf (abwärtskompatibel)", () => {
    const out = describeEbayListingSync(health({ errorKind: undefined, budget: undefined }));
    assert.strictEqual(out.kind, "broken");
    if (out.kind !== "broken") return;
    assert.strictEqual(out.showReconnect, true);
  });

  test("noch nie erfolgreich abgerufen → ehrlicher Satz statt leerem Datum", () => {
    const out = describeEbayListingSync(health({ lastSuccessAtIso: null, errorKind: "other" }));
    if (out.kind === "none") assert.fail("Banner erwartet");
    assert.ok(out.lines[0].startsWith("Es gab noch keinen erfolgreichen Abruf."));
  });
});
