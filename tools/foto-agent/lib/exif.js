'use strict';

/**
 * exif.js — Aufnahmezeit aus einem JPEG lesen, ohne Zusatzpaket.
 *
 * Warum das noetig ist: die Dateizeit auf dem Foto-Share ist die KOPIERZEIT,
 * nicht die Aufnahmezeit. Gemessen am 18.08.2026 trugen alle 63 Dateien des
 * 17.08. die mtime 13:49, waehrend die echten Aufnahmen von 13:38 bis 15:29
 * liefen. Nach Dateizeit zu gruppieren wuerde also einen ganzen Tag zu einem
 * einzigen Zeitpunkt verschmelzen.
 *
 * Weg durch die Datei: JPEG-Segmente -> APP1 ("Exif\0\0") -> TIFF-Header
 * (Byteordnung + IFD0-Offset) -> IFD0 -> Tag 0x8769 (Exif-IFD) ->
 * Tag 0x9003 (DateTimeOriginal, ASCII "YYYY:MM:DD HH:MM:SS").
 */

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;

function parseExifDatum(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || '').trim());
  if (!m) return null;
  const [, jahr, monat, tag, stunde, minute, sekunde] = m.map(Number);
  // EXIF kennt keine Zeitzone; die Kamera schreibt Ortszeit. Genau so lesen wir es.
  const datum = new Date(jahr, monat - 1, tag, stunde, minute, sekunde);
  if (Number.isNaN(datum.getTime())) return null;
  // Kameras schreiben bei fehlender Uhr "0000:00:00 00:00:00".
  if (jahr < 1990 || monat < 1 || monat > 12 || tag < 1 || tag > 31) return null;
  return datum;
}

function leseIfd(buf, tiffStart, ifdOffset, littleEndian, gesucht) {
  const u16 = (o) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const basis = tiffStart + ifdOffset;
  if (basis + 2 > buf.length) return null;

  const anzahl = u16(basis);
  const treffer = {};
  for (let i = 0; i < anzahl; i += 1) {
    const eintrag = basis + 2 + i * 12;
    if (eintrag + 12 > buf.length) break;
    const tag = u16(eintrag);
    if (!gesucht.includes(tag)) continue;

    const typ = u16(eintrag + 2);
    const anzahlWerte = u32(eintrag + 4);

    if (typ === 4) {                       // LONG -> Zeiger
      treffer[tag] = u32(eintrag + 8);
    } else if (typ === 2) {                // ASCII
      const laenge = anzahlWerte;
      const start = laenge <= 4 ? eintrag + 8 : tiffStart + u32(eintrag + 8);
      if (start + laenge <= buf.length) {
        treffer[tag] = buf.toString('ascii', start, start + laenge).replace(/\0+$/, '');
      }
    }
  }
  return treffer;
}

/**
 * @param {Buffer} buffer  Anfang der JPEG-Datei (die ersten ~64 KB genuegen)
 * @returns {Date|null}
 */
function leseAufnahmezeit(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // kein JPEG

    let pos = 2;
    while (pos + 4 <= buffer.length) {
      if (buffer[pos] !== 0xff) { pos += 1; continue; }
      const marker = buffer[pos + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break; // ab hier Bilddaten

      const segmentLaenge = buffer.readUInt16BE(pos + 2);
      const segmentStart = pos + 4;

      if (marker === 0xe1 && buffer.toString('ascii', segmentStart, segmentStart + 6) === 'Exif\0\0') {
        const tiffStart = segmentStart + 6;
        if (tiffStart + 8 > buffer.length) return null;

        const ordnung = buffer.toString('ascii', tiffStart, tiffStart + 2);
        if (ordnung !== 'II' && ordnung !== 'MM') return null;
        const littleEndian = ordnung === 'II';
        const u32 = (o) => (littleEndian ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));

        const ifd0 = leseIfd(buffer, tiffStart, u32(tiffStart + 4), littleEndian, [TAG_EXIF_IFD]);
        const exifOffset = ifd0 && ifd0[TAG_EXIF_IFD];
        if (!exifOffset) return null;

        const exifIfd = leseIfd(buffer, tiffStart, exifOffset, littleEndian, [
          TAG_DATE_TIME_ORIGINAL, TAG_DATE_TIME_DIGITIZED,
        ]);
        if (!exifIfd) return null;
        return parseExifDatum(exifIfd[TAG_DATE_TIME_ORIGINAL] || exifIfd[TAG_DATE_TIME_DIGITIZED]);
      }

      pos = segmentStart + segmentLaenge - 2;
    }
    return null;
  } catch {
    // Ein kaputtes Foto darf den Lauf nie abbrechen.
    return null;
  }
}

module.exports = { leseAufnahmezeit };
