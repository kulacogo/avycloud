// node:test statt vitest — vitest ist im Frontend nicht installiert, wodurch
// diese Datei nie lief. Der Rest des Frontends testet mit node:test.
import { describe, test } from "node:test";
import assert from "node:assert";
import { startVisiblePolling, type VisiblePollingDeps } from "./visiblePolling.ts";

/**
 * Kostenanalyse Juli 2026: Hintergrund-Tabs holten im 60s-Takt die komplette
 * Produktliste (je ~1.700 Firestore-Reads). Diese Tests sichern das neue
 * Verhalten ab — vor allem die Regel "im Zweifel wird abgefragt", damit ein
 * Fehler hier nie die Oberfläche einfrieren lässt.
 */
function makeHarness(startVisible = true) {
  let visible = startVisible;
  let intervalFn: (() => void) | null = null;
  let visibilityHandler: (() => void) | null = null;
  const cleared: number[] = [];
  let unsubscribed = false;
  const ticks: number[] = [];

  const deps: VisiblePollingDeps = {
    isVisible: () => visible,
    onVisibilityChange: (handler) => {
      visibilityHandler = handler;
      return () => { unsubscribed = true; };
    },
    setInterval: (fn) => { intervalFn = fn; return 42; },
    clearInterval: (id) => { cleared.push(id); },
  };

  return {
    deps,
    ticks,
    tick: () => ticks.push(1),
    fireInterval: () => intervalFn?.(),
    setVisible: (v: boolean) => { visible = v; },
    fireVisibilityChange: () => visibilityHandler?.(),
    cleared,
    wasUnsubscribed: () => unsubscribed,
  };
}

describe("startVisiblePolling", () => {
  test("fragt im Takt ab, solange der Tab sichtbar ist", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.fireInterval();
    h.fireInterval();
    assert.strictEqual(h.ticks.length, 2);
  });

  test("pausiert die Abfrage in unsichtbaren Tabs (der eigentliche Spareffekt)", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    h.fireInterval();
    h.fireInterval();
    assert.strictEqual(h.ticks.length, 0);
  });

  test("lädt beim Zurückwechseln SOFORT nach, damit niemand veraltete Daten sieht", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    assert.strictEqual(h.ticks.length, 0);

    h.setVisible(true);
    h.fireVisibilityChange();
    assert.strictEqual(h.ticks.length, 1);
  });

  test("lädt NICHT bei jedem Sichtbarkeits-Ereignis nach, nur nach einer echten Pause", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.fireVisibilityChange();
    h.fireVisibilityChange();
    assert.strictEqual(h.ticks.length, 0);
  });

  test("nimmt den Takt nach der Rückkehr wieder normal auf", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    h.setVisible(true);
    h.fireVisibilityChange();
    h.fireInterval();
    assert.strictEqual(h.ticks.length, 2);
  });

  test("fragt im Zweifel ab: unbekannte Sichtbarkeit darf die Oberfläche nie einfrieren", () => {
    const h = makeHarness(true);
    // isVisible liefert hier immer true (Fail-Open-Standard aus browserPollingDeps)
    startVisiblePolling(h.tick, 60000, { ...h.deps, isVisible: () => true });
    h.fireInterval();
    assert.strictEqual(h.ticks.length, 1);
  });

  test("räumt Takt und Listener beim Aufräumen ab", () => {
    const h = makeHarness(true);
    const stop = startVisiblePolling(h.tick, 60000, h.deps);
    stop();
    assert.deepStrictEqual(h.cleared, [42]);
    assert.strictEqual(h.wasUnsubscribed(), true);
  });
});
