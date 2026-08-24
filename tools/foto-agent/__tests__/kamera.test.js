const { test } = require('node:test');
const assert = require('node:assert');
const { erkenneKameras } = require('../lib/kamera');

// Auf dem Share liegen die Aufnahmen mehrerer Geraete in EINEM Tagesordner.
// Gemessen am 17.08.2026: IMG_1205..IMG_1265 (iPhone 13 Pro) und
// IMG_4804..IMG_4805 (zweites Geraet), zeitlich ineinander verschraenkt.
// Nach Zeit allein sortiert stuenden fremde Aufnahmen mitten in einer Serie.
//
// Die Dateinummer ist ein Zaehler JE GERAET. Die Zuordnung entsteht deshalb
// aus der Luecke zwischen den vorhandenen Nummern — nicht aus festen
// Tausenderbloecken: ein Geraet, das von IMG_1999 auf IMG_2001 zaehlt, wuerde
// dabei faelschlich zerrissen.

test('trennt zwei Geraete an der Nummernluecke', () => {
  const zuordnung = erkenneKameras(['IMG_1205.JPG', 'IMG_1206.JPG', 'IMG_4804.JPG', 'IMG_4805.JPG']);

  assert.strictEqual(zuordnung.get('IMG_1205.JPG'), zuordnung.get('IMG_1206.JPG'));
  assert.strictEqual(zuordnung.get('IMG_4804.JPG'), zuordnung.get('IMG_4805.JPG'));
  assert.notStrictEqual(zuordnung.get('IMG_1205.JPG'), zuordnung.get('IMG_4804.JPG'));
});

test('zerreisst eine Serie nicht an einem Tausenderwechsel', () => {
  const zuordnung = erkenneKameras(['IMG_1998.JPG', 'IMG_1999.JPG', 'IMG_2000.JPG', 'IMG_2001.JPG']);

  const ids = new Set([...zuordnung.values()]);
  assert.strictEqual(ids.size, 1);
});

test('trennt verschiedene Namensmuster', () => {
  const zuordnung = erkenneKameras(['IMG_1205.JPG', 'DSC_1206.JPG']);

  assert.notStrictEqual(zuordnung.get('IMG_1205.JPG'), zuordnung.get('DSC_1206.JPG'));
});

test('ordnet Dateien ohne Nummer einer eigenen Gruppe zu, ohne sie zu verlieren', () => {
  const zuordnung = erkenneKameras(['scan.jpg', 'IMG_1205.JPG']);

  assert.ok(zuordnung.has('scan.jpg'));
  assert.ok(zuordnung.get('scan.jpg'));
});

test('kommt mit einer leeren Liste zurecht', () => {
  assert.strictEqual(erkenneKameras([]).size, 0);
});
