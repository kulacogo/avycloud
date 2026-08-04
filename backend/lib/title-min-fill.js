'use strict';

/**
 * title-min-fill.js — deterministisches Mindestlängen-Netz für Chat-Titel.
 *
 * Incident 2026-08-04: Der Chat schlug einen 31-Zeichen-Titel vor, obwohl die
 * 70-80-Regel im Prompt steht UND als minLen an coerceTitleToPolicy übergeben
 * wird — im Passthrough-Modus (forcePolicy=false) ist minLen aber wirkungslos
 * (nur die 80er-Kappe greift). LLM-Prompts erzwingen keine Länge; dieses Netz
 * schon.
 *
 * Doktrin (Veredler-Vorfall 2026-06-07: nie Marke droppen; Muster wie
 * lib/mpn-title-append.js): NUR ANHÄNGEN. Der vorgeschlagene Titel bleibt
 * unverändertes Präfix, es wird nie gekürzt, umsortiert oder umgeschrieben.
 * Angehängt werden ausschließlich BELEGTE Datenblatt-Tokens (Produktart,
 * Modell, Farbe, Material, Volumen/Größe, MPN, Rest-Tokens aus dem
 * Datenblatt-Namen) — nichts wird erfunden, keine Platzhalter. Tokens, die
 * (diakritik-/case-tolerant) schon im Titel stehen, werden übersprungen.
 * maxLen wird nie überschritten: was nicht passt, wird ausgelassen.
 */

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
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

const PLACEHOLDER_RE = /^(unbekannt|n\/?a|-{1,2}|none|null|keine angabe)$/i;

function _candidateTokens(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object'
    && !Array.isArray(product.details.attributes) ? product.details.attributes : {};
  const identifiers = product?.details?.identifiers && typeof product.details.identifiers === 'object'
    ? product.details.identifiers : {};

  const ordered = [
    attrs.Produktart,
    attrs.Modell,
    attrs.Farbe,
    attrs['Volumen'] || attrs['Größe'] || attrs['Groesse'],
    attrs.Material,
    identifiers.mpn,
  ].map(safeString).filter((t) => t && !PLACEHOLDER_RE.test(t));

  // Rest-Tokens aus dem Datenblatt-Namen (einzelne Wörter ≥3 Zeichen) als
  // letzte Reserve — der Name ist belegter Bestand, kein Erfundenes.
  const nameWords = safeString(product?.identification?.name)
    .split(/\s+/)
    .map((w) => w.replace(/[|,;]+$/g, ''))
    .filter((w) => w.length >= 3 && !PLACEHOLDER_RE.test(w));

  return [...ordered, ...nameWords];
}

/**
 * @param {string} title — vorgeschlagener Titel (bleibt unverändertes Präfix)
 * @param {object} product — Datenblatt als Token-Quelle
 * @param {{minLen?: number, maxLen?: number}} [opts]
 * @returns {string} aufgefüllter Titel (oder Input unverändert)
 */
function fillTitleToMinLength(title, product, { minLen = 70, maxLen = 80 } = {}) {
  const base = safeString(title);
  if (!base) return title;
  if (base.length >= minLen) return title;

  let filled = base;
  let coveredNorm = ` ${normalizeForMatch(filled)} `;

  for (const token of _candidateTokens(product)) {
    if (filled.length >= minLen) break;
    const tokenNorm = normalizeForMatch(token);
    if (!tokenNorm) continue;
    // Schon (ganz) enthalten? Multi-Wort-Tokens zählen als enthalten, wenn
    // alle Einzelwörter bereits im Titel stehen — verhindert "Färden Duffel
    // 80" doppelt, auch wenn die Schreibweise abweicht.
    const words = tokenNorm.split(' ');
    if (words.every((w) => coveredNorm.includes(` ${w} `))) continue;
    const candidate = `${filled} ${token}`;
    if (candidate.length > maxLen) continue; // passt nicht mehr → auslassen
    filled = candidate;
    coveredNorm = ` ${normalizeForMatch(filled)} `;
  }

  return filled;
}

// Kill-Switch: CHAT_TITLE_MIN_FILL=off stellt das alte Verhalten (keine
// Mindestlängen-Auffüllung) wieder her.
function titleMinFillEnabled() {
  return String(process.env.CHAT_TITLE_MIN_FILL || 'on').toLowerCase() !== 'off';
}

module.exports = { fillTitleToMinLength, titleMinFillEnabled };
