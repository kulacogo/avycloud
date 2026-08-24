const { test } = require('node:test');
const assert = require('node:assert');
const { zerlegeNachAufnahme } = require('../lib/gruppierung');

// Der Vorzerteiler entscheidet NICHT, was ein Produkt ist — das macht die
// Bilderkennung (POST /api/v2/group-images). Er soll nur handliche Bloecke
// bilden und dabei niemals mitten durch eine Fotoserie schneiden.
//
// Gemessen am 17.08.2026 (63 Fotos, zwei Kameras): Luecken zwischen zwei
// Aufnahmen 2 s bis 27,6 min, Median 12 s. Eine Schwelle von 30 s ergaebe 22
// Bloecke, 60 s ergaebe 14, 90 s ergaebe 11 — die Zeit allein sagt also nicht,
// wo ein Produkt endet. Deshalb trennt der Vorzerteiler nur bei GROSSEN
// Luecken, wo die Trennung sicher ist.

const foto = (name, kamera, minuten) => ({
  pfad: `/RAW/${name}`,
  kamera,
  zeit: new Date(2026, 7, 17, 13, minuten, 0),
});

test('trennt Fotos verschiedener Kameras', () => {
  // Zwei Mitarbeiter fotografieren gleichzeitig verschiedene Produkte; nach
  // Zeit sortiert stehen ihre Aufnahmen abwechselnd nebeneinander.
  const bloecke = zerlegeNachAufnahme([
    foto('a1.jpg', 'A', 0),
    foto('b1.jpg', 'B', 1),
    foto('a2.jpg', 'A', 2),
  ]);

  const kameras = bloecke.map((b) => new Set(b.map((f) => f.kamera)));
  for (const k of kameras) assert.strictEqual(k.size, 1);
});

test('trennt bei einer grossen Luecke', () => {
  const bloecke = zerlegeNachAufnahme(
    [foto('a1.jpg', 'A', 0), foto('a2.jpg', 'A', 1), foto('a3.jpg', 'A', 40)],
    { maxLueckeMinuten: 10 },
  );

  assert.strictEqual(bloecke.length, 2);
  assert.deepStrictEqual(bloecke[1].map((f) => f.pfad), ['/RAW/a3.jpg']);
});

test('trennt NICHT bei einer kleinen Luecke', () => {
  // Eine Pause von zwei Minuten kann mitten in einer Produktserie liegen
  // (Karton drehen, Etikett suchen). Die Bilderkennung entscheidet das.
  const bloecke = zerlegeNachAufnahme(
    [foto('a1.jpg', 'A', 0), foto('a2.jpg', 'A', 2)],
    { maxLueckeMinuten: 10 },
  );

  assert.strictEqual(bloecke.length, 1);
});

test('teilt einen zu grossen Block an seiner groessten inneren Luecke', () => {
  // Nicht einfach nach Anzahl abschneiden: an der groessten Luecke ist die
  // Wahrscheinlichkeit am hoechsten, dass dort ohnehin ein Produktwechsel liegt.
  const fotos = [
    foto('a1.jpg', 'A', 0), foto('a2.jpg', 'A', 1),
    foto('a3.jpg', 'A', 8),   // groesste innere Luecke: 7 Minuten
    foto('a4.jpg', 'A', 9),
  ];

  const bloecke = zerlegeNachAufnahme(fotos, { maxLueckeMinuten: 30, maxProBlock: 3 });

  assert.strictEqual(bloecke.length, 2);
  assert.deepStrictEqual(bloecke[0].map((f) => f.pfad), ['/RAW/a1.jpg', '/RAW/a2.jpg']);
  assert.deepStrictEqual(bloecke[1].map((f) => f.pfad), ['/RAW/a3.jpg', '/RAW/a4.jpg']);
});

test('haelt jeden Block chronologisch', () => {
  const bloecke = zerlegeNachAufnahme([foto('a3.jpg', 'A', 5), foto('a1.jpg', 'A', 0), foto('a2.jpg', 'A', 2)]);

  assert.deepStrictEqual(bloecke[0].map((f) => f.pfad), ['/RAW/a1.jpg', '/RAW/a2.jpg', '/RAW/a3.jpg']);
});

test('verliert Fotos ohne Aufnahmezeit nicht', () => {
  // Ein unlesbares EXIF darf ein Foto nicht verschwinden lassen — es bliebe
  // sonst fuer immer in RAW liegen und wuerde bei jedem Lauf neu betrachtet.
  const ohneZeit = { pfad: '/RAW/kaputt.jpg', kamera: 'A', zeit: null };
  const bloecke = zerlegeNachAufnahme([foto('a1.jpg', 'A', 0), ohneZeit]);

  const allePfade = bloecke.flat().map((f) => f.pfad);
  assert.ok(allePfade.includes('/RAW/kaputt.jpg'));
  assert.strictEqual(allePfade.length, 2);
});

test('kommt mit einer leeren Liste zurecht', () => {
  assert.deepStrictEqual(zerlegeNachAufnahme([]), []);
});
