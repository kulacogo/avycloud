/**
 * Tests für lib/gemini-image-models.js — EINE Quelle für Bildmodellnamen.
 *
 * Kernpunkt: der in CLAUDE.md dokumentierte Default `gemini-3-pro-image-preview`
 * ist seit dem 25.06.2026 ABGESCHALTET. Vorher führten drei Dateien je einen
 * eigenen Default-String und niemand merkte, dass einer davon tot war.
 */

const {
  resolveImageModel,
  studioImageModelChain,
  variantImageModelChain,
  maxObjectReferences,
  resolveImageSize,
  DEFAULT_QUALITY_MODEL,
  RETIRED_IMAGE_MODELS,
} = require('../lib/gemini-image-models');

const ENV_KEYS = [
  'STUDIO_IMAGE_MODEL',
  'STUDIO_IMAGE_FALLBACK_MODEL',
  'GEMINI_IMAGE_MODEL',
  'VARIANT_IMAGE_MODEL',
  'VARIANT_IMAGE_FALLBACK_MODEL',
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('resolveImageModel', () => {
  it('ersetzt jedes abgeschaltete Modell durch seinen Nachfolger', () => {
    for (const [tot, nachfolger] of Object.entries(RETIRED_IMAGE_MODELS)) {
      expect(resolveImageModel(tot)).toBe(nachfolger);
    }
  });

  it('ersetzt insbesondere den in CLAUDE.md dokumentierten Studio-Default', () => {
    expect(resolveImageModel('gemini-3-pro-image-preview')).toBe('gemini-3-pro-image');
  });

  it('laesst unbekannte Modellnamen unangetastet (fail-open fuer neue Google-Modelle)', () => {
    expect(resolveImageModel('gemini-9-super-image')).toBe('gemini-9-super-image');
  });

  it('faellt bei leerem Wert auf den uebergebenen Default zurueck', () => {
    expect(resolveImageModel('', 'x-modell')).toBe('x-modell');
    expect(resolveImageModel(null)).toBe(DEFAULT_QUALITY_MODEL);
    expect(resolveImageModel(undefined)).toBe(DEFAULT_QUALITY_MODEL);
  });
});

describe('Modellketten', () => {
  it('nutzt ohne ENV das staerkste Modell zuerst', () => {
    expect(studioImageModelChain()[0]).toBe(DEFAULT_QUALITY_MODEL);
    expect(variantImageModelChain()[0]).toBe(DEFAULT_QUALITY_MODEL);
  });

  it('heilt einen ENV-Pin auf ein totes Modell, statt ihn blind zu uebernehmen', () => {
    process.env.STUDIO_IMAGE_MODEL = 'gemini-3-pro-image-preview';
    expect(studioImageModelChain()[0]).toBe('gemini-3-pro-image');
  });

  it('respektiert einen gueltigen ENV-Pin (Betriebs-Notbremse bleibt moeglich)', () => {
    process.env.VARIANT_IMAGE_MODEL = 'gemini-2.5-flash-image';
    expect(variantImageModelChain()[0]).toBe('gemini-2.5-flash-image');
  });

  it('entdoppelt die Kette, wenn Primaer- und Fallback-Modell gleich sind', () => {
    process.env.STUDIO_IMAGE_MODEL = 'gemini-3.1-flash-image';
    process.env.STUDIO_IMAGE_FALLBACK_MODEL = 'gemini-3.1-flash-image';
    expect(studioImageModelChain()).toEqual(['gemini-3.1-flash-image']);
  });

  it('liefert immer mindestens ein Modell', () => {
    expect(studioImageModelChain().length).toBeGreaterThan(0);
    expect(variantImageModelChain().length).toBeGreaterThan(0);
  });
});

describe('maxObjectReferences', () => {
  it('kennt die dokumentierten, rollenbezogenen Obergrenzen', () => {
    expect(maxObjectReferences('gemini-3-pro-image')).toBe(6);
    expect(maxObjectReferences('gemini-3.1-flash-image')).toBe(10);
  });

  it('gibt fuer unbekannte Modelle den vorsichtigsten Wert', () => {
    expect(maxObjectReferences('gemini-9-super-image')).toBe(3);
  });

  it('rechnet einen toten Modellnamen zuerst auf seinen Nachfolger um', () => {
    expect(maxObjectReferences('gemini-3-pro-image-preview')).toBe(6);
  });
});

describe('resolveImageSize', () => {
  it('sendet KEINE Groesse an ein Modell, das sie nicht fuehrt', () => {
    // Ein unbekanntes Konfigurationsfeld ignoriert Gemini stillschweigend — das
    // Bild kaeme in 1K zurueck und niemand merkte den Fehler.
    expect(resolveImageSize('gemini-2.5-flash-image', '2K')).toBeNull();
  });

  it('reicht eine unterstuetzte Groesse durch', () => {
    expect(resolveImageSize('gemini-3-pro-image', '2K')).toBe('2K');
    expect(resolveImageSize('gemini-3.1-flash-image', '512')).toBe('512');
  });

  it('nimmt die groesste verfuegbare Groesse, statt gar keine zu senden', () => {
    expect(resolveImageSize('gemini-3.1-flash-lite-image', '4K')).toBe('1K');
  });

  it('sendet nichts, wenn nichts angefordert wurde', () => {
    expect(resolveImageSize('gemini-3-pro-image', '')).toBeNull();
    expect(resolveImageSize('gemini-3-pro-image', null)).toBeNull();
  });
});
