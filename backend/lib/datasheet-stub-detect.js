'use strict';

/**
 * datasheet-stub-detect.js — erkennt Stage-3-Fallback-Stubs im Datenblatt.
 *
 * Incident 2026-08-04 (be quiet! Silent Base 802): Läuft Stage 3 des
 * Identify-V3 in sein Timeout, speichert buildFallbackContent einen Stub —
 * "Beschreibung" = Titel + "Kategorie: …" + "Gewicht: …" + "Hersteller-Nr…"
 * aneinandergeklebt, "Highlights" = Fragmente des Titels. Der Stub ist durch
 * die Boilerplate >140 Zeichen und rutschte damit am Längen-Gate des
 * Beschreibungs-Sicherheitsnetzes vorbei — unbrauchbare Datenblätter sahen
 * "fertig" aus. Diese Lib erkennt das MUSTER statt nur die Länge. PURE,
 * kein I/O.
 */

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function htmlToPlain(html) {
  return safeString(html)
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeForMatch(v) {
  return safeString(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Boilerplate-Zeilen des Fallback-Stubs (buildFallbackContent /
// marketplace-Spiegel-Stub): "Kategorie: …", "Gewicht: …", "Hersteller-Nr…".
const BOILERPLATE_LINE_RE = /^\s*(kategorie|gewicht|hersteller-?nr\.?|mpn|ean)\s*:?\s*/i;

const MIN_REAL_DESCRIPTION_CHARS = 140;

/**
 * true, wenn die Beschreibung ein Fallback-Stub (oder schlicht zu dünn) ist.
 * Muster: Nach Entfernen der Boilerplate-ZEILEN (Kategorie/Gewicht/
 * Hersteller-Nr) und des Produktnamens bleibt praktisch kein eigenständiger
 * Beschreibungstext übrig. Eine echte Beschreibung, die diese Wörter im
 * FLIESSTEXT erwähnt, hat ganze Sätze drumherum und bleibt unberührt.
 *
 * @param {string} html — details.short_description / description (HTML ok)
 * @param {object} [product] — für den Namens-Abgleich
 * @returns {boolean}
 */
function isStubDescription(html, product = {}) {
  const plain = htmlToPlain(html);
  if (!plain) return true;

  const lines = plain.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const nameNorm = normalizeForMatch(product?.identification?.name);

  const substanceLines = lines.filter((line) => {
    if (BOILERPLATE_LINE_RE.test(line)) return false;
    const lineNorm = normalizeForMatch(line);
    if (!lineNorm) return false;
    // Zeile == Produktname (Stub beginnt mit dem Titel als "Beschreibung").
    if (nameNorm && (lineNorm === nameNorm || nameNorm.includes(lineNorm))) return false;
    return true;
  });

  const substance = substanceLines.join(' ');
  return substance.length < MIN_REAL_DESCRIPTION_CHARS;
}

/**
 * true, wenn die Highlights nur Fragmente von Titel/Marke/Kategorie sind
 * (Stub) oder fehlen. Echte Highlights tragen eigenständige Inhalte
 * (Eigenschaft + Nutzen), die nicht komplett im Titel stecken.
 *
 * @param {Array<string>} features — details.key_features
 * @param {object} [product]
 * @returns {boolean}
 */
function isStubHighlights(features, product = {}) {
  const list = (Array.isArray(features) ? features : [])
    .map(safeString)
    .filter(Boolean);
  if (!list.length) return true;

  const haystack = ` ${normalizeForMatch([
    product?.identification?.name,
    product?.identification?.brand,
    product?.identification?.category,
  ].map(safeString).join(' '))} `;

  const fragmentCount = list.filter((f) => {
    const words = normalizeForMatch(f).split(' ').filter(Boolean);
    if (!words.length) return true;
    return words.every((w) => haystack.includes(` ${w} `));
  }).length;

  // Alle (oder alle bis auf eines) Bullets sind reine Titel-Fragmente → Stub.
  return fragmentCount >= list.length - (list.length > 3 ? 1 : 0);
}

module.exports = { isStubDescription, isStubHighlights };
