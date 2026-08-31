'use strict';
// Freistellen des bedruckten Bereichs.
//
// SendCloud liefert Versandetiketten als A6-Seite. Beim Deutsche-Post-Maxibrief
// belegt der Inhalt davon nur 15,5 % — passt man die GANZE Seite auf die
// 62x100er Briefrolle ein, schrumpft er auf 59 % und der Frankier-Code landet
// bei ~7 mm. Gemessen am echten Etikett (2026-08-31): mit Freistellen 133 %.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const {
  findInkBox, findInkBoxSafe, ptToMm, mmToPt, MAX_COVERAGE,
} = require('../lib/label-ink-box');

/** A6-Seite mit Inhalt in einem bekannten Rechteck (Angaben in mm, Ursprung unten links). */
async function a6Mit({ x, y, breite, hoehe, text = 'AvyCloud Testetikett' }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mmToPt(105), mmToPt(148)]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({
    x: mmToPt(x), y: mmToPt(y), width: mmToPt(breite), height: mmToPt(hoehe),
    borderWidth: 1, borderColor: rgb(0, 0, 0),
  });
  page.drawText(text, { x: mmToPt(x + 2), y: mmToPt(y + hoehe / 2), size: 9, font });
  return Buffer.from(await doc.save());
}

const rund = (n) => Math.round(n * 10) / 10;

describe('findInkBox', () => {
  it('findet einen Inhalt, der nur einen Teil der Seite belegt', async () => {
    const pdf = await a6Mit({ x: 30, y: 40, breite: 40, hoehe: 60 });
    const k = await findInkBox(pdf, { marginMm: 0 });
    expect(k).not.toBeNull();
    // Der Rahmen liegt bei 30..70 / 40..100 mm — Toleranz fuer Linienbreite
    // und Schriftmetrik.
    expect(rund(ptToMm(k.left))).toBeGreaterThanOrEqual(29);
    expect(rund(ptToMm(k.left))).toBeLessThanOrEqual(31);
    expect(rund(ptToMm(k.right))).toBeGreaterThanOrEqual(69);
    expect(rund(ptToMm(k.right))).toBeLessThanOrEqual(72);
    expect(rund(ptToMm(k.bottom))).toBeGreaterThanOrEqual(39);
    expect(rund(ptToMm(k.top))).toBeLessThanOrEqual(101);
  });

  it('legt den Sicherheitsrand aussen herum', async () => {
    const ohne = await findInkBox(await a6Mit({ x: 30, y: 40, breite: 40, hoehe: 60 }), { marginMm: 0 });
    const mit = await findInkBox(await a6Mit({ x: 30, y: 40, breite: 40, hoehe: 60 }), { marginMm: 5 });
    // Lieber etwas Luft als ein angeschnittener Barcode.
    expect(ptToMm(mit.left)).toBeLessThan(ptToMm(ohne.left));
    expect(ptToMm(mit.right)).toBeGreaterThan(ptToMm(ohne.right));
    expect(rund(ptToMm(ohne.left) - ptToMm(mit.left))).toBeCloseTo(5, 0);
  });

  it('ragt der Rand ueber die Seite hinaus, wird an der Seitenkante gekappt', async () => {
    const k = await findInkBox(await a6Mit({ x: 2, y: 2, breite: 40, hoehe: 40 }), { marginMm: 20 });
    expect(k.left).toBe(0);
    expect(k.bottom).toBe(0);
  });

  it('fuellt der Inhalt die Seite fast aus, wird NICHT freigestellt', async () => {
    // Nichts zu gewinnen — jeder Zuschnitt waere nur zusaetzliches Risiko.
    // Das ist der DHL/DPD-Fall: deren Etiketten fuellen die A6-Seite bereits.
    const k = await findInkBox(await a6Mit({ x: 1, y: 1, breite: 103, hoehe: 146 }), { marginMm: 0 });
    expect(k).toBeNull();
  });

  it('eine leere Seite liefert null statt eines erfundenen Kastens', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([mmToPt(105), mmToPt(148)]);
    expect(await findInkBox(Buffer.from(await doc.save()))).toBeNull();
  });

  it('MAX_COVERAGE liegt unter 1 — sonst waere die Schranke wirkungslos', () => {
    expect(MAX_COVERAGE).toBeLessThan(1);
    expect(MAX_COVERAGE).toBeGreaterThan(0.5);
  });
});

describe('findInkBoxSafe: Fail-open', () => {
  it('wirft bei Muell nicht, sondern liefert null', async () => {
    // null bedeutet "ganze Seite einpassen" — das bisherige Verhalten.
    expect(await findInkBoxSafe(Buffer.from('kein PDF'))).toBeNull();
  });

  it('leerer Puffer liefert null', async () => {
    expect(await findInkBoxSafe(Buffer.alloc(0))).toBeNull();
  });
});
