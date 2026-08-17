import test from "node:test";
import assert from "node:assert/strict";

import { shouldOpenCellEditor } from "./cellKeys.ts";

test("Enter, F2 und Leertaste oeffnen die Zelle", () => {
  for (const key of ["Enter", "F2", " ", "Spacebar"]) {
    assert.equal(shouldOpenCellEditor({ key }), true);
  }
});

test("andere Tasten oeffnen nichts", () => {
  for (const key of ["Tab", "Escape", "a", "ArrowDown"]) {
    assert.equal(shouldOpenCellEditor({ key }), false);
  }
});

test("Tastenkuerzel bleiben unangetastet", () => {
  // Strg+Enter, Cmd+Enter usw. gehoeren dem Browser bzw. der Anwendung.
  assert.equal(shouldOpenCellEditor({ key: "Enter", ctrlKey: true }), false);
  assert.equal(shouldOpenCellEditor({ key: "Enter", metaKey: true }), false);
  assert.equal(shouldOpenCellEditor({ key: "Enter", altKey: true }), false);
});

test("ein schon behandelter Tastendruck oeffnet nichts", () => {
  assert.equal(shouldOpenCellEditor({ key: "Enter", defaultPrevented: true }), false);
});

test("vertraegt fehlende Eingaben", () => {
  assert.equal(shouldOpenCellEditor(null), false);
  assert.equal(shouldOpenCellEditor(undefined), false);
});
