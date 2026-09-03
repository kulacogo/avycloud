'use strict';

/**
 * chat-image-selection.js — welche Produktfotos bekommt der Chat zu sehen?
 *
 * BEFUND 2026-09-03 (Produkt 371fce64, SKU-1698488489): Das Produkt hat 26
 * Fotos. Der Chat sendete davon `images.slice(0, 4)` — die ersten VIER der
 * rohen Liste. Auf den Plätzen 1 und 2 standen zwei fremde Amazon-Werbebilder
 * ("Manuell hinzugefügt"), die 24 eigenen Aufnahmen kamen danach. Das Modell
 * sah also zwei Fremdbilder und zwei beliebige eigene Fotos — und bekam im
 * Prompt gleichzeitig `imageCount: 26` genannt. Es konnte gar nicht wissen,
 * dass es blind war, und der Bediener sah nur "der Chat schaut nicht drauf".
 *
 * Drei Regeln:
 *   1. AUSWÄHLEN STATT ABSCHNEIDEN. Eigene Aufnahmen vor fremden Web-Bildern,
 *      Etikett-/Typenschild-Kandidaten zuerst — dort steht die GPSR-Angabe.
 *   2. KI-BILDER SIND NIE BELEG. Ein erzeugtes Bild darf keine Tatsache über
 *      das Produkt stützen (gleiche Regel wie bei den Bildvarianten).
 *   3. EHRLICH ZÄHLEN. Wie viele Fotos wirklich mitgingen, gehört in den
 *      Prompt — sonst behauptet das Modell, alles gesehen zu haben.
 *
 * Reine Rechen-Bibliothek: kein Netz, kein Firestore.
 */

const { classifyImageHost } = require('./image-hosts');

const DEFAULT_LIMIT = 8;

// Wörter, die ein Foto als Träger von Hersteller-/Sicherheitsangaben
// wahrscheinlich machen. Bewusst deutsch UND englisch: die Felder werden
// mal vom Modell, mal von der Oberfläche gefüllt.
const LABEL_HINTS = [
  'etikett', 'label', 'typenschild', 'typschild', 'nameplate', 'rating plate',
  'verpackung', 'packaging', 'karton', 'box', 'aufkleber', 'sticker',
  'rueckseite', 'rückseite', 'back', 'unterseite', 'bottom',
  'barcode', 'ean', 'gtin', 'hersteller', 'manufacturer', 'gpsr', 'impressum',
  'anleitung', 'manual', 'handbuch', 'datenblatt',
];

const DETAIL_HINTS = ['detail', 'makro', 'macro', 'close', 'nahaufnahme'];

