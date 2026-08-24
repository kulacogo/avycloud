const { test } = require('node:test');
const assert = require('node:assert');
const { berechnePause, DEFAULT_KONTINGENT } = require('../lib/drossel');

// Die Erfassung ist auf 30 Anfragen je 15 Minuten begrenzt (identifyLimiter in
// backend/lib/rate-limit.js). Der Zaehler laeuft VOR der Anmeldung und damit
// pro IP-Adresse — der Agent teilt sie sich mit den Mitarbeitern im selben
// Buero. Ohne Selbstdrosselung wuerde ein Stapellauf den Erfassen-Assistenten
// der Kollegen sperren. Deshalb nimmt der Agent nur einen Teil des Kontingents.

const fenster = 15 * 60 * 1000;

test('nimmt nur einen Teil des Kontingents in Anspruch', () => {
  assert.ok(DEFAULT_KONTINGENT < 30, 'muss Luft fuer die Mitarbeiter lassen');
});

test('wartet nicht, solange Kontingent frei ist', () => {
  const jetzt = 1_000_000;
  const pause = berechnePause({ letzteAufrufe: [jetzt - 1000], jetzt, maxProFenster: 3, fensterMs: fenster });

  assert.strictEqual(pause, 0);
});

test('wartet, bis der aelteste Aufruf aus dem Fenster faellt', () => {
  const jetzt = 1_000_000;
  const aeltester = jetzt - (fenster - 5000); // faellt in 5 s raus
  const pause = berechnePause({
    letzteAufrufe: [aeltester, jetzt - 2000, jetzt - 1000],
    jetzt,
    maxProFenster: 3,
    fensterMs: fenster,
  });

  assert.strictEqual(pause, 5000);
});

test('zaehlt Aufrufe ausserhalb des Fensters nicht mit', () => {
  const jetzt = 1_000_000;
  const pause = berechnePause({
    letzteAufrufe: [jetzt - fenster - 1, jetzt - fenster - 2, jetzt - 1000],
    jetzt,
    maxProFenster: 3,
    fensterMs: fenster,
  });

  assert.strictEqual(pause, 0);
});

test('kommt ohne bisherige Aufrufe zurecht', () => {
  assert.strictEqual(berechnePause({ letzteAufrufe: [], jetzt: 1000, maxProFenster: 3, fensterMs: fenster }), 0);
  assert.strictEqual(berechnePause({ jetzt: 1000 }), 0);
});
