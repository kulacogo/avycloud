const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ladeRegister, speichereRegister, istErledigt, merkeErledigt, merkeFehlversuch, istAufgegeben } = require('../lib/register');

// Das Verschieben nach IDENT ist die eigentliche "erledigt"-Markierung. Es gibt
// aber ein Fenster dazwischen: die Erfassung war erfolgreich, das Verschieben
// scheitert (SMB-Aussetzer). Ohne zweite Markierung liefe dieselbe Datei alle
// 30 Minuten erneut durch die Erkennung — Geld UND neue Dubletten.
//
// Deshalb wird der Erfolg SOFORT nach der Erfassung im Register vermerkt,
// bevor ueberhaupt verschoben wird.

const tempRegister = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foto-agent-')), 'register.json');

test('erkennt eine bereits erfasste Datei wieder', () => {
  const register = {};
  merkeErledigt(register, 'hash-a', { produktId: 'p1' });

  assert.strictEqual(istErledigt(register, 'hash-a'), true);
  assert.strictEqual(istErledigt(register, 'hash-b'), false);
});

test('ueberlebt einen Neustart', () => {
  const pfad = tempRegister();
  const register = ladeRegister(pfad);
  merkeErledigt(register, 'hash-a', { produktId: 'p1' });
  speichereRegister(pfad, register);

  assert.strictEqual(istErledigt(ladeRegister(pfad), 'hash-a'), true);
});

test('startet bei beschaedigtem Register leer statt abzustuerzen', () => {
  const pfad = tempRegister();
  fs.writeFileSync(pfad, '{kaputt', 'utf8');

  assert.deepStrictEqual(ladeRegister(pfad), {});
});

test('gibt eine Datei erst nach mehreren Fehlversuchen auf', () => {
  const register = {};
  merkeFehlversuch(register, 'hash-a', 'Gemini 503');
  merkeFehlversuch(register, 'hash-a', 'Gemini 503');

  assert.strictEqual(istAufgegeben(register, 'hash-a', 3), false);

  merkeFehlversuch(register, 'hash-a', 'Gemini 503');

  assert.strictEqual(istAufgegeben(register, 'hash-a', 3), true);
});

test('haelt den letzten Fehler fest, damit jemand nachsehen kann', () => {
  const register = {};
  merkeFehlversuch(register, 'hash-a', 'LOT_NOT_FOUND');

  assert.match(register['hash-a'].letzterFehler, /LOT_NOT_FOUND/);
});

test('behandelt eine erledigte Datei nie als aufgegeben', () => {
  const register = {};
  merkeFehlversuch(register, 'hash-a', 'einmal daneben');
  merkeErledigt(register, 'hash-a', { produktId: 'p1' });

  assert.strictEqual(istAufgegeben(register, 'hash-a', 1), false);
  assert.strictEqual(istErledigt(register, 'hash-a'), true);
});
