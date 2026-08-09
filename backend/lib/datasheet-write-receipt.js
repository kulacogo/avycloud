'use strict';

/**
 * datasheet-write-receipt.js — beweist, dass eine Änderung wirklich ankam.
 *
 * WARUM (Vorfall 2026-08-10, SKU-3154363905 / eBay 800481892205):
 * An keiner Stelle der Kette wurde geprüft, ob das Gewollte auch passiert
 * ist. Der Chat meldete Erfolg (zu Recht — er bekam eine positive Quittung
 * über einen unvollständigen Vorgang), die Änderungskarte verschwand, das
 * Datenblatt zeigte die neuen Werte. Geschrieben wurde nichts. Der Nutzer
 * bot die alten, falschen Daten weiter auf eBay an.
 *
 * ENTWURFSPRINZIP: Diese Quittung kennt die konkreten Fehler NICHT. Sie
 * vergleicht generisch "gesendet" gegen "im Dokument" und meldet jedes Feld,
 * das mit Inhalt gesendet wurde und danach leer ist. Damit fängt sie auch
 * Lücken, die heute niemand kennt — genau das war die Anforderung, nachdem
 * eine bekannte Lücke 9 Tage lang unbemerkt blieb.
 *
 * BEWUSST NICHT GEMELDET: Wert-Umformungen (Marken-Schreibweise,
 * Attribut-Kanonisierung, Barcode-Validierung, Titel-Policy). Sie sind
 * legitim und im Datenblatt sichtbar. Würde man sie melden, ertränken die
 * echten Verluste im Rauschen und die Warnung verliert ihre Wirkung.
 *
 * FAIL-OPEN: Ohne lesbare Vergleichsbasis wird NICHTS gemeldet
 * (`skipped: true`). Eine Netzstörung darf nie wie Datenverlust aussehen.
 */

const {
  GPSR_FIELDS,
  IDENTITY_TARGET_PATHS,
  fieldLabel,
} = require('./chat-datasheet-contract');

/** Pfade, deren Verschwinden ein echter Datenverlust ist. */
const WATCHED_PATHS = Object.freeze([
  ...Object.values(IDENTITY_TARGET_PATHS).filter((p) => p !== 'identification.category'),
  ...GPSR_FIELDS.map((f) => `details.gpsr.${f}`),
  'details.short_description',
  'details.categoryId',
]);

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function isBlank(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function shortValue(v) {
  if (Array.isArray(v)) return v.join(', ').slice(0, 120);
  return String(v).slice(0, 120);
}

/**
 * @param {object} intended  das Produkt, wie es gesendet wurde
 * @param {object|null} persisted  das Produkt, wie es nach dem Schreiben im Dokument steht
 * @param {{paths?: string[]}} [opts]
 * @returns {{ok: boolean, missing: Array<{path,label,wanted}>, skipped?: boolean, checked: number}}
 */
function buildWriteReceipt(intended, persisted, opts = {}) {
  if (!intended || typeof intended !== 'object') {
    return { ok: true, missing: [], skipped: true, checked: 0 };
  }
  // Fail-open: keine Vergleichsbasis => keine Aussage. Niemals raten.
  if (!persisted || typeof persisted !== 'object') {
    return { ok: true, missing: [], skipped: true, checked: 0 };
  }

  const paths = Array.isArray(opts.paths) && opts.paths.length ? opts.paths : WATCHED_PATHS;
  const missing = [];

  for (const path of paths) {
    const wanted = getPath(intended, path);
    if (isBlank(wanted)) continue; // nichts gewollt => nichts verlierbar
    const got = getPath(persisted, path);
    if (!isBlank(got)) continue; // angekommen (Umformungen zählen nicht als Verlust)
    missing.push({ path, label: fieldLabel(path), wanted: shortValue(wanted) });
  }

  return { ok: missing.length === 0, missing, checked: paths.length };
}

/** Eine Zeile Klartext für die Chat-Antwort bzw. die Oberfläche. */
function formatReceiptWarning(receipt) {
  if (!receipt || receipt.ok || !receipt.missing.length) return '';
  const names = receipt.missing.map((m) => m.label).join(', ');
  return `Nicht gespeichert: ${names}. Diese Angaben stehen NICHT im Datenblatt und sind NICHT auf den Marktplätzen.`;
}

module.exports = {
  WATCHED_PATHS,
  buildWriteReceipt,
  formatReceiptWarning,
};
