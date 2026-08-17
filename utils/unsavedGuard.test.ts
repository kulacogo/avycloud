import test from "node:test";
import assert from "node:assert/strict";

import {
  registerUnsavedGuard,
  hasUnsavedChanges,
  confirmLeaveIfUnsaved,
  resetUnsavedGuards,
  isChangedSince,
  UNSAVED_MESSAGE,
} from "./unsavedGuard.ts";

test("ohne Anmeldung darf man immer gehen", () => {
  resetUnsavedGuards();
  assert.equal(hasUnsavedChanges(), false);
  assert.equal(confirmLeaveIfUnsaved(() => false), true);
});

test("eine geaenderte Seite haelt auf", () => {
  resetUnsavedGuards();
  registerUnsavedGuard("einstellungen", () => true);
  assert.equal(hasUnsavedChanges(), true);
});

test("die Rueckfrage entscheidet", () => {
  resetUnsavedGuards();
  registerUnsavedGuard("einstellungen", () => true);
  let gefragt = "";
  assert.equal(confirmLeaveIfUnsaved((m) => { gefragt = m; return false; }), false);
  assert.equal(gefragt, UNSAVED_MESSAGE);
  assert.equal(confirmLeaveIfUnsaved(() => true), true);
});

test("abmelden raeumt auf", () => {
  resetUnsavedGuards();
  const abmelden = registerUnsavedGuard("einstellungen", () => true);
  abmelden();
  assert.equal(hasUnsavedChanges(), false);
});

test("eine kaputte Pruefung blockiert die Navigation nicht", () => {
  resetUnsavedGuards();
  registerUnsavedGuard("kaputt", () => { throw new Error("boom"); });
  assert.equal(hasUnsavedChanges(), false);
});

test("mehrere Seiten: eine geaenderte reicht", () => {
  resetUnsavedGuards();
  registerUnsavedGuard("a", () => false);
  registerUnsavedGuard("b", () => true);
  assert.equal(hasUnsavedChanges(), true);
});

test("dieselbe Kennung ersetzt statt zu haeufen", () => {
  resetUnsavedGuards();
  registerUnsavedGuard("a", () => true);
  registerUnsavedGuard("a", () => false);
  assert.equal(hasUnsavedChanges(), false);
});

test("Aenderungsvergleich: vor dem Laden gilt nichts als geaendert", () => {
  assert.equal(isChangedSince(undefined, { a: 1 }), false);
});

test("Aenderungsvergleich erkennt echte Unterschiede", () => {
  assert.equal(isChangedSince({ a: 1 }, { a: 1 }), false);
  assert.equal(isChangedSince({ a: 1 }, { a: 2 }), true);
  assert.equal(isChangedSince([1, 2], [1, 2]), false);
  assert.equal(isChangedSince([1, 2], [2, 1]), true);
});

test("Aenderungsvergleich vertraegt Unvergleichbares", () => {
  const zirkulaer: any = {};
  zirkulaer.self = zirkulaer;
  assert.equal(isChangedSince(zirkulaer, { a: 1 }), false);
});
