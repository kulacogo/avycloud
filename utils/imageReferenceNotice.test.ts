import test from "node:test";
import assert from "node:assert/strict";
import { describeImageReferenceIssue, imageReferenceNextStep } from "./imageReferenceNotice.ts";

test("Ladefehler sind keine negative KI-Bildbewertung", () => {
  assert.match(describeImageReferenceIssue("referenz_laden_fehlgeschlagen")!, /nicht.*bewertet/);
  assert.match(describeImageReferenceIssue("vorlagen_nicht_vollstaendig_geladen")!, /Bildzugriff/);
  assert.doesNotMatch(imageReferenceNextStep([{ reason: "referenz_laden_fehlgeschlagen" }]), /auspacken|abfotografieren/i);
});
test("Web-Produktbilder sind eine erlaubte Ergänzung", () => {
  assert.match(describeImageReferenceIssue("keine_brauchbare_vorlage")!, /Web/);
  assert.match(imageReferenceNextStep([{ reason: "kein_foto" }]), /Web-Bild-URL/);
  assert.equal(describeImageReferenceIssue("erzeugung_fehlgeschlagen"), null);
});
