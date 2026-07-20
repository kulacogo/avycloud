'use strict';

// Vitest CJS (globals:true — kein require('vitest')).
// Pure Helpers: kein Firestore, kein Netz — direkt requirebar.

const {
  parseGermanNumber,
  parseLenientWeightKg,
  extractVolumeLiters,
  volumeToShippingKg,
  contentToShippingKg,
  areaWeightToShippingKg,
  readCanonicalWeightKg,
  isPlausibleShippingKg,
  clampShippingKg,
  deriveWeightHeuristic,
  isWeightAliasKey,
} = require('../lib/weight-derive');

const { buildCandidates, mergeSpecificsUnion, hasWeightAspect } = require('../scripts/ebay-push-weights');
const { buildGeminiPrompt } = require('../scripts/backfill-weights-instock');

describe('parseGermanNumber', () => {
  it('parst deutsche Formate', () => {
    expect(parseGermanNumber('16')).toBe(16);
    expect(parseGermanNumber('5,07')).toBe(5.07);
    expect(parseGermanNumber('1.300')).toBe(1300);
    expect(parseGermanNumber('1.234,56')).toBe(1234.56);
    expect(parseGermanNumber('')).toBe(null);
    expect(parseGermanNumber('abc')).toBe(null);
  });
});

describe('parseLenientWeightKg', () => {
  it('parst reale Prod-Strings (Datenprobe 2026-07-19)', () => {
    expect(parseLenientWeightKg('ca. 16 kg')).toBe(16);
    expect(parseLenientWeightKg('5,07 kg (pro Stück)')).toBe(5.07);
    expect(parseLenientWeightKg('ca. 360 g')).toBeCloseTo(0.36);
    expect(parseLenientWeightKg('15+ kg')).toBe(15);
    expect(parseLenientWeightKg('14 Unzen')).toBeCloseTo(0.397, 2);
    expect(parseLenientWeightKg('1.300 g')).toBeCloseTo(1.3);
  });

  it('lehnt Flächengewichte und einheitenlose Werte ab', () => {
    expect(parseLenientWeightKg('35 g/m²')).toBe(null);
    expect(parseLenientWeightKg('ca. 1300 g/m2')).toBe(null);
    expect(parseLenientWeightKg('ca. 0,25')).toBe(null);
    expect(parseLenientWeightKg('Extrem leicht')).toBe(null);
    expect(parseLenientWeightKg('Gering')).toBe(null);
    expect(parseLenientWeightKg(null)).toBe(null);
  });

  it('nimmt Numbers direkt (kg-Konvention)', () => {
    expect(parseLenientWeightKg(2.5)).toBe(2.5);
    expect(parseLenientWeightKg(0)).toBe(null);
    expect(parseLenientWeightKg(NaN)).toBe(null);
  });

  it('minKg filtert Chassis-/Größen-Codes im Titel-Kontext', () => {
    // 'A6 C7 4G' darf nicht als 4 Gramm durchgehen
    expect(parseLenientWeightKg('ATEC Querlenker für Audi A4 B8 A6 C7 4G', { minKg: 0.05 })).toBe(null);
    // 'Gr. 48' (Größe) darf nicht als Gramm geparst werden ('gr' ist keine Einheit)
    expect(parseLenientWeightKg('Laufschuhe Gr. 48 US 12,5 Gr. 46')).toBe(null);
    // echte Titel-Gewichte bleiben erhalten
    expect(parseLenientWeightKg('Reparatur Creme 100g', { minKg: 0.05 })).toBeCloseTo(0.1);
  });
});

describe('extractVolumeLiters + volumeToShippingKg', () => {
  it('zieht Volumen-Literale aus Titel/Attributen', () => {
    expect(extractVolumeLiters('MANNOL AF12+ Kühlerfrostschutz 20L Fertiggemisch')).toBe(20);
    expect(extractVolumeLiters('100 ml')).toBeCloseTo(0.1);
    expect(extractVolumeLiters('2x5L Kanister')).toBe(10);
    expect(extractVolumeLiters('kein Volumen')).toBe(null);
  });

  it('rechnet Volumen in realistisches Versandgewicht um', () => {
    expect(volumeToShippingKg(20)).toBeCloseTo(21.1);
    expect(volumeToShippingKg(0.1)).toBeCloseTo(0.205);
    expect(volumeToShippingKg(0)).toBe(null);
  });
});

describe('contentToShippingKg', () => {
  it('schlägt Verpackung auf Inhaltsgewicht auf', () => {
    expect(contentToShippingKg(0.1)).toBeCloseTo(0.16);
    expect(contentToShippingKg(5)).toBeCloseTo(5.55);
  });
});

