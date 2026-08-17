import test from "node:test";
import assert from "node:assert/strict";

import { shouldCloseOnEscape } from "./overlayKeys.ts";

test("Escape schliesst das Overlay", () => {
  assert.equal(shouldCloseOnEscape({ key: "Escape" }), true);
  assert.equal(shouldCloseOnEscape({ key: "Esc" }), true);
});

test("andere Tasten schliessen nichts", () => {
  for (const key of ["Enter", "Tab", "a", " "]) {
    assert.equal(shouldCloseOnEscape({ key }), false);
  }
});

test("ein darueberliegender Dialog behaelt den Tastendruck", () => {
  assert.equal(shouldCloseOnEscape({ key: "Escape", defaultPrevented: true }), false);
});

test("waehrend einer Zeichen-Komposition passiert nichts", () => {
  assert.equal(shouldCloseOnEscape({ key: "Escape", isComposing: true }), false);
});

test("im Textfeld gehoert Escape der Eingabe", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
    assert.equal(shouldCloseOnEscape({ key: "Escape", target: { tagName } }), false);
  }
  assert.equal(
    shouldCloseOnEscape({ key: "Escape", target: { tagName: "DIV", isContentEditable: true } }),
    false,
  );
});

test("ein markierter Bereich kann Escape fuer sich beanspruchen", () => {
  const target = { tagName: "DIV", closest: (sel: string) => (sel === "[data-escape-guard]" ? {} : null) };
  assert.equal(shouldCloseOnEscape({ key: "Escape", target }), false);
});

test("ausserhalb von Eingaben schliesst es", () => {
  const target = { tagName: "DIV", closest: () => null };
  assert.equal(shouldCloseOnEscape({ key: "Escape", target }), true);
});

test("vertraegt fehlende Eingaben", () => {
  assert.equal(shouldCloseOnEscape(null), false);
  assert.equal(shouldCloseOnEscape(undefined), false);
});
