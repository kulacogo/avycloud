const { test } = require('node:test');
const assert = require('node:assert');
const { leseLosCode, pruefeOrdner } = require('../lib/tagesordner');

// Ein Tagesordner wird nur angefasst, wenn zwei Dinge stimmen:
//   1. es wird gerade nicht mehr fotografiert (Ruhezeit)
//   2. es steht dran, zu welchem Los die Ware gehoert
//
// Zu 1: der 30-Minuten-Takt trifft sonst einen Ordner mitten in der Session und
// zerreisst die Fotoserie eines Produkts auf zwei Laeufe — das erzeugt genau
// die Dublette, die dieser Umbau verhindern soll. Gemessen am 17.08.2026 lag
// die groesste Luecke INNERHALB einer Session bei 27,6 min.
//
// Zu 2: das Los ist beim Erfassen Pflicht (Fehler LOT_REQUIRED) und laesst sich
// aus einem Datumsordner nicht ableiten. Raten ist keine Option — am Los haengt
// der Einkaufspreis.

const jetzt = new Date(2026, 7, 17, 16, 0, 0);
const vorMinuten = (m) => new Date(jetzt.getTime() - m * 60 * 1000);

test('erkennt gueltige Los-Codes', () => {
  assert.strictEqual(leseLosCode('L-081703'), 'L-081703');
  assert.strictEqual(leseLosCode('NL-0826'), 'NL-0826');
  assert.strictEqual(leseLosCode('  l-081703  \n'), 'L-081703');
});

test('erlaubt Kommentarzeilen in der Los-Datei', () => {
  const inhalt = '# Los fuer den 17.08. — Auktion Muenchen\nL-081703\n';
  assert.strictEqual(leseLosCode(inhalt), 'L-081703');
});

test('lehnt ein unklares Los ab statt es zu raten', () => {
  // Am Los haengt der Einkaufspreis. Ein geratener Code ordnet Ware dem
  // falschen Einkauf zu, und das faellt spaeter niemandem mehr auf.
  for (const murks of ['', 'Los 3', 'L-8173', 'L-131703', 'NL-2699', null, undefined]) {
    assert.strictEqual(leseLosCode(murks), null, `haette ablehnen muessen: ${murks}`);
  }
});

test('laesst einen Ordner in Ruhe, solange noch fotografiert wird', () => {
  const ergebnis = pruefeOrdner({
    neuesteAufnahme: vorMinuten(5),
    losInhalt: 'L-081703',
    jetzt,
    ruhezeitMinuten: 30,
  });

  assert.strictEqual(ergebnis.bereit, false);
  assert.strictEqual(ergebnis.grund, 'ruhezeit');
});

test('gibt einen ruhigen Ordner mit Los frei', () => {
  const ergebnis = pruefeOrdner({
    neuesteAufnahme: vorMinuten(45),
    losInhalt: 'L-081703',
    jetzt,
    ruhezeitMinuten: 30,
  });

  assert.strictEqual(ergebnis.bereit, true);
  assert.strictEqual(ergebnis.losCode, 'L-081703');
});

test('sperrt einen Ordner ohne Los-Datei mit handlungsleitendem Grund', () => {
  const ergebnis = pruefeOrdner({ neuesteAufnahme: vorMinuten(45), losInhalt: null, jetzt });

  assert.strictEqual(ergebnis.bereit, false);
  assert.strictEqual(ergebnis.grund, 'los_fehlt');
  assert.match(ergebnis.meldung, /LOS\.txt/);
});

test('sperrt einen leeren Ordner ohne Fehler', () => {
  const ergebnis = pruefeOrdner({ neuesteAufnahme: null, losInhalt: 'L-081703', jetzt });

  assert.strictEqual(ergebnis.bereit, false);
  assert.strictEqual(ergebnis.grund, 'leer');
});