describe('areaWeightToShippingKg', () => {
  it('rechnet Flächengewicht × Maße (Sichtschutz-Fall)', () => {
    // 1300 g/m² × 100x700 cm = 7 m² → 9.1 kg Inhalt → ~10.2 kg mit Verpackung
    const kg = areaWeightToShippingKg('ca. 1300 g/m²', 'Polyrattan Balkonsichtschutz 100x700 cm');
    expect(kg).toBeCloseTo(10.21, 1);
  });

  it('liefert null ohne Maße oder ohne g/m²', () => {
    expect(areaWeightToShippingKg('ca. 1300 g/m²', 'ohne Maße')).toBe(null);
    expect(areaWeightToShippingKg('1300 g', '100x700 cm')).toBe(null);
  });
});

describe('readCanonicalWeightKg', () => {
  it('liest die kanonische Numbers-only-Kette', () => {
    expect(readCanonicalWeightKg({ details: { weight: 2.5 } })).toBe(2.5);
    expect(readCanonicalWeightKg({ details: { attributes: { 'Gewicht (kg)': 3 } } })).toBe(3);
    expect(readCanonicalWeightKg({ details: { attributes: { 'Gewicht (kg)': 'ca. 16 kg' } } })).toBe(null);
    expect(readCanonicalWeightKg({})).toBe(null);
  });
});

describe('clampShippingKg', () => {
  it('rundet, hebt Minima, lehnt >50 kg ab (Gramm-Falle im Save-Parser)', () => {
    expect(clampShippingKg(1.234)).toBe(1.23);
    expect(clampShippingKg(0.004)).toBe(0.02);
    expect(clampShippingKg(50)).toBe(50);
    expect(clampShippingKg(50.1)).toBe(null);
    expect(clampShippingKg(60)).toBe(null);
    expect(clampShippingKg(0)).toBe(null);
  });

  it('isPlausibleShippingKg matcht das Fenster', () => {
    expect(isPlausibleShippingKg(0.02)).toBe(true);
    expect(isPlausibleShippingKg(50)).toBe(true);
    expect(isPlausibleShippingKg(0.01)).toBe(false);
    expect(isPlausibleShippingKg(51)).toBe(false);
  });
});

