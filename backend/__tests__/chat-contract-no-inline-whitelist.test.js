'use strict';

/**
 * Verbot von Inline-Feldlisten in den Chat-Pipelines.
 *
 * Der Vorfall 2026-08-10 entstand nicht durch eine vergessene Zeile, sondern
 * durch eine KOPIERTE Feldliste: dieselbe Aufzählung lag an ~17 Stellen und
 * lief zwangsläufig auseinander. Erweitert wurde nur eine davon.
 *
 * Dieser Test hält die Feldliste an EINER Stelle
 * (`lib/chat-datasheet-contract.js`). Er folgt dem etablierten Repo-Muster aus
 * `__tests__/oversell-invariant.test.js`, das `marketplace.js` gegen
 * `reconBatch.update(...)` grept.
 *
 * Bewusst eng formuliert: gesucht wird nur nach GPSR-Feldnamen in
 * String-Literalen der drei Pipeline-Dateien. Prosa in Kommentaren und
 * Prompt-Texten ist erlaubt — verboten sind maschinell genutzte Aufzählungen.
 */

const fs = require('fs');
const path = require('path');

const PIPELINE_FILES = [
  'services/product-chat-v2.js',
  'services/product-chat.js',
  'services/product-chat-v3.js',
];

const BACKEND_ROOT = path.resolve(__dirname, '..');

/** Entfernt Zeilenkommentare und Blockkommentare, damit Prosa nicht anschlägt. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('Feldlisten liegen nur im Kontrakt-Modul', () => {
  it.each(PIPELINE_FILES)('%s enthält kein Inline-Array mit GPSR-Feldnamen', (rel) => {
    const src = stripComments(fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8'));

    // Ein Array-Literal, das MEHRERE GPSR-Feldnamen als Strings aufzählt, ist
    // genau die Kopie, die den Vorfall verursacht hat.
    const arrayLiterals = src.match(/\[[^[\]]{0,4000}\]/gs) || [];
    const offenders = arrayLiterals.filter((lit) => {
      const hits = [
        'manufacturer_name',
        'manufacturer_address',
        'manufacturer_city',
        'manufacturer_postalcode',
        'manufacturer_state_province',
        'manufacturer_phone',
      ].filter((f) => lit.includes(`'${f}'`) || lit.includes(`"${f}"`));
      return hits.length >= 3;
    });

    expect(offenders).toEqual([]);
  });

  it('der Kontrakt ist die einzige Datei, die die Liste definiert', () => {
    const contractSrc = fs.readFileSync(
      path.join(BACKEND_ROOT, 'lib/chat-datasheet-contract.js'),
      'utf8'
    );
    expect(contractSrc).toContain("'manufacturer_name'");
    expect(contractSrc).toContain("'eu_responsible_name'");
  });

  it('alle drei Pipelines beziehen die Liste aus dem Kontrakt', () => {
    for (const rel of PIPELINE_FILES) {
      const src = fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
      expect(src).toMatch(/chat-datasheet-contract/);
    }
  });
});
