import test from "node:test";
import assert from "node:assert/strict";

import { classifyInvoiceTab, istUeberfaellig } from "./invoiceTabs.ts";

const JETZT = new Date("2026-08-17T12:00:00Z").getTime();
const GESTERN = "2026-08-16";
const MORGEN = "2026-08-18";

test("der Reiter Ueberfaellig fuellt sich ueber das Faelligkeitsdatum", () => {
  // Genau der Vorfall: Status "offen", Faelligkeit ueberschritten.
  // 256 von 581 Rechnungen sahen so aus und waren im Reiter unsichtbar.
  assert.equal(classifyInvoiceTab({ status: "offen", dueDate: GESTERN }, JETZT), "ueberfaellig");
});

test("noch nicht faellige Rechnungen bleiben offen", () => {
  assert.equal(classifyInvoiceTab({ status: "offen", dueDate: MORGEN }, JETZT), "offen");
});

test("bezahlt und storniert schlagen die Faelligkeit", () => {
  assert.equal(classifyInvoiceTab({ status: "bezahlt", dueDate: GESTERN }, JETZT), "bezahlt");
  assert.equal(classifyInvoiceTab({ status: "storniert", dueDate: GESTERN }, JETZT), "storniert");
});

test("ein Entwurf ist nie ueberfaellig — er wurde nie verschickt", () => {
  assert.equal(classifyInvoiceTab({ status: "entwurf", dueDate: GESTERN }, JETZT), "entwurf");
  assert.equal(istUeberfaellig({ status: "entwurf", dueDate: GESTERN }, JETZT), false);
});

test("Storno und Gutschrift zaehlen als storniert", () => {
  assert.equal(classifyInvoiceTab({ status: "offen", type: "storno" }, JETZT), "storniert");
  assert.equal(classifyInvoiceTab({ status: "offen", type: "gutschrift" }, JETZT), "storniert");
});

test("ein kuenftiger Status ueberfaellig faellt nicht durch", () => {
  assert.equal(classifyInvoiceTab({ status: "ueberfaellig" }, JETZT), "ueberfaellig");
});

test("heute faellig ist noch nicht ueberfaellig", () => {
  const heute = new Date(JETZT).toISOString();
  assert.equal(istUeberfaellig({ status: "offen", dueDate: heute }, JETZT), false);
});

test("ohne Faelligkeitsdatum passiert nichts", () => {
  assert.equal(istUeberfaellig({ status: "offen" }, JETZT), false);
  assert.equal(istUeberfaellig({ status: "offen", dueDate: "" }, JETZT), false);
  assert.equal(istUeberfaellig({ status: "offen", dueDate: "kein Datum" }, JETZT), false);
});

test("vertraegt fehlende Rechnungen", () => {
  assert.equal(istUeberfaellig(null, JETZT), false);
  assert.equal(classifyInvoiceTab(null, JETZT), "offen");
});

test("englische Schreibweisen zaehlen mit", () => {
  assert.equal(istUeberfaellig({ status: "paid", dueDate: GESTERN }, JETZT), false);
  assert.equal(istUeberfaellig({ status: "sent", dueDate: GESTERN }, JETZT), true);
});
