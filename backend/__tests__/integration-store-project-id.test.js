'use strict';

/**
 * Der Zugangsdaten-Speicher muss dieselbe Datenbank lesen wie der Rest.
 *
 * Gefunden 2026-08-17: `services/integration-store.js` baute den Firestore-
 * Client als `new Firestore()` — ohne Projekt. Damit nimmt die Bibliothek das
 * Standardprojekt der lokalen gcloud-Anmeldung, und das steht hier auf einem
 * FREMDEN Projekt (`kalima-503608`).
 *
 * Folge: Der Lesevorgang scheitert mit "5 NOT_FOUND", der Code faellt still auf
 * den Secret Manager zurueck — und zieht dort veraltete Zugangsdaten der
 * Alt-Firma. Jedes lokale Audit-Script misst dann die falsche Firma, ohne dass
 * es jemandem auffaellt. Genau das ist beim Finanz-Audit passiert (falscher
 * Mandant 1156399 statt 1272443, Saldo 5.569,42 statt 1.497,85 €).
 *
 * In Cloud Run faellt es nicht auf, weil das Standardprojekt dort ohnehin
 * stimmt — die Korrektur aendert dort also nichts.
 *
 * `lib/firestore.js:92` macht es richtig: projectId explizit.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'integration-store.js'), 'utf8');

describe('Firestore-Client im Zugangsdaten-Speicher', () => {
  it('wird NICHT ohne Projektangabe gebaut', () => {
    expect(SOURCE).not.toMatch(/new Firestore\(\s*\)/);
  });

  it('setzt das Projekt ausdruecklich', () => {
    expect(SOURCE).toMatch(/new Firestore\(\s*\{[^}]*projectId/s);
  });

  it('nutzt dieselbe Herleitung wie lib/firestore.js', () => {
    const kern = fs.readFileSync(path.join(__dirname, '..', 'lib', 'firestore.js'), 'utf8');
    const muster = /GOOGLE_CLOUD_PROJECT\s*\|\|\s*'avycloud'/;
    expect(kern).toMatch(muster);
    expect(SOURCE).toMatch(muster);
  });
});
