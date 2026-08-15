import { describe, test } from "node:test";
import assert from "node:assert";
import { shouldRetryPermissionLoad, permissionRetryDelayMs, MAX_PERMISSION_ATTEMPTS } from "./permissionRetry.ts";

/**
 * Der Rechte-Abruf lief GENAU EINMAL. Ein WLAN-Aussetzer am Handscanner
 * genügte, damit ein leerer Rechte-Satz gesetzt wurde — und der ist von
 * "dieser Mensch darf wirklich nichts" nicht unterscheidbar. Ergebnis: der Tab
 * "Operationen" verschwand aus der Handy-Leiste, ohne Meldung, bis zum
 * manuellen Neuladen.
 *
 * Wiederholt wird nur, was Aussicht auf Erfolg hat. Bei 401 fährt die
 * API-Schicht bereits einen Token-Refresh; ein zusätzlicher Wiederholversuch
 * liefe nach dem Abmelden im Kreis.
 */
const fehlerMit = (status?: number) => Object.assign(new Error("kaputt"), { status });

describe("shouldRetryPermissionLoad", () => {
  test("Netzfehler ohne Status wird wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(undefined), 1), true);
  });

  test("Überlastung (429) wird wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(429), 1), true);
  });

  test("Serverfehler (503) wird wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(503), 1), true);
  });

  test("fehlende Anmeldung (401) wird NICHT wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(401), 1), false);
  });

  test("verweigerter Zugriff (403) wird NICHT wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(403), 1), false);
  });

  test("nach dem letzten Versuch wird nicht mehr wiederholt", () => {
    assert.strictEqual(shouldRetryPermissionLoad(fehlerMit(503), MAX_PERMISSION_ATTEMPTS), false);
  });

  test("die Abstände wachsen", () => {
    assert.ok(permissionRetryDelayMs(2) > permissionRetryDelayMs(1));
  });
});
