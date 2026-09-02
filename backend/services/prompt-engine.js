'use strict';

/**
 * prompt-engine.js — Prompts für die Aufbereitung echter Produktfotos.
 *
 * UMBAU 2026-09-02. Die alten Prompts arbeiteten der Originaltreue aktiv entgegen:
 *
 *  a) "no text" — das Modell entfernte damit Beschriftungen, Typenschilder und
 *     Aufdrucke VOM PRODUKT. Gemeint war "keine Werbetexte ins Bild montieren";
 *     verstanden wurde "mach das Produkt schriftlos". Genau die Angaben, die eine
 *     Einheit identifizierbar machen, verschwanden.
 *  b) "premium retail aesthetic", "glossy-matte material rendering", "strong visual
 *     depth" — Verschönerungsbefehle stehen in direktem Widerspruch zur Anweisung
 *     "reproduce this IDENTICAL product". Bei Zielkonflikten gewinnt im Zweifel
 *     die Ästhetik, weil sie konkreter formuliert war.
 *  c) Der Prompt verlangte Rück-, Seiten- und Makroansichten, für die es kein Foto
 *     gab. Diese Zuständigkeit liegt jetzt bei `lib/image-viewpoint.js` — hier
 *     werden nur noch Ansichten beschrieben, die BELEGT sind.
 *  d) Ohne Produktdaten entstand der Satz "product photo of a the product shown in
 *     the reference image", und Platzhalterwerte ("Unbekannt", "n/a") wurden dem
 *     Modell als gesicherte Fakten vorgelegt.
 *
 * SPRACHE: englisch. Die Bildmodelle sind auf englische Bildbeschreibungen
 * trainiert, und der bereits bewährte STUDIO_PROMPT in `services/image-studio.js`
 * ist ebenfalls englisch — zwei Sprachen für dieselbe Aufgabe wären eine
 * unnötige Quelle für Abweichungen.
 */

const { VIEWPOINT_LABELS_DE } = require('../lib/image-viewpoint');

// Werte, die nichts aussagen und deshalb NICHT als Produktfakt gelten dürfen.
const PLACEHOLDER_VALUES = new Set([
  'unbekannt', 'unknown', 'n/a', 'na', 'k.a.', 'ka', 'keine angabe', 'none',
  'null', 'undefined', '-', '--', '', 'nicht zutreffend', 'not applicable',
  'sonstige', 'sonstiges', 'other', 'divers', 'verschiedene', 'markenlos',
]);

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function cleanValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).replace(/\s+/g, ' ').trim();
  if (!str || isPlaceholder(str)) return null;
  return str;
}

function detectPrimaryColor(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') return null;
  const directKeys = ['Color', 'Farbe', 'Colour', 'Primary Color', 'Hauptfarbe'];
  for (const key of directKeys) {
    const value = cleanValue(attributes[key]);
    if (value) return value;
  }
  const fallbackKey = Object.keys(attributes).find(
    (key) => key.toLowerCase().includes('color') || key.toLowerCase().includes('farbe')
  );
  return fallbackKey ? cleanValue(attributes[fallbackKey]) : null;
}

/**
 * Kurzer Produktbezeichner aus Marke und Name.
 *
 * Die eBay-KATEGORIE fliesst bewusst NICHT mehr ein: dort steht ein kompletter
 * Breadcrumb ("Auto & Motorrad: Teile > Auto-Ersatz- & -Reparaturteile > ..."),
 * der als Bildbeschreibung nichts taugt und das Modell in Richtung generischer
 * Katalogware zieht.
 */
function buildProductDescriptor(product) {
  const brand = cleanValue(product?.identification?.brand);
  const name = cleanValue(product?.identification?.name);
  const parts = [brand, name].filter(Boolean);
  if (!parts.length) return null;
  // Marke doppelt im Namen ("Bosch Bosch GSR 12V") vermeiden.
  if (brand && name && name.toLowerCase().startsWith(brand.toLowerCase())) return name;
  return parts.join(' ');
}

/**
 * Nur Merkmale, die sich im Bild PRÜFEN lassen. Masse und Gewicht gehören nicht
 * dazu — sie sagen dem Bildmodell nichts und verleiten es dazu, Proportionen
 * nach der Zahl statt nach dem Foto zu ändern.
 */
function buildVisualAnchors(product) {
  const attrs = product?.details?.attributes || {};
  const lower = {};
  for (const key of Object.keys(attrs)) lower[key.toLowerCase()] = attrs[key];

  const wanted = [
    ['Material', ['material']],
    ['Color', ['farbe', 'color', 'colour', 'hauptfarbe']],
    ['Style', ['stil', 'style', 'design']],
    ['Finish', ['oberfläche', 'oberflaeche', 'finish']],
  ];

  const anchors = [];
  const seen = new Set();
  for (const [label, keys] of wanted) {
    for (const key of keys) {
      const value = cleanValue(lower[key]);
      if (!value) continue;
      const dedupeKey = value.toLowerCase();
      if (seen.has(dedupeKey)) break;
      seen.add(dedupeKey);
      anchors.push(`${label}: ${value}`);
      break;
    }
  }
  return anchors;
}

/**
 * Der Erhaltungs-Block. Wortgleich in Haltung zum bewährten STUDIO_PROMPT aus
 * `services/image-studio.js` (Owner-Anforderung 2026-07-21: ehrliches Foto eines
 * privaten Verkäufers, KEIN Hochglanz-Render).
 *
 * Der entscheidende Unterschied zum alten Prompt: hier steht ausdrücklich, dass
 * Beschriftungen ERHALTEN bleiben müssen — nicht, dass kein Text im Bild sein darf.
 */
