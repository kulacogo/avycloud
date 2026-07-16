import { test } from "node:test";
import assert from "node:assert";
import { mergeIncomingDatasheetChanges } from "./chatChanges.ts";

// The reported bug: the backend returns a change BOTH as structured
// data.datasheetChanges AND embedded as a ```json block in the message text.
// The frontend parsed both and showed the SAME change twice.
test("collapses a change that arrives from both structured + message-json sources", () => {
  const change = { summary: "Änderung aus Chat", title: "TYC Außenspiegel Rechts Ford Transit V363" };
  const result = mergeIncomingDatasheetChanges([change], [{ ...change }]);
  assert.strictEqual(result.length, 1);
});

// Structured changes are canonical; the message-parsed source is a legacy
// fallback and must be IGNORED entirely when structured changes exist.
test("ignores message-parsed changes when structured changes are present", () => {
  const structured = { title: "Structured title" };
  const fromMessage = { title: "A different edit only in the message text" };
  const result = mergeIncomingDatasheetChanges([structured], [fromMessage]);
  assert.deepStrictEqual(result, [structured]);
});

// Fallback still works: older pipelines that only emit JSON in prose.
test("uses message-parsed changes as a fallback when there are no structured changes", () => {
  const fromMessage = { title: "Only in the message" };
  const result = mergeIncomingDatasheetChanges([], [fromMessage]);
  assert.deepStrictEqual(result, [fromMessage]);
});

// Defense in depth: identical changes within the structured source are deduped
// (e.g. the model called update_product_datasheet twice with the same args).
test("dedupes identical changes within the structured source", () => {
  const change = { title: "dup" };
  const result = mergeIncomingDatasheetChanges([change, { ...change }], []);
  assert.strictEqual(result.length, 1);
});

// Distinct changes are preserved (no over-collapsing).
test("preserves distinct changes", () => {
  const result = mergeIncomingDatasheetChanges(
    [{ title: "A" }, { short_description: "B" }],
    []
  );
  assert.strictEqual(result.length, 2);
});

// Key order must not affect duplicate detection.
test("treats changes with the same content but different key order as duplicates", () => {
  const a = { title: "X", summary: "S" };
  const b = { summary: "S", title: "X" };
  const result = mergeIncomingDatasheetChanges([a], [b]);
  assert.strictEqual(result.length, 1);
});

// Empty/blank change objects are dropped.
test("drops empty change objects", () => {
  const result = mergeIncomingDatasheetChanges([{}], []);
  assert.strictEqual(result.length, 0);
});

// Handles undefined inputs without throwing.
test("handles undefined inputs gracefully", () => {
  assert.deepStrictEqual(mergeIncomingDatasheetChanges(undefined, undefined), []);
});

// ─── normalizeChangeAttributes (Incident 2026-07-16) ─────────────────────────
// Chat-V3 tool cards deliver attributes as ARRAY of {key,value}; the apply path
// iterates Object.entries() and wrote details.attributes['0'] = {key,value}
// garbage. The normalizer folds both shapes into the canonical map.

import { normalizeChangeAttributes } from "./chatChanges.ts";

test("normalizes V3 array shape [{key, value}] into a map", () => {
  const out = normalizeChangeAttributes([
    { key: "K-Typ", value: "123|456" },
    { key: "Farbe", value: "Anthrazit" },
  ]);
  assert.deepStrictEqual(out, { "K-Typ": "123|456", "Farbe": "Anthrazit" });
});

test("accepts legacy {name, value} array entries", () => {
  const out = normalizeChangeAttributes([{ name: "Material", value: "EVA" }]);
  assert.deepStrictEqual(out, { Material: "EVA" });
});

test("prefers key over name when both exist, trims keys", () => {
  const out = normalizeChangeAttributes([{ key: " K-Typ ", name: "ignored", value: "42" }]);
  assert.deepStrictEqual(out, { "K-Typ": "42" });
});

test("drops entries without key/name, with null value, or object values — never writes junk keys", () => {
  const out = normalizeChangeAttributes([
    { value: "orphan" },
    { key: "Leer", value: null },
    { key: "Objekt", value: { nested: true } },
    "not-an-object",
    null,
  ]);
  assert.deepStrictEqual(out, {});
});

test("passes through an already-map shape, dropping object values defensively", () => {
  const out = normalizeChangeAttributes({ "K-Typ": "1|2", Kaputt: { a: 1 }, Zahl: 3 });
  assert.deepStrictEqual(out, { "K-Typ": "1|2", Zahl: 3 });
});

test("non-object input yields empty map", () => {
  assert.deepStrictEqual(normalizeChangeAttributes(undefined), {});
  assert.deepStrictEqual(normalizeChangeAttributes("x"), {});
});
