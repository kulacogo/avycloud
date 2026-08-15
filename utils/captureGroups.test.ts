import { describe, test } from "node:test";
import assert from "node:assert";
import { groupsSignature, type SignableGroup } from "./captureGroups.ts";

/**
 * Im Erfassen startete "Zurück" aus dem Prüfen-Schritt die komplette
 * KI-Erkennung neu — alle eingetippten Korrekturen waren weg und im Katalog
 * lag ein Doppel-Produkt. Der Assistent braucht deshalb eine belastbare
 * Antwort auf die Frage: hat der Mensch an der Gruppierung WIRKLICH etwas
 * geändert? Nur dann darf erneut erkannt werden.
 */
const bild = (name: string, size = 100, lastModified = 1) => ({ name, size, lastModified });

const basis: SignableGroup[] = [
  { id: "g1", label: "Produkt 1", barcodes: "4006381333931", hint: null, images: [bild("a.jpg"), bild("b.jpg")] },
  { id: "g2", label: "Produkt 2", barcodes: "", hint: null, images: [bild("c.jpg")] },
];

describe("groupsSignature", () => {
  test("gleiche Gruppierung ergibt gleiche Signatur", () => {
    assert.strictEqual(groupsSignature(basis), groupsSignature(basis.map((g) => ({ ...g }))));
  });

  test("ein verschobenes Bild ändert die Signatur", () => {
    const verschoben: SignableGroup[] = [
      { ...basis[0], images: [bild("a.jpg")] },
      { ...basis[1], images: [bild("b.jpg"), bild("c.jpg")] },
    ];
    assert.notStrictEqual(groupsSignature(basis), groupsSignature(verschoben));
  });

  test("ein nachgetragener Barcode ändert die Signatur", () => {
    const mitBarcode = [basis[0], { ...basis[1], barcodes: "12345670" }];
    assert.notStrictEqual(groupsSignature(basis), groupsSignature(mitBarcode));
  });

  test("ein geänderter Hinweis ändert die Signatur", () => {
    const mitHinweis = [{ ...basis[0], hint: "Rückseite beachten" }, basis[1]];
    assert.notStrictEqual(groupsSignature(basis), groupsSignature(mitHinweis));
  });

  test("eine zusätzliche Gruppe ändert die Signatur", () => {
    const mehr = [...basis, { id: "g3", label: "Produkt 3", barcodes: "", hint: null, images: [bild("d.jpg")] }];
    assert.notStrictEqual(groupsSignature(basis), groupsSignature(mehr));
  });

  test("zwei Bilder mit gleichem Namen aber anderer Größe gelten als verschieden", () => {
    const andereDatei = [{ ...basis[0], images: [bild("a.jpg"), bild("b.jpg", 999)] }, basis[1]];
    assert.notStrictEqual(groupsSignature(basis), groupsSignature(andereDatei));
  });

  test("die Reihenfolge der Bilder innerhalb einer Gruppe zählt nicht als Änderung", () => {
    const umsortiert = [{ ...basis[0], images: [bild("b.jpg"), bild("a.jpg")] }, basis[1]];
    assert.strictEqual(groupsSignature(basis), groupsSignature(umsortiert));
  });

  test("leere Gruppenliste ist stabil und kollidiert nicht mit einer echten Gruppe", () => {
    assert.strictEqual(groupsSignature([]), groupsSignature([]));
    assert.notStrictEqual(groupsSignature([]), groupsSignature(basis));
  });
});
