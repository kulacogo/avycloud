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
const { PROFESSIONAL_RELIGHTING, PRODUCT_PRESERVATION } = require('../lib/product-photo-policy');

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
 * `services/image-studio.js`: Betreiberanforderung 18.09.2026 — professionelles
 * Licht bei unverändertem tatsächlichen Artikel und Zustand.
 *
 * Der entscheidende Unterschied zum alten Prompt: hier steht ausdrücklich, dass
 * Beschriftungen ERHALTEN bleiben müssen — nicht, dass kein Text im Bild sein darf.
 */
const PRESERVE_BLOCK = [
  'The product is the single most important element and MUST stay 100% authentic and unchanged:',
  'do NOT reshape, rotate or re-color it; photographic relighting is explicitly allowed.',
  'Preserve every detail EXACTLY as in the source photo — the exact shape, proportions, viewing angle,',
  'colors, materials and surface texture.',
  'KEEP every piece of printed text, every label, type plate, sticker, model number, logo and marking',
  'that is on the product itself, readable and in the exact same place. These identify the item and',
  'removing or re-rendering them makes the photo wrong.',
  'Keep existing wear, scratches, dents, dust and small imperfections — this is a real, individual item,',
  'not a catalogue rendering.',
  'Never invent, add, remove or "improve" any part of the product.',
  PRODUCT_PRESERVATION,
  PROFESSIONAL_RELIGHTING,
].join(' ');

