'use strict';

/**
 * Der K-Typ-CSV-Import schrieb in die stillgelegte Sammlung.
 *
 * Gefunden 2026-08-17. Der Import LIEST ueber getProduct() aus products_v2,
 * SCHRIEB aber mit `firestore.collection('products')` — der Legacy-Sammlung,
 * die seit der Umstellung nur noch gelesen wird. Der Bediener laedt eine
 * eBay-Kompatibilitaetsliste hoch, sieht "142 aktualisiert", und im Datenblatt
 * steht danach nichts. Stiller Totalverlust der hochgeladenen Arbeit.
 *
 * Zusaetzlich verletzt der direkte Schreibzugriff die Grundregel: jeder
 * Produkt-Schreibpfad laeuft ueber saveProductV2() (CLAUDE.md Punkt 7) —
 * nur dort haengen Revision, Sync-Event und Kanonisierung dran.
 *
 * Dieser Test prueft die Quelle, nicht das Verhalten: die Route hat keinen
 * erreichbaren Testaufhaenger (Multipart + Firestore + Worker-Pool), und ein
 * Nachbau davon wuerde genau die Zeile nachbilden, die falsch war.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'marketplace.js'), 'utf8');

/** Nur der Rumpf der K-Typ-Upload-Route. */
function ktypeUploadSection() {
  const start = SOURCE.indexOf("router.post('/ktype/upload'");
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nrouter.', start + 20);
  return SOURCE.slice(start, end > start ? end : SOURCE.length);
}

describe('K-Typ-CSV-Import schreibt nach products_v2', () => {
  it('fasst die stillgelegte products-Sammlung nicht an', () => {
    const section = ktypeUploadSection();
    expect(section).not.toMatch(/collection\(\s*['"]products['"]\s*\)/);
  });

  it('schreibt ueber saveProductV2', () => {
    const section = ktypeUploadSection();
    expect(section).toMatch(/saveProductV2\s*\(/);
  });
});
