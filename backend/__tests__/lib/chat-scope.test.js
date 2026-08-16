'use strict';

/**
 * Schnellaktionen muessen ihren Rahmen einhalten.
 *
 * Die Knoepfe im Chat setzen einen engen Rahmen: "Preischeck" = pricing,
 * "Titel verbessern" = title, "EAN / GTIN finden" = gtin. Die heute laufende
 * V2-Pipeline hat diesen Rahmen zwar entgegengenommen und ins Prompt
 * geschrieben, ihn aber NIE durchgesetzt: der Bereinigungsschritt las die
 * uebergebene `scope`-Angabe nirgends wieder aus.
 *
 * Folge: ein Klick auf "Preischeck" konnte Titel, Beschreibung, Highlights,
 * Merkmale, Marke und GPSR mitschreiben — und der Mensch konnte nichts davon
 * abwaehlen, weil alles in EINER Karte steckt.
 *
 * Die alte Legacy-Pipeline setzt den Rahmen seit jeher hart durch. Diese Regeln
 * liegen jetzt an EINER Stelle, damit die beiden Wege nicht auseinanderlaufen.
 */

const { parseScopeSet, buildScopeAllowMap } = require('../../lib/chat-scope');

describe('parseScopeSet', () => {
  it('ohne Angabe ist der Rahmen leer (= alles erlaubt)', () => {
    expect(parseScopeSet(null).size).toBe(0);
    expect(parseScopeSet('').size).toBe(0);
  });

  it('erkennt "all" und "full" als Voll-Rahmen', () => {
    expect(parseScopeSet('all').has('datasheet')).toBe(true);
    expect(parseScopeSet('full').has('datasheet')).toBe(true);
  });

  it('fasst Barcode-Schreibweisen zusammen', () => {
    for (const wort of ['ean', 'barcode', 'barcodes']) {
      expect(parseScopeSet(wort).has('gtin')).toBe(true);
    }
  });

  it('fasst Merkmals-Kurzformen zusammen', () => {
    expect(parseScopeSet('attr').has('attributes')).toBe(true);
    expect(parseScopeSet('attrs').has('attributes')).toBe(true);
  });

  it('versteht mehrere Angaben mit verschiedenen Trennzeichen', () => {
    const s = parseScopeSet('title, pricing|gpsr');
    expect(s.has('title')).toBe(true);
    expect(s.has('pricing')).toBe(true);
    expect(s.has('gpsr')).toBe(true);
  });
});

describe('buildScopeAllowMap', () => {
  it('ohne Rahmen ist alles erlaubt', () => {
    const a = buildScopeAllowMap(null);
    expect(a.title && a.pricing && a.gpsr && a.description && a.attributes).toBe(true);
  });

  it('Preischeck erlaubt NUR den Preis', () => {
    const a = buildScopeAllowMap('pricing');
    expect(a.pricing).toBe(true);
    expect(a.title).toBe(false);
    expect(a.description).toBe(false);
    expect(a.highlights).toBe(false);
    expect(a.attributes).toBe(false);
    expect(a.gpsr).toBe(false);
  });

  it('Titel-Aktion erlaubt NUR den Titel', () => {
    const a = buildScopeAllowMap('title');
    expect(a.title).toBe(true);
    expect(a.pricing).toBe(false);
    expect(a.gpsr).toBe(false);
  });

  it('EAN-Aktion erlaubt NUR die Codes', () => {
    const a = buildScopeAllowMap('gtin');
    expect(a.barcodes).toBe(true);
    expect(a.title).toBe(false);
    expect(a.pricing).toBe(false);
  });

  it('Notizen sind immer erlaubt — sie aendern keine Produktdaten', () => {
    expect(buildScopeAllowMap('pricing').notes).toBe(true);
  });

  it('Marke und SKU haengen am Voll-Rahmen, nicht an Einzelaktionen', () => {
    expect(buildScopeAllowMap('title').brand).toBe(false);
    expect(buildScopeAllowMap('all').brand).toBe(true);
  });
});
