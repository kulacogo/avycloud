'use strict';

/**
 * kamera.js — welche Aufnahmen stammen vom selben Geraet?
 *
 * In einem Tagesordner liegen die Fotos mehrerer Mitarbeiter durcheinander.
 * Gemessen am 17.08.2026: IMG_1205..IMG_1265 und IMG_4804..IMG_4805, zeitlich
 * ineinander verschraenkt. Wuerde man nur nach Aufnahmezeit vorzerteilen,
 * stuenden fremde Aufnahmen mitten in einer Produktserie.
 *
 * Die Dateinummer ist ein Zaehler JE GERAET. Die Trennung entsteht deshalb aus
 * der Luecke zwischen den tatsaechlich vorhandenen Nummern — nicht aus festen
 * Tausenderbloecken, denn ein Geraet, das von IMG_1999 auf IMG_2001 zaehlt,
 * wuerde dabei zerrissen.
 */

// Zwei aufeinanderfolgende Nummern desselben Geraets liegen dicht beieinander.
// Ein Sprung darueber hinaus spricht fuer ein anderes Geraet.
const MAX_NUMMERNSPRUNG = 300;

function zerlegeName(dateiname) {
  const ohneEndung = String(dateiname).replace(/\.[^.]+$/, '');
  const m = /^(.*?)(\d+)$/.exec(ohneEndung);
  if (!m) return { muster: ohneEndung.toUpperCase(), nummer: null };
  return { muster: m[1].toUpperCase(), nummer: Number(m[2]) };
}

/**
 * @param {string[]} dateinamen
 * @returns {Map<string, string>} Dateiname -> Kamera-Kennung
 */
function erkenneKameras(dateinamen = []) {
  const zuordnung = new Map();
  const nachMuster = new Map();

  for (const name of dateinamen) {
    const { muster, nummer } = zerlegeName(name);
    if (nummer == null) {
      // Ohne Nummer laesst sich nichts gruppieren — eigene Kennung, aber die
      // Datei geht nicht verloren.
      zuordnung.set(name, `${muster}#ohne-nummer`);
      continue;
    }
    if (!nachMuster.has(muster)) nachMuster.set(muster, []);
    nachMuster.get(muster).push({ name, nummer });
  }

  for (const [muster, eintraege] of nachMuster) {
    eintraege.sort((a, b) => a.nummer - b.nummer);
    let serie = 0;
    for (let i = 0; i < eintraege.length; i += 1) {
      if (i > 0 && eintraege[i].nummer - eintraege[i - 1].nummer > MAX_NUMMERNSPRUNG) serie += 1;
      zuordnung.set(eintraege[i].name, `${muster}#${serie}`);
    }
  }

  return zuordnung;
}

module.exports = { erkenneKameras, MAX_NUMMERNSPRUNG };
