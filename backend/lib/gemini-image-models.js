'use strict';

/**
 * gemini-image-models.js
 *
 * EINE Quelle für Gemini-BILDmodellnamen — dasselbe Muster wie `lib/model-select.js`
 * für Textmodelle, das dort ausdrücklich `*-image*` ausnimmt und Bildmodelle damit
 * ungeregelt liess. Vorher führten drei Dateien je einen eigenen Default-String
 * (`vertex-ai.js`, `image-studio.js`, CLAUDE.md) und alle drei widersprachen sich.
 *
 * WARUM DAS AKUT WAR (recherchiert 2026-09-02 gegen ai.google.dev/gemini-api/docs/deprecations):
 *   - `gemini-3-pro-image-preview` — Abschaltung 25.06.2026. Der in CLAUDE.md als
 *     Default dokumentierte STUDIO_IMAGE_MODEL zeigte also über zwei Monate lang auf
 *     ein TOTES Modell. Jeder Studio-Foto-Aufruf verbrannte den Primärversuch in einen
 *     Fehler und lief in die Fallback-Kette — sichtbar wurde das nie.
 *   - `gemini-2.5-flash-image` — Legacy, Abkündigung läuft. Das ist der Default, auf
 *     dem die Variantenerzeugung heute noch fährt.
 *   - Aktuell GA: `gemini-3-pro-image` (Nano Banana Pro), `gemini-3.1-flash-image`,
 *     `gemini-3.1-flash-lite-image`.
 *
 * Namen werden hier NICHT normalisiert wie bei den Textmodellen — ein Bildmodell-Pin
 * per ENV ist ein legitimer Betriebs-Eingriff (Notbremse bei Google-seitigen Störungen).
 * Diese Datei liefert nur die richtigen DEFAULTS und eine Warnung bei toten Namen.
 */

// Modelle, deren Abschaltung belegt ist. Wert = Nachfolger.
// Object.create(null): ein Nachschlag mit 'toString' oder 'constructor' lieferte
// sonst eine FUNKTION aus der Prototypkette statt undefined — und die waere als
// Modellname bzw. Referenz-Obergrenze weitergereicht worden.
const RETIRED_IMAGE_MODELS = Object.freeze(
  Object.assign(Object.create(null), {
    'gemini-3-pro-image-preview': 'gemini-3-pro-image',
    'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
    'gemini-2.0-flash-preview-image-generation': 'gemini-3.1-flash-image',
  })
);

// Bestes Modell für identitätstreue Produktfotografie (Reasoning-Kern, bis 6 Objekt-
// Referenzen mit hoher Treue, 1K/2K/4K). Genau die Eigenschaften, die wir brauchen.
const DEFAULT_QUALITY_MODEL = 'gemini-3-pro-image';
// Schnelleres Arbeitspferd für Massenläufe (bis 10 Objekt-Referenzen, 512/1K/2K/4K).
const DEFAULT_FAST_MODEL = 'gemini-3.1-flash-image';

/**
 * Maximale Anzahl OBJEKT-Referenzbilder je Modell (dokumentierte, rollenbezogene
 * Grenzen — nicht die Gesamtzahl von 14, die auch Personen und Stilreferenzen umfasst).
 * Unbekannte Modelle bekommen den vorsichtigsten Wert.
 */
const OBJECT_REFERENCE_LIMITS = Object.freeze(
  Object.assign(Object.create(null), {
    'gemini-3-pro-image': 6,
    'gemini-3.1-flash-image': 10,
    'gemini-3.1-flash-lite-image': 6,
    'gemini-2.5-flash-image': 3,
  })
);
const CONSERVATIVE_REFERENCE_LIMIT = 3;

/** Welche `imageConfig.imageSize`-Werte ein Modell führt. */
const IMAGE_SIZE_SUPPORT = Object.freeze(
  Object.assign(Object.create(null), {
    'gemini-3-pro-image': ['1K', '2K', '4K'],
    'gemini-3.1-flash-image': ['512', '1K', '2K', '4K'],
    'gemini-3.1-flash-lite-image': ['512', '1K'],
    'gemini-2.5-flash-image': [],
  })
);

