import test from "node:test";
import assert from "node:assert/strict";

import { shouldScrollToTop, scrollListToTop } from "./listPaging.ts";

test("erstes Rendern scrollt nicht", () => {
  assert.equal(shouldScrollToTop(null, 1), false);
  assert.equal(shouldScrollToTop(undefined, 3), false);
});

test("gleiche Seite scrollt nicht", () => {
  // Sonst springt die Liste bei jedem Neurendern (Filter, Zwischenspeicher).
  assert.equal(shouldScrollToTop(2, 2), false);
});

test("echter Seitenwechsel scrollt — vor und zurueck", () => {
  assert.equal(shouldScrollToTop(1, 2), true);
  assert.equal(shouldScrollToTop(5, 4), true);
});

test("unsinnige Werte scrollen nicht", () => {
  assert.equal(shouldScrollToTop(Number.NaN, 2), false);
  assert.equal(shouldScrollToTop(1, Number.NaN), false);
});

test("scrollt am Listenanfang, wenn ein Anker da ist", () => {
  let gerufenMit: any = null;
  scrollListToTop({ scrollIntoView: (options: unknown) => { gerufenMit = options; } });
  assert.deepEqual(gerufenMit, { behavior: "smooth", block: "start" });
});

test("faellt ohne Anker auf den Seitenanfang zurueck", () => {
  const vorher = (globalThis as any).window;
  let top: any = null;
  (globalThis as any).window = { scrollTo: (options: any) => { top = options; } };
  try {
    scrollListToTop(null);
    assert.deepEqual(top, { top: 0, behavior: "smooth" });
  } finally {
    (globalThis as any).window = vorher;
  }
});

test("respektiert 'Bewegung reduzieren'", () => {
  const vorher = (globalThis as any).window;
  let gerufenMit: any = null;
  (globalThis as any).window = { matchMedia: () => ({ matches: true }) };
  try {
    scrollListToTop({ scrollIntoView: (options: unknown) => { gerufenMit = options; } });
    assert.deepEqual(gerufenMit, { behavior: "auto", block: "start" });
  } finally {
    (globalThis as any).window = vorher;
  }
});
