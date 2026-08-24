'use strict';
// Etikett-PDF auf exaktes Rollenmass bringen. Zwei Ebenen:
//   1. Geometrie (computePlacement) — ohne PDF pruefbar
//   2. echter Durchlauf mit einem erzeugten PDF — beweist das Seitenmass
const { PDFDocument, degrees } = require('pdf-lib');
const {
  SCALE_WARN_BELOW,
  mmToPoints,
  computePlacement,
  resizeLabelPdf,
  resizeLabelPdfWithScale,
  resizeLabelPdfSafe,
} = require('../lib/label-pdf-resize');
const { PARCEL_FORMAT, LETTER_FORMAT } = require('../lib/label-format');

const A6_W = mmToPoints(105);
const A6_H = mmToPoints(148);

/** Ein PDF mit einer Seite bauen — Ersatz fuer ein echtes SendCloud-Etikett. */
async function makePdf({ widthMm, heightMm, rotation = 0, pages = 1 }) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([mmToPoints(widthMm), mmToPoints(heightMm)]);
    if (rotation) page.setRotation(degrees(rotation));
    // Etwas Inhalt, damit die Seite nicht leer ist.
    page.drawRectangle({ x: 5, y: 5, width: 20, height: 20 });
  }
  return Buffer.from(await doc.save());
}

const round = (n) => Math.round(n * 100) / 100;

describe('computePlacement: Einpassen ohne Beschnitt', () => {
  it('A6 in die Paketrolle: volle Breite, weisse Streifen oben und unten', () => {
    const p = computePlacement({
      srcWidth: A6_W,
      srcHeight: A6_H,
      targetWidth: mmToPoints(103),
      targetHeight: mmToPoints(164),
    });
    // Breite ist der Engpass (103/105 < 164/148) -> Skalierung ~0.981
    expect(round(p.scale)).toBe(0.98);
    // Nichts ragt heraus — das ist die eigentliche Zusicherung.
    expect(round(p.width)).toBeLessThanOrEqual(round(mmToPoints(103)));
    expect(round(p.height)).toBeLessThanOrEqual(round(mmToPoints(164)));
    expect(p.rotation).toBe(0);
  });

  it('zentriert: gleich viel Luft links wie rechts', () => {
    const targetWidth = mmToPoints(103);
    const targetHeight = mmToPoints(164);
    const p = computePlacement({ srcWidth: A6_W, srcHeight: A6_H, targetWidth, targetHeight });
    const links = p.x;
    const rechts = targetWidth - (p.x + p.width);
    expect(round(links)).toBe(round(rechts));
    const unten = p.y;
    const oben = targetHeight - (p.y + p.height);
    expect(round(unten)).toBe(round(oben));
  });

  it('Querformat-Quelle wird automatisch aufgerichtet', () => {
    // 148 breit x 105 hoch soll hochkant auf die Rolle — ohne Heuristik,
    // allein weil gedreht mehr hineinpasst.
    const p = computePlacement({
      srcWidth: A6_H,
      srcHeight: A6_W,
      targetWidth: mmToPoints(103),
      targetHeight: mmToPoints(164),
    });
    expect(p.rotation % 180).toBe(90);
  });

  it('Eigendrehung der Quellseite wird mitgerechnet', () => {
    const p = computePlacement({
      srcWidth: A6_W,
      srcHeight: A6_H,
      targetWidth: mmToPoints(103),
      targetHeight: mmToPoints(164),
      rotation: 90,
    });
    // 90 (eigen) + 90 (aufrichten) = 180: wieder hochkant, aber kopfrichtig.
    expect(p.rotation % 180).toBe(0);
  });

  it('bleibt bei jedem Drehwinkel innerhalb der Zielseite', () => {
    const targetWidth = mmToPoints(62);
    const targetHeight = mmToPoints(100);
    for (const rotation of [0, 90, 180, 270]) {
      const p = computePlacement({
        srcWidth: A6_W, srcHeight: A6_H, targetWidth, targetHeight, rotation,
      });
      const swapped = p.rotation % 180 !== 0;
      const outW = swapped ? p.height : p.width;
      const outH = swapped ? p.width : p.height;
      // Ecke unten links nach der Drehung
      const left = p.rotation === 90 || p.rotation === 180 ? p.x - outW : p.x;
      const bottom = p.rotation === 180 || p.rotation === 270 ? p.y - outH : p.y;
      expect(round(left)).toBeGreaterThanOrEqual(0);
      expect(round(bottom)).toBeGreaterThanOrEqual(0);
      expect(round(left + outW)).toBeLessThanOrEqual(round(targetWidth));
      expect(round(bottom + outH)).toBeLessThanOrEqual(round(targetHeight));
    }
  });

  it('weist unsinnige Masse zurueck', () => {
    expect(() => computePlacement({ srcWidth: 0, srcHeight: 10, targetWidth: 10, targetHeight: 10 }))
      .toThrow(/positiv/);
  });
});

