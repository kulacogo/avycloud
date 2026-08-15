import { describe, test } from "node:test";
import assert from "node:assert";
import { authErrorMessage } from "./authErrors.ts";

/**
 * Jeder fehlgeschlagene Anmeldeversuch zeigte den rohen englischen
 * Firebase-Text, z. B. „Firebase: Error (auth/invalid-credential)." Der in allen
 * drei Sprachen gepflegte Satz „Anmeldung fehlgeschlagen." war unerreichbar,
 * weil `err.message` immer gesetzt ist.
 *
 * Wer sich vertippt, liest also einen Programmierer-Text statt einer Auskunft,
 * was zu tun ist — und erfährt nicht einmal, ob es an Adresse oder Passwort lag.
 */
describe("authErrorMessage", () => {
  const fallback = "Anmeldung fehlgeschlagen.";

  test("falsche Zugangsdaten bekommen einen verständlichen Satz", () => {
    const msg = authErrorMessage({ code: "auth/invalid-credential" }, fallback);
    assert.match(msg, /E-Mail|Passwort/i);
    assert.ok(!msg.includes("auth/"), "der technische Code darf nicht durchscheinen");
  });

  test("falsches Passwort und unbekanntes Konto sagen dasselbe", () => {
    // Bewusst identisch: sonst verrät die Meldung, welche Adressen existieren.
    const a = authErrorMessage({ code: "auth/wrong-password" }, fallback);
    const b = authErrorMessage({ code: "auth/user-not-found" }, fallback);
    assert.strictEqual(a, b);
  });

  test("zu viele Versuche nennt die Ursache", () => {
    const msg = authErrorMessage({ code: "auth/too-many-requests" }, fallback);
    assert.match(msg, /zu viele|später/i);
  });

  test("Netzproblem wird als solches benannt", () => {
    const msg = authErrorMessage({ code: "auth/network-request-failed" }, fallback);
    assert.match(msg, /Verbindung/i);
  });

  test("gesperrtes Konto wird benannt", () => {
    const msg = authErrorMessage({ code: "auth/user-disabled" }, fallback);
    assert.match(msg, /gesperrt/i);
  });

  test("unbekannter Code fällt auf den allgemeinen Satz zurück, nicht auf den Rohtext", () => {
    const msg = authErrorMessage(
      { code: "auth/etwas-ganz-neues", message: "Firebase: Error (auth/etwas-ganz-neues)." },
      fallback
    );
    assert.strictEqual(msg, fallback);
  });

  test("eigene Fehler ohne Firebase-Code bleiben erhalten", () => {
    // Die Domänenprüfung wirft einen eigenen, bereits verständlichen Satz.
    const eigener = "Nur @trendocean.de E-Mail-Adressen sind erlaubt.";
    assert.strictEqual(authErrorMessage({ message: eigener }, fallback), eigener);
  });

  test("roher Firebase-Text ohne Code wird nicht durchgereicht", () => {
    const msg = authErrorMessage({ message: "Firebase: Error (auth/invalid-email)." }, fallback);
    assert.ok(!msg.includes("Firebase"), "Firebase-Rohtext darf nie beim Menschen ankommen");
  });

  test("gar kein Fehler ergibt den allgemeinen Satz", () => {
    assert.strictEqual(authErrorMessage(null, fallback), fallback);
  });
});
