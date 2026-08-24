'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  medienName, benutzerMedienName, waehleMedium, listeMedien,
  baueLpArgumente, waehleDrucker,
} = require('../lib/drucker');

// Am echten Geraet gemessen (2026-08-24, `lpoptions -p Versandlabel -l`).
const MEDIEN_VERSANDLABEL = [
  '103x164mm', '12x12mm', '17x54mm', '29x62mm', '4x6', '51x102mm',
  '62x100mm', 'Custom.WIDTHxHEIGHT',
];

test('medienName baut den BENANNTEN Rollennamen', () => {
  assert.strictEqual(medienName(103, 164), '103x164mm');
  assert.strictEqual(medienName(62, 100), '62x100mm');
});

test('medienName rundet auf ganze Millimeter', () => {
  assert.strictEqual(medienName(102.6, 163.8), '103x164mm');
});

test('benannte Rollengroesse gewinnt vor Custom', () => {
  // `Custom.103x164mm` ist NICHT dasselbe: der benannte Eintrag traegt die vom
  // Treiber kalibrierten nicht bedruckbaren Raender, bei Custom schaetzt CUPS
  // sie. Der Unterschied faellt als versetzter Druck auf.
  assert.strictEqual(waehleMedium(103, 164, MEDIEN_VERSANDLABEL), '103x164mm');
  assert.strictEqual(waehleMedium(62, 100, MEDIEN_VERSANDLABEL), '62x100mm');
});

test('kennt der Drucker das Mass nicht, wird Custom genutzt', () => {
  assert.strictEqual(waehleMedium(103, 164, ['12x12mm']), 'Custom.103x164mm');
  assert.strictEqual(waehleMedium(103, 164, []), 'Custom.103x164mm');
  assert.strictEqual(benutzerMedienName(62, 100), 'Custom.62x100mm');
});

test('listeMedien liest die PageSize-Zeile und entfernt den Stern', async () => {
  const execFake = (_cmd, _args, _opts, cb) => {
    cb(null, [
      'CutMedia/CutMedia: None *EndOfPage EndOfJob',
      'PageSize/Media Size: *103x164mm 12x12mm 62x100mm Custom.WIDTHxHEIGHT',
      'MediaType/MediaType: labels roll *any',
    ].join('\n'));
  };
  const medien = await listeMedien('Versandlabel', { execImpl: execFake });
  assert.ok(medien.includes('103x164mm'));
  assert.ok(medien.includes('62x100mm'));
  // Der Stern markiert die Voreinstellung und darf nicht im Namen landen.
  assert.ok(!medien.some((m) => m.startsWith('*')));
});

test('listeMedien liefert eine leere Liste statt zu werfen', async () => {
  const execFake = (_cmd, _args, _opts, cb) => cb(new Error('kein Drucker'));
  assert.deepStrictEqual(await listeMedien('Weg', { execImpl: execFake }), []);
});

test('medienName weist unsinnige Masse zurueck', () => {
  assert.throws(() => medienName(0, 100), /Ungueltiges Etikettenmass/);
  assert.throws(() => medienName(103, NaN), /Ungueltiges Etikettenmass/);
});

test('baueLpArgumente nutzt die benannte Rollengroesse des Druckers', () => {
  const args = baueLpArgumente({
    druckerName: 'Versandlabel', widthMm: 103, heightMm: 164, copies: 2, jobId: 'abc',
    vorhandeneMedien: MEDIEN_VERSANDLABEL,
  });
  assert.deepStrictEqual(args.slice(0, 6), [
    '-d', 'Versandlabel', '-n', '2', '-o', 'media=103x164mm',
  ]);
  assert.ok(args.includes('fit-to-page'));
  assert.ok(args.includes('avycloud-abc'));
  assert.strictEqual(args[args.length - 1], '--');
});

test('baueLpArgumente begrenzt die Stueckzahl', () => {
  // Ein Tippfehler darf nicht die ganze Rolle verbrauchen.
  const viele = baueLpArgumente({ druckerName: 'X', widthMm: 62, heightMm: 100, copies: 999 });
  assert.strictEqual(viele[viele.indexOf('-n') + 1], '10');
  const keine = baueLpArgumente({ druckerName: 'X', widthMm: 62, heightMm: 100, copies: 0 });
  assert.strictEqual(keine[keine.indexOf('-n') + 1], '1');
});

test('baueLpArgumente kann das Einpassen abschalten', () => {
  const args = baueLpArgumente({
    druckerName: 'X', widthMm: 103, heightMm: 164, fitToPage: false,
  });
  assert.ok(!args.includes('fit-to-page'));
});

test('baueLpArgumente verlangt einen Druckernamen', () => {
  assert.throws(
    () => baueLpArgumente({ druckerName: '', widthMm: 103, heightMm: 164 }),
    /Kein Druckername/
  );
});

test('waehleDrucker bildet die Rolle auf den Drucker ab', () => {
  const drucker = { parcel: 'Zebra', letter: 'Brother' };
  assert.strictEqual(waehleDrucker('parcel', drucker), 'Zebra');
  assert.strictEqual(waehleDrucker('letter', drucker), 'Brother');
});

test('waehleDrucker weicht NIE auf den Standarddrucker aus', () => {
  // Sonst laege ein 103-mm-Paketetikett auf der 62-mm-Briefrolle: der Barcode
  // waere abgeschnitten und das Paket bliebe im Verteilzentrum liegen.
  assert.throws(() => waehleDrucker('parcel', { letter: 'Brother' }), /kein Drucker eingerichtet/);
  assert.throws(() => waehleDrucker('letter', {}), /kein Drucker eingerichtet/);
});
