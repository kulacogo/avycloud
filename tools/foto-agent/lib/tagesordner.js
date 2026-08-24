'use strict';

/**
 * tagesordner.js — entscheidet, ob ein Tagesordner bearbeitet werden darf.
 *
 * Zwei Bedingungen, beide aus der Praxis:
 *
 * 1. RUHEZEIT. Der Agent laeuft alle 30 Minuten und traefe einen Ordner sonst
 *    mitten in der Fotosession: die ersten drei Fotos eines Produkts waeren im
 *    einen Lauf, die restlichen im naechsten — und das erzeugt genau die
 *    Dublette, die dieser Umbau verhindern soll. Gemessen am 17.08.2026 lag
 *    die groesste Luecke INNERHALB einer Session bei 27,6 Minuten, deshalb
 *    liegt die Voreinstellung bei 30.
 *
 * 2. LOS. Die Erfassung verlangt eine Los-Zuordnung (Fehler LOT_REQUIRED) und
 *    aus einem Datumsordner laesst sie sich nicht ableiten. Der Agent raet
 *    NICHT — am Los haengt der Einkaufspreis, eine falsche Zuordnung faellt
 *    spaeter niemandem mehr auf. Stattdessen liegt eine Datei LOS.txt im
 *    Tagesordner; fehlt sie, bleibt der Ordner liegen und wird gemeldet.
 */

// Spiegelt backend/lib/warehouse-lots.js — hier nur, um frueh und mit klarer
// Meldung abzulehnen, statt den Server einen 400er schicken zu lassen.
const L_CODE_REGEX = /^L-(0[1-9]|1[0-2])(\d{2})(0[1-9]|[1-9]\d|1\d\d|200)$/;
const NL_CODE_REGEX = /^NL-(0[1-9]|1[0-2])(\d{2})$/;

const DEFAULT_RUHEZEIT_MINUTEN = 30;
const LOS_DATEINAME = 'LOS.txt';

/**
 * Liest den Los-Code aus dem Inhalt der LOS.txt.
 * Leerzeilen und Zeilen mit '#' werden uebergangen, damit ein Mensch
 * dazuschreiben kann, worum es sich handelt.
 * @returns {string|null} null, wenn kein eindeutig gueltiger Code drinsteht
 */
function leseLosCode(inhalt) {
  if (inhalt == null) return null;
  for (const zeile of String(inhalt).split(/\r?\n/)) {
    const kandidat = zeile.trim().toUpperCase();
    if (!kandidat || kandidat.startsWith('#')) continue;
    if (L_CODE_REGEX.test(kandidat) || NL_CODE_REGEX.test(kandidat)) return kandidat;
    // Erste inhaltliche Zeile ist kein gueltiger Code -> nicht weiterraten.
    return null;
  }
  return null;
}

/**
 * @param {object} args
 * @param {Date|null} args.neuesteAufnahme  juengste Aufnahmezeit im Ordner
 * @param {string|null} args.losInhalt      Inhalt der LOS.txt (null = fehlt)
 * @returns {{bereit: boolean, grund?: string, meldung?: string, losCode?: string}}
 */
function pruefeOrdner({ neuesteAufnahme, losInhalt, jetzt = new Date(), ruhezeitMinuten = DEFAULT_RUHEZEIT_MINUTEN } = {}) {
  if (!(neuesteAufnahme instanceof Date) || Number.isNaN(neuesteAufnahme.getTime())) {
    return { bereit: false, grund: 'leer', meldung: 'Keine Fotos im Ordner.' };
  }

  const losCode = leseLosCode(losInhalt);
  if (!losCode) {
    return {
      bereit: false,
      grund: 'los_fehlt',
      meldung: `Kein gueltiges Los. Bitte eine Datei ${LOS_DATEINAME} in den Tagesordner legen, die genau einen Code enthaelt (z. B. L-081703 oder NL-0826).`,
    };
  }

  const stillMinuten = (jetzt.getTime() - neuesteAufnahme.getTime()) / 60000;
  if (stillMinuten < ruhezeitMinuten) {
    return {
      bereit: false,
      grund: 'ruhezeit',
      meldung: `Letztes Foto vor ${Math.round(stillMinuten)} min — es wird vermutlich noch fotografiert. Wartet auf ${ruhezeitMinuten} min Ruhe.`,
      losCode,
    };
  }

  return { bereit: true, losCode };
}

module.exports = { leseLosCode, pruefeOrdner, LOS_DATEINAME, DEFAULT_RUHEZEIT_MINUTEN };