function safeString(v) {
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function imageUrl(img) {
  if (typeof img === 'string') return img.trim();
  if (!img || typeof img !== 'object') return '';
  return safeString(img.url_or_base64 || img.url || img.src);
}

/** Alle Textfelder eines Bildobjekts, in denen ein Hinweis stecken kann. */
function imageText(img) {
  if (!img || typeof img !== 'object') return '';
  return [img.variant, img.viewpoint, img.notes, img.caption, img.role, img.kind, img.source]
    .map(safeString)
    .join(' ')
    .toLowerCase();
}

function isGeneratedImage(img) {
  if (!img || typeof img !== 'object') return false;
  if (img.generatedByAi === true) return true;
  const text = imageText(img);
  return /(^|\s)(ai_|ki-|generiert|generated|studio_)/.test(text);
}

/**
 * Bewertung eines Bildes für den Chat. Höher ist besser.
 * Die Zahlen sind Ränge, keine Wahrscheinlichkeiten — sie sollen nur eine
 * stabile, nachvollziehbare Reihenfolge erzeugen.
 */
function scoreImage(img, { purpose = 'general' } = {}) {
  const url = imageUrl(img);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (isGeneratedImage(img)) return null;

  const host = classifyImageHost(url);
  const text = imageText(img);
  let score = 0;
  const gruende = [];

  if (host.own) {
    score += 100;
    gruende.push('eigene_aufnahme');
  } else {
    // Fremdbilder sind Werbematerial: sie zeigen den Neuzustand eines
    // womöglich anderen Exemplars. Sie fliegen nicht raus, stehen aber hinten.
    score -= 40;
    gruende.push('fremdbild');
    if (host.blocked) {
      score -= 20;
      gruende.push('urheberrechtlich_gesperrt');
    }
  }

  const istEtikett = LABEL_HINTS.some((w) => text.includes(w));
  if (istEtikett) {
    score += purpose === 'gpsr' ? 80 : 30;
    gruende.push('etikett_kandidat');
  } else if (DETAIL_HINTS.some((w) => text.includes(w))) {
    score += 10;
    gruende.push('detailaufnahme');
  }

  if (safeString(img?.source).toLowerCase() === 'upload') {
    score += 15;
    gruende.push('selbst_fotografiert');
  }

  return { url, score, gruende };
}

/** Gleichmäßig verteilte Auswahl aus einer Gruppe (deterministisch). */
function spreadPick(list, anzahl) {
  if (anzahl >= list.length) return list.slice();
  if (anzahl <= 0) return [];
  if (anzahl === 1) return [list[0]];
  const out = [];
  const step = (list.length - 1) / (anzahl - 1);
  for (let i = 0; i < anzahl; i += 1) {
    const idx = Math.round(i * step);
    if (!out.includes(list[idx])) out.push(list[idx]);
  }
  // Rundung kann Duplikate erzeugen — Lücken von vorne auffüllen.
  for (const item of list) {
    if (out.length >= anzahl) break;
    if (!out.includes(item)) out.push(item);
  }
  return out.slice(0, anzahl);
}

/**
 * Wählt die Fotos aus, die der Chat wirklich zu sehen bekommt.
 *
 * @returns {{selected: object[], urls: string[], gesamt: number,
 *            brauchbar: number, gesendet: number, uebersprungen: object}}
 */
function selectChatImages(images, { limit = DEFAULT_LIMIT, purpose = 'general' } = {}) {
  const alle = Array.isArray(images) ? images : [];
  const kandidaten = [];
  const uebersprungen = { keine_url: 0, ki_erzeugt: 0 };

  alle.forEach((img, index) => {
    const url = imageUrl(img);
    if (!url || !/^https?:\/\//i.test(url)) {
      uebersprungen.keine_url += 1;
      return;
    }
    if (isGeneratedImage(img)) {
      uebersprungen.ki_erzeugt += 1;
      return;
    }
    const bewertung = scoreImage(img, { purpose });
    if (!bewertung) return;
    kandidaten.push({ ...bewertung, image: img, index });
  });

  // Nach Rang gruppieren, Reihenfolge innerhalb der Gruppe = Originalreihenfolge.
  const gruppen = new Map();
  for (const k of kandidaten) {
    if (!gruppen.has(k.score)) gruppen.set(k.score, []);
    gruppen.get(k.score).push(k);
  }
  const raenge = [...gruppen.keys()].sort((a, b) => b - a);

  const gewaehlt = [];
  for (const rang of raenge) {
    if (gewaehlt.length >= limit) break;
    const gruppe = gruppen.get(rang);
    const rest = limit - gewaehlt.length;
    // Innerhalb gleichwertiger Fotos gleichmäßig streuen statt die ersten N zu
    // nehmen: bei 24 gleichrangigen Aufnahmen liegt das Etikettfoto sonst
    // systematisch außerhalb des Kontingents.
    gewaehlt.push(...spreadPick(gruppe, rest));
  }

  // Wichtigstes zuerst: das Modell liest die Bild-Parts in Reihenfolge, und bei
  // einer Etikett-Frage soll das Typenschild nicht an Position 8 stehen.
  // Bei gleichem Rang entscheidet die Originalreihenfolge (deterministisch).
  gewaehlt.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  return {
    selected: gewaehlt,
    urls: gewaehlt.map((g) => g.url),
    gesamt: alle.length,
    brauchbar: kandidaten.length,
    gesendet: gewaehlt.length,
    uebersprungen,
  };
}

/**
 * Der Satz, der dem Modell die Wahrheit über seine Bildlage sagt. Ohne ihn
 * behauptet es, alle Fotos gesehen zu haben (der Produkt-Steckbrief nennt
 * `imageCount` = ALLE Bilder).
 */
function describeImageSelection({ gesamt = 0, gesendet = 0 } = {}) {
  if (!gesendet) {
    if (!gesamt) return 'BILDLAGE: Es liegen dir KEINE Produktfotos vor. Sage das ausdrücklich, wenn eine Frage ein Foto erfordern würde. Rate nichts aus dem Datenblatt zusammen.';
    return `BILDLAGE: Das Produkt hat ${gesamt} Foto(s), aber es konnte KEINES geladen werden — du siehst gerade kein einziges Bild. Sage das ausdrücklich und behaupte NIE, ein Foto geprüft zu haben.`;
  }
  if (gesendet >= gesamt) {
    return `BILDLAGE: Dir liegen alle ${gesamt} Produktfotos bei. Was du dort nicht erkennst, darfst du nicht erfinden.`;
  }
  return [
    `BILDLAGE: Das Produkt hat ${gesamt} Fotos, dir liegen davon ${gesendet} bei (ausgewählt: eigene Aufnahmen und Etikett-/Verpackungskandidaten zuerst).`,
    `Du hast also NICHT alle Fotos gesehen. Behaupte nie, alle geprüft zu haben. Findest du eine Angabe auf keinem der beigelegten Bilder, sage das — und sage, welches Foto helfen würde (z. B. Typenschild, Rückseite, Verpackung).`,
  ].join(' ');
}

module.exports = {
  selectChatImages,
  describeImageSelection,
  scoreImage,
  isGeneratedImage,
  imageUrl,
  DEFAULT_LIMIT,
  LABEL_HINTS,
};
