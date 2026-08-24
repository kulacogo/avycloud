'use strict';

/**
 * register.js — zweite "erledigt"-Markierung neben dem Verschieben nach IDENT.
 *
 * Das Verschieben ist die eigentliche Markierung. Es gibt aber ein Fenster:
 * die Erfassung war erfolgreich, das Verschieben scheitert (SMB-Aussetzer,
 * Datei gerade in Benutzung). Ohne zweite Markierung liefe dieselbe Datei alle
 * 30 Minuten erneut durch die Erkennung — das kostet Gemini-Aufrufe UND legt
 * neue Dubletten an.
 *
 * Deshalb: Erfolg wird SOFORT nach der Erfassung vermerkt, bevor verschoben
 * wird. Schluessel ist der Inhalts-Hash, nicht der Dateiname — eine umbenannte
 * oder erneut abgelegte Datei wird damit wiedererkannt.
 */

const fs = require('node:fs');
const path = require('node:path');

function ladeRegister(pfad) {
  try {
    const roh = fs.readFileSync(pfad, 'utf8');
    const daten = JSON.parse(roh);
    return daten && typeof daten === 'object' && !Array.isArray(daten) ? daten : {};
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // Leer weiterzumachen ist vertretbar: in RAW liegen ohnehin nur Dateien,
      // die noch nicht verschoben wurden. Aber es muss auffallen.
      console.warn(`[register] ${pfad} nicht lesbar (${err.message}) — starte mit leerem Register.`);
    }
    return {};
  }
}

function speichereRegister(pfad, register) {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  // Erst daneben schreiben, dann umbenennen: ein Absturz mitten im Schreiben
  // darf kein halbes Register hinterlassen.
  const temp = `${pfad}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(register, null, 2), 'utf8');
  fs.renameSync(temp, pfad);
}

function istErledigt(register, hash) {
  return Boolean(register?.[hash]?.erledigtAm);
}

function merkeErledigt(register, hash, info = {}) {
  register[hash] = {
    ...(register[hash] || {}),
    ...info,
    erledigtAm: new Date().toISOString(),
  };
  return register;
}

function merkeFehlversuch(register, hash, fehler) {
  const vorher = register[hash] || {};
  register[hash] = {
    ...vorher,
    versuche: (vorher.versuche || 0) + 1,
    letzterFehler: String(fehler || 'unbekannt').slice(0, 400),
    letzterVersuchAm: new Date().toISOString(),
  };
  return register;
}

function istAufgegeben(register, hash, maxVersuche) {
  const eintrag = register?.[hash];
  if (!eintrag || eintrag.erledigtAm) return false;
  return (eintrag.versuche || 0) >= maxVersuche;
}

module.exports = {
  ladeRegister, speichereRegister, istErledigt, merkeErledigt, merkeFehlversuch, istAufgegeben,
};
