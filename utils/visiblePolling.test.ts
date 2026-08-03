import { describe, it, expect } from "vitest";
import { startVisiblePolling, type VisiblePollingDeps } from "./visiblePolling";

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
  it("fragt im Takt ab, solange der Tab sichtbar ist", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.fireInterval();
    h.fireInterval();
    expect(h.ticks).toHaveLength(2);
  });

  it("pausiert die Abfrage in unsichtbaren Tabs (der eigentliche Spareffekt)", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    h.fireInterval();
    h.fireInterval();
    expect(h.ticks).toHaveLength(0);
  });

  it("lädt beim Zurückwechseln SOFORT nach, damit niemand veraltete Daten sieht", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    expect(h.ticks).toHaveLength(0);

    h.setVisible(true);
    h.fireVisibilityChange();
    expect(h.ticks).toHaveLength(1);
  });

  it("lädt NICHT bei jedem Sichtbarkeits-Ereignis nach, nur nach einer echten Pause", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.fireVisibilityChange();
    h.fireVisibilityChange();
    expect(h.ticks).toHaveLength(0);
  });

  it("nimmt den Takt nach der Rückkehr wieder normal auf", () => {
    const h = makeHarness(true);
    startVisiblePolling(h.tick, 60000, h.deps);
    h.setVisible(false);
    h.fireInterval();
    h.setVisible(true);
    h.fireVisibilityChange();
    h.fireInterval();
    expect(h.ticks).toHaveLength(2);
  });

  it("fragt im Zweifel ab: unbekannte Sichtbarkeit darf die Oberfläche nie einfrieren", () => {
    const h = makeHarness(true);
    // isVisible liefert hier immer true (Fail-Open-Standard aus browserPollingDeps)
    startVisiblePolling(h.tick, 60000, { ...h.deps, isVisible: () => true });
    h.fireInterval();
    expect(h.ticks).toHaveLength(1);
  });

  it("räumt Takt und Listener beim Aufräumen ab", () => {
    const h = makeHarness(true);
    const stop = startVisiblePolling(h.tick, 60000, h.deps);
    stop();
    expect(h.cleared).toEqual([42]);
    expect(h.wasUnsubscribed()).toBe(true);
  });
});