describe('resizeLabelPdf: echtes PDF', () => {
  it('DHL/DPD: Seite ist danach exakt 103 x 164 mm', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const out = await resizeLabelPdf(src, PARCEL_FORMAT);
    const doc = await PDFDocument.load(out);
    const { width, height } = doc.getPage(0).getSize();
    expect(round(width)).toBe(round(mmToPoints(103)));
    expect(round(height)).toBe(round(mmToPoints(164)));
  });

  it('Deutsche Post: Seite ist danach exakt 62 x 100 mm', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const out = await resizeLabelPdf(src, LETTER_FORMAT);
    const doc = await PDFDocument.load(out);
    const { width, height } = doc.getPage(0).getSize();
    expect(round(width)).toBe(round(mmToPoints(62)));
    expect(round(height)).toBe(round(mmToPoints(100)));
  });

  it('ein bereits passendes Etikett bleibt masshaltig', async () => {
    const src = await makePdf({ widthMm: 103, heightMm: 164 });
    const out = await resizeLabelPdf(src, PARCEL_FORMAT);
    const doc = await PDFDocument.load(out);
    const { width, height } = doc.getPage(0).getSize();
    expect(round(width)).toBe(round(mmToPoints(103)));
    expect(round(height)).toBe(round(mmToPoints(164)));
  });

  it('mehrseitige Etiketten behalten alle Seiten', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148, pages: 3 });
    const out = await resizeLabelPdf(src, PARCEL_FORMAT);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it('gedreht geliefertes Etikett wird trotzdem masshaltig', async () => {
    const src = await makePdf({ widthMm: 148, heightMm: 105, rotation: 90 });
    const out = await resizeLabelPdf(src, PARCEL_FORMAT);
    const doc = await PDFDocument.load(out);
    const { width, height } = doc.getPage(0).getSize();
    expect(round(width)).toBe(round(mmToPoints(103)));
    expect(round(height)).toBe(round(mmToPoints(164)));
  });
});

describe('resizeLabelPdfSafe: Fail-open', () => {
  it('gibt bei kaputtem PDF das Original zurueck statt zu werfen', async () => {
    const muell = Buffer.from('kein PDF');
    const res = await resizeLabelPdfSafe(muell, PARCEL_FORMAT);
    expect(res.resized).toBe(false);
    expect(res.buffer).toBe(muell);
    expect(res.reason).toBeTruthy();
  });

  it('ohne Zielformat wird nichts angefasst', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const res = await resizeLabelPdfSafe(src, null);
    expect(res.resized).toBe(false);
    expect(res.buffer).toBe(src);
  });

  it('meldet resized:true wenn es geklappt hat', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const res = await resizeLabelPdfSafe(src, LETTER_FORMAT);
    expect(res.resized).toBe(true);
    expect(res.buffer).not.toBe(src);
  });
});

describe('Verkleinerungsfaktor sichtbar machen', () => {
  // Ein Barcode hat eine Mindest-Modulbreite. Faellt er darunter, liest ihn der
  // Handscanner im Verteilzentrum nicht mehr zuverlaessig und die Sendung
  // bleibt liegen. SendCloud liefert ueber `label_printer` A6 (105x148) —
  // daraus wird auf der 62x100er Briefrolle rund 59 %. Das darf nicht still
  // passieren.
  it('A6 auf die Paketrolle ist praktisch unveraendert (98 %)', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const res = await resizeLabelPdfSafe(src, PARCEL_FORMAT);
    expect(Math.round(res.scale * 100)).toBe(98);
  });

  it('A6 auf die Briefrolle schrumpft auf 59 % — gemessen, nicht geschaetzt', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const res = await resizeLabelPdfSafe(src, LETTER_FORMAT);
    expect(Math.round(res.scale * 100)).toBe(59);
    expect(res.scale).toBeLessThan(SCALE_WARN_BELOW);
  });

  it('resizeLabelPdfWithScale liefert PDF und Faktor zusammen', async () => {
    const src = await makePdf({ widthMm: 105, heightMm: 148 });
    const { pdf, scale } = await resizeLabelPdfWithScale(src, PARCEL_FORMAT);
    const doc = await PDFDocument.load(pdf);
    expect(round(doc.getPage(0).getSize().width)).toBe(round(mmToPoints(103)));
    expect(scale).toBeGreaterThan(0);
  });

  it('ohne Skalierung gibt es keinen Faktor', async () => {
    const res = await resizeLabelPdfSafe(Buffer.from('kein pdf'), PARCEL_FORMAT);
    expect(res.scale).toBeUndefined();
  });
});
