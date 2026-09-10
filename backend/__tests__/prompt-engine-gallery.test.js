/**
 * Tests für die Galerie-Prompts (services/prompt-engine.js).
 *
 * Betreiber-Auftrag 2026-09-10: vier Studio-Ansichten plus zwei Anwendungsszenen,
 * Vorlage im Screenshot. Der Blickwinkel DARF sich jetzt ändern — die Identität
 * des Artikels und sein Kleindruck dürfen es nicht.
 */

const {
  buildGalleryPrompt,
  buildStudioPrompt,
  buildLifestylePrompt,
  artikelBezeichnung,
} = require('../services/prompt-engine');

const PRODUKT = {
  wasEsIst: 'non-slip bathtub mat made of soft white plastic',
  material: 'soft PVC',
  woBenutzt: 'inside a bathtub or shower tray',
  wieBenutzt: 'laid flat on the tub floor',
  schluesselbereich: 'the suction cups on the underside',
  szeneA: 'a bare foot stepping onto the wet mat',
  szeneB: 'a person standing in a bright bathroom tub',
  lifestyleSinnvoll: true,
};

const PRODUCT = {
  identification: { brand: 'Acme', name: 'Badewanneneinlage' },
  details: { attributes: { Material: 'Kunststoff', Farbe: 'Weiß' } },
};

describe('artikelBezeichnung', () => {
  it('bevorzugt die Beschreibung AUS DEN FOTOS vor dem Datenblatt-Titel', () => {
    // Der Titel trägt Marketing-Ballast und Kategorie-Krümel; das Foto-Urteil
    // beschreibt den Gegenstand.
    expect(artikelBezeichnung(PRODUCT, PRODUKT)).toBe(PRODUKT.wasEsIst);
  });

  it('faellt ohne Bildanalyse auf das Datenblatt zurueck', () => {
    expect(artikelBezeichnung(PRODUCT, null)).toBe('Acme Badewanneneinlage');
  });

  it('hat auch ohne beides einen brauchbaren Satz', () => {
    expect(artikelBezeichnung({ identification: {} }, null)).toMatch(/reference images/);
  });
});

describe('Studio-Prompt', () => {
  const bau = (planEntry, referenceCount = 1) =>
    buildStudioPrompt({ product: PRODUCT, produkt: PRODUKT, planEntry, referenceCount });

  it('nennt den geforderten Blickwinkel', () => {
    const p = bau({ key: 'top', winkel: 'top-down view looking straight down' });
    expect(p).toContain('top-down view looking straight down');
  });

  it('richtet die Detailaufnahme auf den Schluesselbereich', () => {
    const p = bau({ key: 'detail', winkel: 'tight macro close-up' });
    expect(p).toContain('the suction cups on the underside');
    expect(p).toMatch(/macro close-up/i);
  });

  it('verlangt den e-commerce-Studiogrund aus der Betreiber-Vorlage', () => {
    const p = bau({ key: 'hero', winkel: 'three-quarter hero view' });
    expect(p).toMatch(/light-grey e-commerce gradient background/i);
    expect(p).toMatch(/no props/i);
    expect(p).toMatch(/no added text/i);
  });

  it('haelt die Produktidentitaet fest', () => {
    const p = bau({ key: 'hero', winkel: 'three-quarter hero view' });
    expect(p).toMatch(/SAME physical product/);
    expect(p).toMatch(/identical shape, proportions, colours/);
  });

  it('verlangt Beschriftungen als FORMEN kopiert, nicht neu gesetzt', () => {
    // Über 21 Messläufe am 04.09. die einzige Formulierung, die den Kleindruck
    // halbwegs hält. Kommt sie weg, erfindet das Modell Herstellernamen.
    const p = bau({ key: 'front', winkel: 'front view' });
    expect(p).toMatch(/as SHAPES/);
    expect(p).toMatch(/never read them and\s+set them again/);
    expect(p).toMatch(/rather than inventing legible words/);
  });

  it('weist auf mehrere Referenzbilder hin', () => {
    const p = bau({ key: 'front', winkel: 'front view' }, 4);
    expect(p).toContain('Images 1 to 4');
    expect(p).toMatch(/SAME physical item from different angles/);
  });

  it('ordnet Datenblattwissen den Fotos unter', () => {
    const p = bau({ key: 'front', winkel: 'front view' });
    expect(p).toMatch(/PHOTOS always win/);
  });
});

describe('Lifestyle-Prompt', () => {
  const bau = (planEntry) =>
    buildLifestylePrompt({ product: PRODUCT, produkt: PRODUKT, planEntry, referenceCount: 2 });

  it('uebernimmt die Szene aus der Bildanalyse', () => {
    const p = bau({ key: 'inuse', szene: PRODUKT.szeneA });
    expect(p).toContain(PRODUKT.szeneA);
    expect(p).toContain(PRODUKT.woBenutzt);
  });

  it('verlangt eine echte Anwendungssituation ohne Fremdmarken', () => {
    const p = bau({ key: 'scene', szene: PRODUKT.szeneB });
    expect(p).toMatch(/lifestyle photograph/i);
    expect(p).toMatch(/no other branded products/i);
    expect(p).toMatch(/no added text/i);
  });

  it('haelt auch hier die Produktidentitaet fest', () => {
    const p = bau({ key: 'inuse', szene: PRODUKT.szeneA });
    expect(p).toMatch(/SAME physical product/);
    expect(p).toMatch(/as SHAPES/);
  });

  it('verlangt, dass der Artikel Hauptmotiv bleibt', () => {
    const p = bau({ key: 'inuse', szene: PRODUKT.szeneA });
    expect(p).toMatch(/main subject/);
    expect(p).toMatch(/never hidden/);
  });

  it('kommt ohne Szenentext trotzdem zu einem brauchbaren Satz', () => {
    const p = bau({ key: 'inuse' });
    expect(p).toContain(PRODUKT.wieBenutzt);
  });
});

describe('buildGalleryPrompt — Weiche', () => {
  it('waehlt nach art den richtigen Bauer', () => {
    const studio = buildGalleryPrompt({
      product: PRODUCT, produkt: PRODUKT,
      planEntry: { art: 'studio', key: 'hero', winkel: 'three-quarter hero view' },
      referenceCount: 1,
    });
    const life = buildGalleryPrompt({
      product: PRODUCT, produkt: PRODUKT,
      planEntry: { art: 'lifestyle', key: 'inuse', szene: PRODUKT.szeneA },
      referenceCount: 1,
    });
    expect(studio).toMatch(/e-commerce gradient background/i);
    expect(life).toMatch(/lifestyle photograph/i);
  });

  it('behandelt eine fehlende art als Studio', () => {
    const p = buildGalleryPrompt({
      product: PRODUCT, produkt: PRODUKT,
      planEntry: { key: 'front', winkel: 'front view' }, referenceCount: 1,
    });
    expect(p).toMatch(/e-commerce gradient background/i);
  });
});