const PRESERVE_BLOCK = [
  'The product is the single most important element and MUST stay 100% authentic and unchanged:',
  'do NOT redraw, regenerate, restyle, retouch, beautify, sharpen, reshape, rotate or re-color it.',
  'Preserve every detail EXACTLY as in the source photo — the exact shape, proportions, viewing angle,',
  'colors, materials and surface texture.',
  'KEEP every piece of printed text, every label, type plate, sticker, model number, logo and marking',
  'that is on the product itself, readable and in the exact same place. These identify the item and',
  'removing or re-rendering them makes the photo wrong.',
  'Keep existing wear, scratches, dents, dust and small imperfections — this is a real, individual item,',
  'not a catalogue rendering.',
  'Never invent, add, remove or "improve" any part of the product.',
  'If in doubt, leave the product pixel-for-pixel as it is.',
].join(' ');

const BACKGROUND_BLOCK = [
  'Replace ONLY the background with a plain PURE WHITE backdrop — flat pure white #FFFFFF (RGB 255,255,255),',
  'no gradient, no off-white, no colored tint.',
  'Add a soft, natural contact shadow directly under the product so it looks grounded on the surface.',
  'Keep the result honest and believable, like a real photo taken by a small private online seller.',
  'Natural, slightly uneven everyday lighting is fine and even wanted — do NOT turn it into a glossy,',
  'high-end, hyper-polished or overly perfect commercial studio render.',
  'No props, no people, no added marketing text, no watermark, no borders, no collage, no reflections of',
  'other objects, no added items.',
  'Keep the original camera perspective and framing; show the product fully in frame.',
].join(' ');

/**
 * Wie mehrere Referenzbilder adressiert werden. Gemini sieht die Bilder in der
 * Reihenfolge des parts-Arrays; die Bezugnahme muss deshalb im Text explizit sein.
 *
 * WICHTIG: die Zusatzbilder dürfen die Perspektive NICHT verändern. Sie sind
 * Identitätsanker ("so sieht dieser Artikel aus"), keine Vorlage für den Blickwinkel.
 * Ohne diesen Satz mischt das Modell die Ansichten und liefert eine vierte,
 * erfundene Perspektive — genau der Fehler, den der Umbau abstellt.
 */
function buildReferenceBlock(referenceCount, viewpointLabel) {
  if (referenceCount <= 1) {
    return 'Image 1 is the source photo you must edit.';
  }
  return [
    `Image 1 is the source photo you must edit. It shows the ${viewpointLabel} of the item.`,
    `Images 2 to ${referenceCount} show the SAME physical item from other angles.`,
    'Use them ONLY to confirm the true shape, colors, materials and markings of this item —',
    'they help you avoid guessing. Do NOT copy their camera angle, do NOT merge them into the result,',
    'and do NOT change the perspective of image 1. The output must show image 1\'s perspective.',
  ].join(' ');
}

/**
 * Baut den Prompt für EINE belegte Ansicht.
 *
 * @param {Object} product
 * @param {Object} planEntry Eintrag aus planFaithfulVariants (viewpoint, label)
 * @param {number} referenceCount Anzahl der insgesamt mitgesendeten Bilder
 * @returns {string}
 */
function buildViewPrompt(product, planEntry, referenceCount = 1) {
  const descriptor = buildProductDescriptor(product);
  const anchors = buildVisualAnchors(product);
  const viewpointLabelEn = ENGLISH_VIEWPOINT[planEntry?.viewpoint] || 'view';

  const lines = [
    buildReferenceBlock(referenceCount, viewpointLabelEn),
    'Edit ONLY the background and the overall lighting of image 1.',
    PRESERVE_BLOCK,
    BACKGROUND_BLOCK,
  ];

  // Produktwissen NUR als Bestätigungshilfe, ausdrücklich dem Foto untergeordnet.
  // Ohne diese Rangfolge korrigiert das Modell das Foto anhand des Datenblatts
  // statt umgekehrt — und ein falsches Datenblattfeld würde ins Bild geschrieben.
  if (descriptor || anchors.length) {
    const known = [];
    if (descriptor) known.push(`The item is described in our records as: ${descriptor}.`);
    if (anchors.length) known.push(`Recorded attributes: ${anchors.join(', ')}.`);
    known.push(
      'This information is only context and may be incomplete or wrong.',
      'The PHOTO always wins: if the records disagree with what you see, follow the photo.'
    );
    lines.push(known.join(' '));
  }

  return lines.join(' ');
}

const ENGLISH_VIEWPOINT = {
  front: 'front',
  back: 'back',
  side: 'side',
  top: 'top',
  bottom: 'underside',
  detail: 'close-up detail',
  label: 'label',
  packaging: 'packaging',
  unclear: 'view',
};

/**
 * ALTE SCHNITTSTELLE — bleibt erhalten, weil `backend/verify-pipeline.js` sie ruft.
 * Liefert jetzt Erhaltungs-Prompts statt der früheren Verschönerungs-Prompts.
 * Die Perspektiven-Schlüssel bleiben gleich, damit nichts bricht; sie beschreiben
 * aber alle dieselbe Aufgabe (Hintergrund tauschen, Produkt unverändert lassen).
 */
async function generateVisualDescriptions(product) {
  const base = (viewpoint) =>
    buildViewPrompt(product, { viewpoint, label: VIEWPOINT_LABELS_DE[viewpoint] || viewpoint }, 1);
  return {
    studio: {
      front: base('front'),
      angle: base('side'),
      detail: base('detail'),
      back: base('back'),
    },
  };
}

module.exports = {
  generateVisualDescriptions,
  buildViewPrompt,
  buildProductDescriptor,
  buildVisualAnchors,
  isPlaceholder,
  _internal: { PRESERVE_BLOCK, BACKGROUND_BLOCK, buildReferenceBlock },
};