describe('deriveWeightHeuristic', () => {
  it('Tier 1: parst Gewichts-Alias-Attribut (FAMEX-Koffer-Fall)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'FAMEX 418-18 Profi Werkzeugkoffer bestückt 195-tlg' },
      details: { attributes: { 'Gewicht (kg)': 'ca. 16 kg' } },
    });
    expect(r).toMatchObject({ kg: 16, method: 'attr_parse' });
  });

  it('Tier 2: Inhaltsgewicht im Titel (Creme-100g-Fall)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'WRMOO Scheinwerfer Reparatur Creme 100g' },
      details: { attributes: {} },
    });
    expect(r.method).toBe('title_weight');
    expect(r.kg).toBeCloseTo(0.16);
  });

  it('Tier 3: Volumen aus Titel (MANNOL-20L-Fall)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'MANNOL AF12+ Kühlerfrostschutz 20L Fertiggemisch' },
      details: { attributes: { Inhalt: '20 L' } },
    });
    expect(r.method).toBe('volume');
    expect(r.kg).toBeCloseTo(21.1);
  });

  it('Tier 4: Flächengewicht × Maße (Sichtschutz-Fall)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'Polyrattan Balkonsichtschutz 100x700 cm' },
      details: { attributes: { 'Flächengewicht': 'ca. 1300 g/m²' } },
    });
    expect(r.method).toBe('area_weight');
    expect(r.kg).toBeGreaterThan(9);
  });

  it('null ohne Signal (Querlenker-Fall → Gemini-Stufe)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'ATEC Querlenker Vorne Rechts Unten Alu Audi A4 B8' },
      details: { attributes: { Einbauposition: 'Vorne rechts' } },
    });
    expect(r).toBe(null);
  });

  it('Chassis-Code "4G" im Titel wird NICHT als Gewicht geparst', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'ATEC Querlenker Vorne Rechts Unten Alu für Audi A4 B8 A6 C7 4G' },
      details: { attributes: {} },
    });
    expect(r).toBe(null);
  });

  it('Hubraum-Literal "2.0L TDI" wird NICHT als Gebinde-Volumen gewertet', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'Bremssattel für VW Passat B8 2.0L TDI' },
      details: { attributes: {} },
    });
    expect(r).toBe(null);
  });

  it('Flüssigkeits-Titel mit Volumen bleibt Tier 3 (Kanister-Fall)', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'MANNOL AF12+ Kühlerfrostschutz G12+ Rot 20L Fertiggemisch' },
      details: { attributes: {} },
    });
    expect(r.method).toBe('volume');
    expect(r.kg).toBeCloseTo(21.1);
  });

  it('Tragkraft/Widerstand/Grammatur im Titel wird NICHT als Gewicht gewertet', () => {
    // Tragkraft eines Ständers
    expect(deriveWeightHeuristic({
      identification: { name: 'Bracwiser Monitorständer Höhenverstellbar Metall Schwarz 20kg' },
      details: { attributes: {} },
    })).toBe(null);
    // Zugwiderstand eines Expanders
    expect(deriveWeightHeuristic({
      identification: { name: 'ProsourceFit Widerstandsband Tube Lila 9-13,6 kg Expander' },
      details: { attributes: {} },
    })).toBe(null);
    // Papier-Grammatur (80g = g/m², eine 500er-Packung wiegt ~2,5 kg)
    expect(deriveWeightHeuristic({
      identification: { name: 'HP Kopierpapier A4 80g 500 Blatt Druckerpapier Weiß' },
      details: { attributes: {} },
    })).toBe(null);
    // Inhaltsstoff-Titel bleiben Tier 2
    const paint = deriveWeightHeuristic({
      identification: { name: 'Sportplatz Markierfarbe Extra-Weiß 14kg 9L Rasen Konzentrat' },
      details: { attributes: {} },
    });
    expect(paint.method).toBe('title_weight');
    expect(paint.kg).toBeCloseTo(15.45);
  });

  it('Markisen (Gestell!) und Bücher fallen NICHT ins Flächengewicht-Tier', () => {
    expect(deriveWeightHeuristic({
      identification: { name: 'HOMEDEMO Klemmmarkise 250x125 cm Anthrazit Balkonmarkise' },
      details: { attributes: { Material: '100% Polyester (190 g/m²) mit PU-Beschichtung' } },
    })).toBe(null);
    expect(deriveWeightHeuristic({
      identification: { name: 'Clever Fox Self-Care Journal PRO Lila 17,8x25 cm' },
      details: { attributes: { Papier: '120 g/m²' } },
    })).toBe(null);
  });

  it('Flächengewicht-Attribut wird NICHT als Versandgewicht geparst', () => {
    const r = deriveWeightHeuristic({
      identification: { name: 'Stoff Meterware' },
      details: { attributes: { Gewicht: '35 g/m²' } },
    });
    expect(r).toBe(null);
  });
});

describe('isWeightAliasKey', () => {
  it('matcht exakte Alias-Keys aus firestore.js, nicht Flächengewicht', () => {
    expect(isWeightAliasKey('Gewicht (kg)')).toBe(true);
    expect(isWeightAliasKey('Versandgewicht')).toBe(true);
    expect(isWeightAliasKey('Flächengewicht')).toBe(false);
    expect(isWeightAliasKey('Gewicht pro m²')).toBe(false);
  });
});

describe('ebay-push-weights buildCandidates', () => {
  const mkProduct = (id, sku, qty, weight) => ({
    id,
    identification: { sku },
    inventory: { quantity: qty },
    details: { weight },
  });

  it('filtert auf Bestand, Gewicht und vorhandenes Listing', () => {
    const products = [
      mkProduct('p1', 'SKU-1', 2, 1.5),      // ok, 2 Kandidaten-itemIds
      mkProduct('p2', 'SKU-2', 0, 2),        // kein Bestand
      mkProduct('p3', 'SKU-3', 1, null),     // kein Gewicht
      mkProduct('p4', 'SKU-4', 1, 60),       // >50kg → clamp lehnt ab
      mkProduct('p5', 'SKU-5', 1, 3),        // kein Listing
    ];
    const skuToItemIds = new Map([
      ['SKU-1', ['111', '110']], ['SKU-2', ['222']], ['SKU-3', ['333']], ['SKU-4', ['444']],
    ]);
    const { candidates, skipped } = buildCandidates(products, skuToItemIds, { minQty: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].itemIds).toEqual(['111', '110']);
    expect(candidates[0].weightKg).toBe(1.5);
    const reasons = skipped.map((s) => s.reason);
    expect(reasons).toContain('no_valid_weight');
  });

  it('respektiert skip-file (SKU oder itemId) und ops.ebay.itemId-Fallback', () => {
    const p = mkProduct('p1', 'SKU-1', 1, 2);
    p.ops = { ebay: { itemId: '999' } };
    const { candidates } = buildCandidates([p], new Map(), { minQty: 1 });
    expect(candidates[0].itemIds).toEqual(['999']);

    const { candidates: c2, skipped: s2 } = buildCandidates([p], new Map(), {
      minQty: 1,
      skipKeys: new Set(['SKU-1']),
    });
    expect(c2).toEqual([]);
    expect(s2[0].reason).toBe('skip_file');

    const { candidates: c3 } = buildCandidates([p], new Map(), {
      minQty: 1,
      skipKeys: new Set(['999']),
    });
    expect(c3).toEqual([]);
  });
});