const warnedRetired = new Set();

function warnOnce(model, replacement) {
  if (warnedRetired.has(model)) return;
  warnedRetired.add(model);
  console.warn(
    `[gemini-image-models] Modell "${model}" ist abgeschaltet — es wird "${replacement}" verwendet. ` +
      'ENV-Pin bitte nachziehen.'
  );
}

/**
 * Löst einen (womöglich veralteten) Modellnamen auf einen lebenden auf.
 * Unbekannte Namen bleiben unangetastet — ein neues Google-Modell darf nicht
 * an einer veralteten Tabelle in diesem Repo scheitern (fail-open).
 */
function resolveImageModel(model, fallback = DEFAULT_QUALITY_MODEL) {
  const raw = String(model || '').trim();
  if (!raw) return fallback;
  const replacement = RETIRED_IMAGE_MODELS[raw];
  if (typeof replacement === 'string' && replacement) {
    warnOnce(raw, replacement);
    return replacement;
  }
  return raw;
}

/** Modellkette für den Studio-Packshot (ein echtes Foto → weisser Hintergrund). */
function studioImageModelChain() {
  const primary = resolveImageModel(process.env.STUDIO_IMAGE_MODEL, DEFAULT_QUALITY_MODEL);
  const fallback = resolveImageModel(
    process.env.STUDIO_IMAGE_FALLBACK_MODEL || process.env.GEMINI_IMAGE_MODEL,
    DEFAULT_FAST_MODEL
  );
  return [...new Set([primary, fallback])];
}

/** Modellkette für die Varianten-Erzeugung (mehrere Referenzen → weitere Ansicht). */
function variantImageModelChain() {
  const primary = resolveImageModel(
    process.env.VARIANT_IMAGE_MODEL || process.env.GEMINI_IMAGE_MODEL,
    DEFAULT_QUALITY_MODEL
  );
  const fallback = resolveImageModel(process.env.VARIANT_IMAGE_FALLBACK_MODEL, DEFAULT_FAST_MODEL);
  return [...new Set([primary, fallback])];
}

/** Wie viele Objekt-Referenzbilder dieses Modell mit hoher Treue hält. */
function maxObjectReferences(model) {
  const resolved = resolveImageModel(model);
  const limit = OBJECT_REFERENCE_LIMITS[resolved];
  return Number.isInteger(limit) && limit > 0 ? limit : CONSERVATIVE_REFERENCE_LIMIT;
}

/**
 * Gibt den nächstbesten unterstützten `imageSize`-Wert zurück, oder null wenn das
 * Modell die Steuerung nicht kennt (dann darf das Feld NICHT gesendet werden —
 * ein unbekanntes Konfigurationsfeld wird von Gemini stillschweigend ignoriert).
 */
function resolveImageSize(model, requested) {
  const wanted = String(requested || '').trim();
  if (!wanted) return null;
  const resolved = resolveImageModel(model);
  const supported = IMAGE_SIZE_SUPPORT[resolved];
  // Unbekanntes Modell: NICHTS senden. Ein Konfigurationsfeld, das das Modell
  // nicht kennt, wird stillschweigend ignoriert — dann kaeme das Bild in der
  // Voreinstellung zurueck und niemand merkte den Fehler. Lieber bewusst die
  // Voreinstellung nehmen als eine unwirksame Angabe zu senden.
  if (!Array.isArray(supported) || !supported.length) return null;
  if (supported.includes(wanted)) return wanted;
  // Gewünschte Grösse zu gross → grösste verfügbare nehmen statt gar nichts.
  return supported[supported.length - 1];
}

module.exports = {
  DEFAULT_QUALITY_MODEL,
  DEFAULT_FAST_MODEL,
  RETIRED_IMAGE_MODELS,
  resolveImageModel,
  studioImageModelChain,
  variantImageModelChain,
  maxObjectReferences,
  resolveImageSize,
};