const BACKGROUND_BLOCK = [
  'Replace ONLY the background with a plain PURE WHITE backdrop — flat pure white #FFFFFF (RGB 255,255,255),',
  'no gradient, no off-white, no colored tint.',
  'Add a soft, natural contact shadow directly under the product so it looks grounded on the surface.',
  'Create honest professional product photography: improve lighting, preserve the actual item and condition.',
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

// ---------------------------------------------------------------------------
// Galerie-Prompts (Betreiber-Vorgabe 2026-09-10)
// ---------------------------------------------------------------------------

/**
 * Der Artikel, wie er in den Bild-Prompt geht.
 *
 * Bevorzugt die Beschreibung AUS DEN FOTOS (`produkt.wasEsIst` der Vision-Analyse),
 * nicht den Datenblatt-Titel: der Titel trägt Marketing-Ballast, Maße und
 * Kategorie-Krümel, das Foto-Urteil beschreibt den Gegenstand.
 */
function artikelBezeichnung(product, produkt) {
  const ausFoto = typeof produkt?.wasEsIst === 'string' ? produkt.wasEsIst.trim() : '';
  if (ausFoto) return ausFoto;
  return buildProductDescriptor(product) || 'the product shown in the reference images';
}

/**
 * IDENTITÄTS-BLOCK. Der Blickwinkel DARF sich jetzt ändern — das ist der Zweck
 * der Serie. Was NICHT verhandelbar ist: es muss derselbe physische Artikel
 * bleiben. Form, Proportionen, Farbe, Material, Beschriftung.
 *
 * Die Erfahrung aus den ~50 Messläufen vom 04.09. steckt hier drin: ein
 * Bildmodell erfindet Kleindruck, sobald es ihn neu zeichnet. Deshalb steht hier
 * ausdrücklich, dass Beschriftungen KOPIERT und nicht neu gesetzt werden — und
 * dass unleserlicher Kleindruck unleserlich bleiben soll, statt zu erfundenen
 * Wörtern zu werden.
 */
const IDENTITAETS_BLOCK = [
  PROFESSIONAL_RELIGHTING,
  PRODUCT_PRESERVATION,
  'The item must stay the SAME physical product as in the reference photos:',
  'identical shape, proportions, colours, materials, surface texture, and every',
  'moulded or printed detail. Do not restyle it, do not change its design, do not',
  'add or remove parts, do not alter its colour.',
  'Copy any printed text, label, logo or marking as SHAPES — never read them and',
  'set them again. Where print is too small to copy exactly, keep it that small and',
  'unreadable rather than inventing legible words.',
].join(' ');

/**
 * Studio-Prompt einer Ansicht. Aufbau nach der Betreiber-Vorlage
 * (Screenshot 10.09.2026), ergänzt um den Identitäts-Block.
 */
function buildStudioPrompt({ product, produkt, planEntry, referenceCount = 1 }) {
  const artikel = artikelBezeichnung(product, produkt);
  const winkel = planEntry?.winkel || 'three-quarter product view';
  const zeilen = [];

  if (referenceCount > 1) {
    zeilen.push(
      `Images 1 to ${referenceCount} all show the SAME physical item from different angles.`,
      'Use them together to understand its true shape, colours, materials and markings.'
    );
  } else {
    zeilen.push('The reference image shows the item.');
  }

  if (planEntry?.key === 'detail') {
    const bereich = produkt?.schluesselbereich || 'the most important functional area';
    zeilen.push(
      `Produce a high-end macro close-up product photo of ${bereich} of the ${artikel}.`,
      'Fill the frame with that area, keep it razor sharp, show the material structure.'
    );
  } else {
    zeilen.push(`Produce a high-end ${winkel} product photo of the ${artikel}.`);
  }

  // HINTERGRUND: SEAMLESS REINWEISS, NICHT DER GRAUE VERLAUF (seit 2026-09-10).
  //
  // Betreiber: "der hintergrund aller 4 bilder ist unterschiedlich!" Ursache waren
  // ZWEI Quellen fuer denselben Bildteil: der pixeltreue Weg legt seinen Grund
  // deterministisch an (baueVerlaufsgrund), der Render-Weg liess ihn das Modell
  // malen — und ein Modell malt ihn jedes Mal anders. Gemessen an einer echten
  // Galerie (Abgasrohr, Produkt 6c764467): pixeltreue Bilder Ecken 237/237/230/230,
  // gerendertes Bild 220/221/219/218 — 17 Stufen daneben.
  //
  // Der Verlauf wird deshalb NICHT mehr bestellt, sondern hinterher deterministisch
  // gelegt. Das Modell soll nur noch einen Grund liefern, der sich sauber vom
  // Artikel trennen laesst. Der Wortlaut folgt bewusst dem MASKEN_PROMPT, der
  // genau das seit Wochen zuverlaessig liefert.
  zeilen.push(
    'Place it on a completely plain, seamless PURE WHITE background (#FFFFFF, RGB',
    '255,255,255), edge to edge — no gradient, no vignette, no grey wash, no colour',
    'tint, no visible horizon line, no surface texture. All four picture corners are',
    'pure white. Light it with soft directional studio lighting that produces clean,',
    'natural shading on the item and accurate colour. Ultra-sharp edges, high',
    'resolution, realistic material rendering, no harsh reflections, no props, no',
    'added text, no watermark, no people.',
    // KEIN GEMALTER BODENSCHATTEN. Der Kontaktschatten entsteht spaeter
    // deterministisch aus der Silhouette. Ein gemalter Schatten ist nicht weiss,
    // zaehlt damit als Produkt und zieht die Maske nach unten auf — im
    // Studio-Pfad in 3 von 3 Laeufen belegt (packshot-composite.js).
    'No cast shadow and no reflection on the ground.',
    'Marketplace-ready composition: item centred, fully in frame, generous even margins.',
    IDENTITAETS_BLOCK
  );

  const anchors = buildVisualAnchors(product);
  if (anchors.length) {
    zeilen.push(
      `Recorded attributes: ${anchors.join(', ')}. This is context only and may be`,
      'incomplete or wrong — the PHOTOS always win.'
    );
  }

  return zeilen.join(' ');
}

/**
 * Anwendungsszene. Die Szene kommt aus der Bildanalyse (`szene_a`/`szene_b`),
 * nicht aus dem Datenblatt — so passt sie zum tatsächlich abgebildeten Artikel
 * statt zu einem Kategorie-Krümel.
 */
function buildLifestylePrompt({ product, produkt, planEntry, referenceCount = 1 }) {
  const artikel = artikelBezeichnung(product, produkt);
  const zeilen = [];

  if (referenceCount > 1) {
    zeilen.push(
      `Images 1 to ${referenceCount} all show the SAME physical item from different angles.`
    );
  }

  zeilen.push(
    `Realistic lifestyle photograph showing the ${artikel} being actively used.`,
    `Scene: ${planEntry?.szene || produkt?.wieBenutzt || 'the item in normal everyday use'}.`
  );

  if (produkt?.woBenutzt) zeilen.push(`Location: ${produkt.woBenutzt}.`);

  zeilen.push(
    'True-to-life lighting (daylight or warm indoor ambient), subtle natural shadows,',
    'photorealistic textures, shallow depth of field. Clean, tidy surroundings with no',
    'distracting objects, no other branded products, no added text, no watermark, no logos.',
    'The scene must clearly communicate real usage, benefit and context.',
    'High resolution, authentic, suitable for an e-commerce marketing gallery.',
    IDENTITAETS_BLOCK,
    'The item must remain clearly visible and recognisable as the main subject —',
    'never hidden, never cropped to an unrecognisable fragment.'
  );

  return zeilen.join(' ');
}

/** Wählt nach `planEntry.art` den richtigen Prompt-Bauer. */
function buildGalleryPrompt(args) {
  return args?.planEntry?.art === 'lifestyle' ? buildLifestylePrompt(args) : buildStudioPrompt(args);
}

/**
 * MASKEN_PROMPT — für den PIXELTREUEN Weg (lib/packshot-composite.js).
 *
 * Diese Aufnahme wird NIE gespeichert. Sie dient ausschliesslich dazu, die
 * Silhouette des Produkts zu bestimmen; ins Endbild gehen danach nur
 * ORIGINALPIXEL. Deshalb ist es egal, dass auch hier der Kleindruck verfälscht
 * wird — diese Pixel werden weggeworfen. Genau das ist der Grund, warum dieser
 * Weg das Kleindruck-Problem bauartbedingt löst statt es zu bekämpfen.
 *
 * KEIN SCHATTEN BESTELLEN (teuer gelernt, 3 von 3 Läufen): ein gemalter Schatten
 * ist nicht weiss, zählt damit als Produkt — und darunter lag im Original die
 * Hand. Der Schatten entsteht deterministisch aus der Silhouette.
 *
 * Liegt hier und nicht mehr im Studio-Dienst, weil ihn seit 2026-09-10 ZWEI
 * Wege brauchen (Studio-Foto und Angebotsgalerie). Zwei Kopien desselben
 * Prompts wären eine Quelle für Abweichungen — dieselbe Lehre wie beim
 * Datenblatt-Kontrakt (CLAUDE.md Punkt 16c).
 */
const MASKEN_PROMPT = [
  'Remove the background and any human hand or fingers from this photo. Place the product',
  'on a completely plain PURE WHITE background (#FFFFFF, RGB 255,255,255), nothing else.',
  '',
  'ABSOLUTELY CRITICAL — the product must not move:',
  '- Keep the product at the EXACT same position, the EXACT same size and the EXACT same',
  '  camera perspective and rotation as in the input photo. Do NOT crop, do NOT zoom,',
  '  do NOT re-center, do NOT rescale, do NOT rotate, do NOT re-compose.',
  '- The output image must have the same aspect ratio and framing as the input.',
  '- Where the hand covered part of the product, reconstruct only that small hidden part.',
  '- No shadow, no reflection, no gradient, no props, no text, no watermark.',
].join('\n');

function buildMaskPrompt() {
  return MASKEN_PROMPT;
}

module.exports = {
  generateVisualDescriptions,
  buildViewPrompt,
  buildGalleryPrompt,
  buildStudioPrompt,
  buildLifestylePrompt,
  buildMaskPrompt,
  MASKEN_PROMPT,
  artikelBezeichnung,
  buildProductDescriptor,
  buildVisualAnchors,
  isPlaceholder,
  _internal: { PRESERVE_BLOCK, BACKGROUND_BLOCK, buildReferenceBlock },
};