describe('ebay-push-weights mergeSpecificsUnion + hasWeightAspect', () => {
  it('lokal gewinnt pro Key, live-only bleibt erhalten (additiv)', () => {
    const { specifics, liveKept } = mergeSpecificsUnion(
      { 'Gewicht (kg)': '2.5', Marke: 'Bosch' },
      { Marke: 'BOSCH GmbH', Farbe: 'Rot' },
    );
    expect(specifics['Gewicht (kg)']).toBe('2.5');
    expect(specifics.Marke).toBe('Bosch');
    expect(specifics.Farbe).toBe('Rot');
    expect(liveKept).toBe(1);
  });

  it('45er-Cap: lokale zuerst, überzählige live-only werden gedroppt', () => {
    const local = {};
    for (let i = 0; i < 44; i += 1) local[`L${i}`] = 'x';
    local['Gewicht (kg)'] = '1';
    const live = { A: '1', B: '2', C: '3' };
    const { specifics, dropped } = mergeSpecificsUnion(local, live);
    expect(Object.keys(specifics)).toHaveLength(45);
    expect(specifics['Gewicht (kg)']).toBe('1');
    expect(dropped).toBe(3);
  });

  it('hasWeightAspect erkennt Gewichts-Keys mit Wert (auch Array)', () => {
    expect(hasWeightAspect({ 'Gewicht (kg)': ['21.1'] })).toBe(true);
    expect(hasWeightAspect({ 'Eigengewicht (kg)': 3 })).toBe(true);
    expect(hasWeightAspect({ 'Gewicht (kg)': '' })).toBe(false);
    expect(hasWeightAspect({ Farbe: 'Rot' })).toBe(false);
  });
});

describe('ebay-fix-weight-failures Helpers', () => {
  const { extractMissingAspectNamesFr, isMpnAspect, mergeSpecificsWithRequired } = require('../scripts/ebay-fix-weight-failures');

  it('extrahiert fehlende Pflicht-Aspects aus FR-Meldungen (BEFR-Konto)', () => {
    expect(extractMissingAspectNamesFr(
      "La caractéristique de l'objet obligatoire Type est manquante. Ajoutez Type et une valeur correspondante à l'annonce et réessayez.",
    )).toContain('Type');
    expect(extractMissingAspectNamesFr(
      "La caractéristique de l'objet obligatoire Numéro de pièce fabricant est manquante. Ajoutez Numéro de pièce fabricant et une valeur correspondante à l'annonce et réessayez.",
    )).toContain('Numéro de pièce fabricant');
    expect(extractMissingAspectNamesFr('Systemfehler. Bitte versuchen Sie es erneut.')).toEqual([]);
  });

  it('isMpnAspect erkennt MPN-Varianten', () => {
    expect(isMpnAspect('Numéro de pièce fabricant')).toBe(true);
    expect(isMpnAspect('Herstellernummer')).toBe(true);
    expect(isMpnAspect('Type')).toBe(false);
  });

  it('mergeSpecificsWithRequired: Pflicht + Gewicht überleben den Cap', () => {
    const local = {};
    for (let i = 0; i < 44; i += 1) local[`L${i}`] = 'x';
    local['Gewicht (kg)'] = '2';
    const merged = mergeSpecificsWithRequired({ Type: 'Bremsscheibe' }, local, { LiveOnly: 'y' });
    expect(Object.keys(merged).length).toBeLessThanOrEqual(45);
    expect(merged.Type).toBe('Bremsscheibe');
    expect(merged['Gewicht (kg)']).toBe('2');
  });
});

describe('backfill buildGeminiPrompt', () => {
  it('enthält Titel, Marke, Kategorie und Gramm-Anweisung', () => {
    const prompt = buildGeminiPrompt({
      identification: { name: 'Danfoss Kugelhahn DN15', brand: 'Danfoss', category: 'Küchenarmaturen' },
      details: { attributes: { Material: 'Messing' } },
    });
    expect(prompt).toContain('Danfoss Kugelhahn DN15');
    expect(prompt).toContain('Küchenarmaturen');
    expect(prompt).toContain('Material: Messing');
    expect(prompt).toContain('GANZZAHLIGEN GRAMM');
  });
});
