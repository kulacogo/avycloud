const { test } = require('node:test');
const assert = require('node:assert');
const { leseAufnahmezeit } = require('../lib/exif');

// Warum ein eigener EXIF-Leser: die Aufnahmezeit ist das einzige verlaessliche
// Ordnungsmerkmal der Fotos. Die Dateizeit taugt NICHT — auf dem Share tragen
// ganze Tagesstapel dieselbe Kopierzeit (gemessen 2026-08-18: 63 Dateien vom
// 17.08. mit mtime 13:49, echte Aufnahmezeiten 13:38 bis 15:29).
//
// Der Leser kommt ohne Zusatzpaket aus: JPEG APP1 -> TIFF-Header -> IFD0 ->
// Exif-IFD -> DateTimeOriginal (0x9003).

/** Baut ein minimales JPEG mit genau einem EXIF-DateTimeOriginal. */
function jpegMitAufnahmezeit(datum, { bigEndian = false } = {}) {
  const wert = Buffer.from(`${datum}\0`, 'ascii'); // 20 Bytes
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + wert.length);
  let o = 0;
  const w16 = (v) => { bigEndian ? tiff.writeUInt16BE(v, o) : tiff.writeUInt16LE(v, o); o += 2; };
  const w32 = (v) => { bigEndian ? tiff.writeUInt32BE(v, o) : tiff.writeUInt32LE(v, o); o += 4; };

  tiff.write(bigEndian ? 'MM' : 'II', o, 'ascii'); o += 2;
  w16(42);            // TIFF-Magie
  w32(8);             // Offset IFD0

  // IFD0: ein Eintrag, Zeiger aufs Exif-IFD
  w16(1);
  w16(0x8769); w16(4); w32(1); w32(26); // ExifIFDPointer -> Offset 26
  w32(0);                                // kein IFD1

  // Exif-IFD bei Offset 26: ein Eintrag DateTimeOriginal
  const wertOffset = 26 + 2 + 12 + 4;
  w16(1);
  w16(0x9003); w16(2); w32(wert.length); w32(wertOffset);
  w32(0);
  wert.copy(tiff, o);

  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const laenge = Buffer.alloc(2);
  laenge.writeUInt16BE(app1.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),        // SOI
    Buffer.from([0xff, 0xe1]), laenge, app1,
    Buffer.from([0xff, 0xd9]),        // EOI
  ]);
}

test('liest die Aufnahmezeit aus einem JPEG (little endian)', () => {
  const zeit = leseAufnahmezeit(jpegMitAufnahmezeit('2026:08:17 13:38:49'));
  assert.ok(zeit instanceof Date);
  assert.strictEqual(zeit.getFullYear(), 2026);
  assert.strictEqual(zeit.getMonth(), 7);
  assert.strictEqual(zeit.getDate(), 17);
  assert.strictEqual(zeit.getHours(), 13);
  assert.strictEqual(zeit.getMinutes(), 38);
  assert.strictEqual(zeit.getSeconds(), 49);
});

test('liest auch big-endian EXIF (Motorola-Byteordnung)', () => {
  const zeit = leseAufnahmezeit(jpegMitAufnahmezeit('2026:01:02 03:04:05', { bigEndian: true }));
  assert.strictEqual(zeit.getMonth(), 0);
  assert.strictEqual(zeit.getHours(), 3);
});

test('liefert null statt zu werfen, wenn kein EXIF da ist', () => {
  assert.strictEqual(leseAufnahmezeit(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.strictEqual(leseAufnahmezeit(Buffer.alloc(0)), null);
  assert.strictEqual(leseAufnahmezeit(Buffer.from('kein jpeg')), null);
});

test('liefert null bei unsinnigem Datum statt eines Invalid Date', () => {
  const zeit = leseAufnahmezeit(jpegMitAufnahmezeit('0000:00:00 00:00:00'));
  assert.strictEqual(zeit, null);
});
