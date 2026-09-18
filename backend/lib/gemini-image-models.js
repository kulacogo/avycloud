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
// Billigstes Modell — ausschliesslich fuer MASKEN-Aufnahmen (lib/packshot-composite.js).
// Deren Pixel landen NIE im Endbild; gebraucht wird nur die Silhouette. Detailtreue,
// Kleindruck und Farbe sind dort gleichgueltig, also waere jedes teurere Modell
// verschwendetes Geld: 0,034 $ statt 0,101 $ je Ansicht.
const DEFAULT_MASK_MODEL = 'gemini-3.1-flash-lite-image';

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

/**
 * Modellkette für die Angebotsgalerie — BILLIG ZUERST (seit 2026-09-10).
 *
 * Umgekehrt zum Studio-Pfad: dort erzeugt EIN Aufruf das eine Ergebnis, hier
 * sind es sechs Bilder je Knopfdruck. Preisliste je Bild:
 *   gemini-3-pro-image      0,134 $  ->  6 Bilder = 0,80 $
 *   gemini-3.1-flash-image  0,101 $ (2K) / 0,067 $ (1K)  ->  Serie ~0,54 $
 *
 * Das schnelle Modell steht deshalb VORN, das teure ist der Rückfall. Das ist
 * auch qualitativ vertretbar: der Rückfall ist das BESSERE Modell, nicht das
 * schlechtere — scheitert das billige an einer Prüfung, übernimmt das teure.
 * Am echten Produkt gemessen (10.09.): das Pro-Modell wurde von den Prüfungen
 * nicht seltener verworfen als Flash.
 */
function variantImageModelChain() {
  const primary = resolveImageModel(
    process.env.VARIANT_IMAGE_MODEL || process.env.GEMINI_IMAGE_MODEL,
    DEFAULT_FAST_MODEL
  );
  const fallback = resolveImageModel(process.env.VARIANT_IMAGE_FALLBACK_MODEL, DEFAULT_QUALITY_MODEL);
  return [...new Set([primary, fallback])];
}

/** Wie viele Objekt-Referenzbilder dieses Modell mit hoher Treue hält. */
/**
 * Kette fuer MASKEN-Aufnahmen (Silhouette fuer den pixeltreuen Packshot-Weg).
 *
 * BILLIG ZUERST, und zwar aus einem inhaltlichen Grund, nicht aus Geiz: von dieser
 * Aufnahme wird ausschliesslich die Silhouette benutzt, alle ihre Pixel werden
 * weggeworfen. Ein Modell, das schoenere Oberflaechen malt, liefert hier exakt
 * nichts Zusaetzliches. Das Zweitmodell steht nur bereit, falls das erste die
 * Freistellung nicht sauber hinbekommt (die Waechter in packshot-composite.js
 * merken das und sind fail-closed).
 */
function maskImageModelChain() {
  const primary = resolveImageModel(process.env.VARIANT_MASK_MODEL, DEFAULT_MASK_MODEL);
  // NUR EIN VERSUCH (Korrektur 2026-09-10, gemessen). Der Rueckfall auf ein
  // teureres Maskenmodell ist hier Geld fuer nichts: scheitert der pixeltreue
  // Weg, dann fast immer an den WACHEN in packshot-composite.js (Deckung,
  // Kompaktheit, Randberuehrung) — und die haengen an der Form des Fotos, nicht
  // an der Qualitaet des Modells. Am Heimtrainer gemessen: die Seitenansicht
  // verbrannte 0,034 $ (flash-lite) + 0,067 $ (flash) fuer zwei verworfene
  // Masken und lief danach ohnehin in den Render fuer 0,101 $ — 0,202 $ statt
  // 0,135 $ fuer EIN Bild. Der Render IST der Rueckfall; einen zweiten braucht
  // es nicht. Wer ihn doch will, setzt VARIANT_MASK_FALLBACK_MODEL.
  const fallbackName = String(process.env.VARIANT_MASK_FALLBACK_MODEL || '').trim();
  if (!fallbackName) return [primary];
  return [...new Set([primary, resolveImageModel(fallbackName, DEFAULT_FAST_MODEL)])];
}

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
  DEFAULT_MASK_MODEL,
  RETIRED_IMAGE_MODELS,
  resolveImageModel,
  studioImageModelChain,
  variantImageModelChain,
  maskImageModelChain,
  maxObjectReferences,
  resolveImageSize,
};
