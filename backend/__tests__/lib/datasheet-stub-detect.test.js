'use strict';

// Incident 2026-08-04 (be quiet! Silent Base 802, Produkt 242dfa4f): Der
// Stage-3-Timeout-Fallback speichert einen Stub als "Beschreibung"
// (Titel + Kategorie + Gewicht + Hersteller-Nr. aneinandergeklebt) und
// Titel-Fragmente als "Highlights". Der Stub ist >140 Zeichen und rutschte
// damit am Längen-Gate des Beschreibungs-Sicherheitsnetzes vorbei — das
// Datenblatt sah "fertig" aus, war aber unbrauchbar. Diese Lib erkennt das
// MUSTER statt nur die Länge.

const { isStubDescription, isStubHighlights } = require('../../lib/datasheet-stub-detect');

// Exakter Prod-Stub (Firestore-verifiziert, products_v2/242dfa4f…):
const BEQUIET_STUB = '<p>be quiet! Silent Base 802 Black</p><p>Kategorie: Computer, Tablets &amp; Netzwerk &gt; Computer-Komponenten &amp; -Teile &gt; Computergehäuse &amp; Zubehör &gt; Computergehäuse</p><p>Gewicht: 12.9 kg</p><p>Hersteller-Nr. : BG039</p>';

const BEQUIET_PRODUCT = {
  identification: {
    name: 'be quiet! Silent Base 802 Black',
    brand: 'Be Quiet!',
    category: 'Computer, Tablets & Netzwerk > Computer-Komponenten & -Teile > Computergehäuse & Zubehör > Computergehäuse',
  },
};

const REAL_DESCRIPTION = '<p>Die Fjällräven Färden Duffel 80 ist eine äußerst strapazierfähige und wasserabweisende Reisetasche, die für anspruchsvolle Abenteuer entwickelt wurde. Mit einem Fassungsvermögen von 80 Litern bietet sie enorm viel Platz für Ihre gesamte Ausrüstung. Das Hauptmaterial besteht aus recyceltem 500D Polyamid.</p>';

describe('isStubDescription', () => {
  it('erkennt den echten Stage-3-Fallback-Stub (be quiet, >140 Zeichen)', () => {
    expect(isStubDescription(BEQUIET_STUB, BEQUIET_PRODUCT)).toBe(true);
  });

  it('erkennt auch die Marketplace-Stub-Variante (Fjällräven-Spiegel)', () => {
    const stub = '<p>FJALLRAVEN Farden Duffel 80</p><p>Kategorie: Sport &gt; Sporttaschen &amp; Rucksäcke</p><p>Gewicht: 1.13 kg</p><p>Hersteller-Nr. : F23200285</p>';
    const product = { identification: { name: 'FJALLRAVEN Farden Duffel 80', brand: 'FJALLRAVEN' } };
    expect(isStubDescription(stub, product)).toBe(true);
  });

  it('lässt eine echte Produktbeschreibung durch', () => {
    expect(isStubDescription(REAL_DESCRIPTION, BEQUIET_PRODUCT)).toBe(false);
  });

  it('kurze/leere Beschreibungen gelten als Stub', () => {
    expect(isStubDescription('', BEQUIET_PRODUCT)).toBe(true);
    expect(isStubDescription('<p>be quiet! Silent Base 802</p>', BEQUIET_PRODUCT)).toBe(true);
  });

  it('eine echte Beschreibung, die zufällig "Kategorie" erwähnt, ist kein Stub', () => {
    const desc = '<p>Dieses Computergehäuse ist in seiner Kategorie führend: drei entkoppelte Lüfter, gedämmte Seitenteile und werkzeuglose Montage machen den Einbau leicht. Das Gewicht von 12.9 kg sorgt für einen stabilen Stand, die Hersteller-Nr. BG039 kennzeichnet die schwarze Ausführung mit Sichtfenster.</p>';
    expect(isStubDescription(desc, BEQUIET_PRODUCT)).toBe(false);
  });
});

describe('isStubHighlights', () => {
  it('erkennt Titel-Fragment-Highlights (be quiet Prod-Fall)', () => {
    const features = ['be quiet!', 'Silent Base 802 Black', 'Computergehäuse'];
    expect(isStubHighlights(features, BEQUIET_PRODUCT)).toBe(true);
  });

  it('lässt echte Highlights durch', () => {
    const features = [
      'Drei entkoppelte Pure Wings 2 Lüfter - leiser Betrieb ab Werk',
      'Gedämmte Seitenteile - reduziert Betriebsgeräusche spürbar',
      'Werkzeuglose Montage - Festplattenkäfige flexibel versetzbar',
    ];
    expect(isStubHighlights(features, BEQUIET_PRODUCT)).toBe(false);
  });

  it('leere Liste gilt als Stub', () => {
    expect(isStubHighlights([], BEQUIET_PRODUCT)).toBe(true);
  });
});
