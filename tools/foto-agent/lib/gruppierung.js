'use strict';

/**
 * gruppierung.js — Vorzerteilung der Tagesfotos in handliche Bloecke.
 *
 * WICHTIG: dieser Schritt entscheidet NICHT, was ein Produkt ist. Das macht die
 * Bilderkennung (POST /api/v2/group-images). Hier geht es nur darum, einem
 * Aufruf nicht 63 Fotos auf einmal vorzuwerfen — und dabei niemals mitten
 * durch eine Fotoserie zu schneiden.
 *
 * Warum die Zeit allein nicht reicht (gemessen am 17.08.2026, 63 Fotos):
 * Luecken zwischen zwei Aufnahmen reichen von 2 s bis 27,6 min bei einem Median
 * von 12 s. Eine Trennschwelle von 30 s ergaebe 22 Bloecke, 60 s ergaebe 14,
 * 90 s ergaebe 11 — Faktor zwei Unterschied. Deshalb trennt der Vorzerteiler
 * nur, wo die Luecke so gross ist, dass die Trennung sicher ist.
 */

const DEFAULT_MAX_LUECKE_MINUTEN = 20;
const DEFAULT_MAX_PRO_BLOCK = 12;

/**
 * @param {Array<{pfad: string, kamera: string, zeit: Date|null}>} fotos
 * @param {{maxLueckeMinuten?: number, maxProBlock?: number}} opts
 * @returns {Array<Array<object>>}
 */
function zerlegeNachAufnahme(fotos = [], opts = {}) {
  const maxLuecke = (opts.maxLueckeMinuten ?? DEFAULT_MAX_LUECKE_MINUTEN) * 60 * 1000;
  const maxProBlock = opts.maxProBlock ?? DEFAULT_MAX_PRO_BLOCK;
  if (!fotos.length) return [];

  // Fotos ohne lesbare Aufnahmezeit gehen NICHT verloren — sie bilden eigene
  // Bloecke je Kamera. Wuerden sie hier wegfallen, blieben sie fuer immer in
  // RAW liegen und wuerden bei jedem Lauf erneut betrachtet.
  const mitZeit = fotos.filter((f) => f.zeit instanceof Date && !Number.isNaN(f.zeit.getTime()));
  const ohneZeit = fotos.filter((f) => !(f.zeit instanceof Date) || Number.isNaN(f.zeit.getTime()));

  const nachKamera = new Map();
  for (const foto of mitZeit) {
    const schluessel = foto.kamera || 'unbekannt';
    if (!nachKamera.has(schluessel)) nachKamera.set(schluessel, []);
    nachKamera.get(schluessel).push(foto);
  }

  const bloecke = [];
  for (const serie of nachKamera.values()) {
    serie.sort((a, b) => a.zeit - b.zeit);

    let aktuell = [serie[0]];
    for (let i = 1; i < serie.length; i += 1) {
      if (serie[i].zeit - serie[i - 1].zeit > maxLuecke) {
        bloecke.push(aktuell);
        aktuell = [];
      }
      aktuell.push(serie[i]);
    }
    if (aktuell.length) bloecke.push(aktuell);
  }

  const ohneZeitNachKamera = new Map();
  for (const foto of ohneZeit) {
    const schluessel = foto.kamera || 'unbekannt';
    if (!ohneZeitNachKamera.has(schluessel)) ohneZeitNachKamera.set(schluessel, []);
    ohneZeitNachKamera.get(schluessel).push(foto);
  }
  for (const serie of ohneZeitNachKamera.values()) bloecke.push(serie);

  return bloecke.flatMap((block) => teileZuGrosseBloecke(block, maxProBlock));
}

/**
 * Teilt einen zu grossen Block rekursiv an seiner GROESSTEN inneren Luecke.
 * Stumpf nach Anzahl abzuschneiden wuerde mit hoher Wahrscheinlichkeit mitten
 * in eine Fotoserie fallen; an der groessten Luecke ist ein Produktwechsel am
 * wahrscheinlichsten.
 */
function teileZuGrosseBloecke(block, maxProBlock) {
  if (block.length <= maxProBlock) return [block];

  let besterIndex = -1;
  let groessteLuecke = -1;
  for (let i = 1; i < block.length; i += 1) {
    const a = block[i - 1].zeit;
    const b = block[i].zeit;
    const luecke = a instanceof Date && b instanceof Date ? b - a : 0;
    if (luecke > groessteLuecke) { groessteLuecke = luecke; besterIndex = i; }
  }

  // Keine verwertbare Luecke (z.B. Bloecke ohne Zeit): in der Mitte teilen.
  if (besterIndex <= 0 || besterIndex >= block.length) besterIndex = Math.ceil(block.length / 2);

  return [
    ...teileZuGrosseBloecke(block.slice(0, besterIndex), maxProBlock),
    ...teileZuGrosseBloecke(block.slice(besterIndex), maxProBlock),
  ];
}

module.exports = { zerlegeNachAufnahme, DEFAULT_MAX_LUECKE_MINUTEN, DEFAULT_MAX_PRO_BLOCK };
