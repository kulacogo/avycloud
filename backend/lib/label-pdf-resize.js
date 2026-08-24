/**
 * Versandetikett-PDF auf ein exaktes physisches Mass bringen.
 *
 * SendCloud liefert das Etikett in seinem eigenen Seitenmass (label_printer
 * entspricht ungefaehr A6, 105 x 148 mm). Der Etikettendrucker bekommt damit
 * eine Seite, die nicht zu seiner Rolle passt, und skaliert selbst — mit
 * Treiber-Voreinstellungen, die niemand kontrolliert. Ergebnis: verschobene
 * Raender, gestauchte Barcodes, im schlimmsten Fall ein abgeschnittener Code.
 *
 * Hier wird die Seite deshalb auf das Zielmass aus `lib/label-format.js`
 * umgesetzt: neue Seite in exakt der Rollengroesse, das Original
 * PROPORTIONAL hineingelegt und zentriert.
 *
 * ES WIRD NIE BESCHNITTEN. Ein Etikett randlos zu fuellen wuerde bedeuten,
 * ueberstehende Teile abzuschneiden — und das kann der Barcode sein. Lieber
 * zwei weisse Streifen als eine unscannbare Sendung.
 */

const { PDFDocument, degrees } = require('pdf-lib');

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;

/** Millimeter in PDF-Punkte (1 pt = 1/72 Zoll). */
const mmToPoints = (mm) => (mm / MM_PER_INCH) * POINTS_PER_INCH;

/**
 * Platzierung einer Seite auf der Zielseite berechnen.
 *
 * Reine Geometrie, ohne PDF-Abhaengigkeit — damit die Rechnung ohne echtes
 * PDF pruefbar ist. `drawPage` dreht um den Ankerpunkt (x, y); der Anker muss
 * je Drehwinkel anders gesetzt werden, damit das Ergebnis mittig liegt.
 *
 * @param {{srcWidth:number, srcHeight:number, targetWidth:number, targetHeight:number, rotation?:number}} input
 *   Masse in Punkten. `rotation` ist die Eigendrehung der Quellseite (/Rotate).
 * @returns {{x:number, y:number, width:number, height:number, rotation:number, scale:number}}
 *   `width`/`height` sind die Masse VOR der Drehung (so erwartet es drawPage).
 */
function computePlacement({ srcWidth, srcHeight, targetWidth, targetHeight, rotation = 0 }) {
  if (!(srcWidth > 0) || !(srcHeight > 0) || !(targetWidth > 0) || !(targetHeight > 0)) {
    throw new Error('computePlacement: Masse muessen positiv sein');
  }

  const ownRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;

  // Zwei Kandidaten: so lassen, oder zusaetzlich um 90 Grad drehen. Es gewinnt,
  // was groesser hineinpasst. Das ersetzt jede Hoch-/Querformat-Heuristik: ein
  // quer geliefertes Etikett landet automatisch hochkant auf der Rolle.
  const candidates = [0, 90].map((extra) => {
    const total = (ownRotation + extra) % 360;
    const swapped = total % 180 !== 0;
    // Abmessungen NACH der Drehung — daran wird eingepasst.
    const footprintW = swapped ? srcHeight : srcWidth;
    const footprintH = swapped ? srcWidth : srcHeight;
    const scale = Math.min(targetWidth / footprintW, targetHeight / footprintH);
    return { total, swapped, scale };
  });

  const best = candidates[0].scale >= candidates[1].scale ? candidates[0] : candidates[1];
  const { total, swapped, scale } = best;

  // Masse vor der Drehung — drawPage skaliert erst, dreht dann.
  const drawWidth = srcWidth * scale;
  const drawHeight = srcHeight * scale;
  // Platzbedarf nach der Drehung.
  const outWidth = swapped ? drawHeight : drawWidth;
  const outHeight = swapped ? drawWidth : drawHeight;

  const left = (targetWidth - outWidth) / 2;
  const bottom = (targetHeight - outHeight) / 2;

  // Ankerpunkt je Drehwinkel: die Drehung erfolgt um (x, y), deshalb wandert
  // der Anker auf die Ecke, die nach der Drehung unten links zu liegen kommt.
  let x = left;
  let y = bottom;
  if (total === 90) {
    x = left + outWidth;
    y = bottom;
  } else if (total === 180) {
    x = left + outWidth;
    y = bottom + outHeight;
  } else if (total === 270) {
    x = left;
    y = bottom + outHeight;
  }

  return { x, y, width: drawWidth, height: drawHeight, rotation: total, scale };
}

/**
 * Etikett-PDF auf das Zielmass umsetzen.
 *
 * @param {Buffer} buffer — das Original-PDF von SendCloud
 * @param {{widthMm:number, heightMm:number}} format — Zielmass
 * @returns {Promise<Buffer>} PDF mit Seiten in exakt diesem Mass
 * @throws wenn das PDF nicht lesbar ist — der Aufrufer MUSS das Original
 *   durchreichen. Ein unveraendertes Etikett ist brauchbar, gar keines nicht.
 */
/** Ab dieser Verkleinerung wird gewarnt (Barcode-Lesbarkeit). */
const SCALE_WARN_BELOW = 0.75;

async function resizeLabelPdf(buffer, format) {
  const { pdf } = await resizeLabelPdfWithScale(buffer, format);
  return pdf;
}

/**
 * Wie `resizeLabelPdf`, meldet zusaetzlich den Verkleinerungsfaktor der ERSTEN
 * Seite — das ist die Seite mit dem Barcode.
 *
 * @returns {Promise<{pdf: Buffer, scale: number|null}>}
 */
async function resizeLabelPdfWithScale(buffer, format) {
  if (!buffer || !buffer.length) throw new Error('resizeLabelPdf: leeres PDF');
  const targetWidth = mmToPoints(format.widthMm);
  const targetHeight = mmToPoints(format.heightMm);

  // `ignoreEncryption`: manche Transporteure liefern das Etikett mit gesetztem
  // (leerem) Besitzerpasswort. Das ist kein Kopierschutz im Sinne der Nutzung —
  // wir haben das Dokument selbst erzeugen lassen.
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  if (!pageCount) throw new Error('resizeLabelPdf: PDF ohne Seiten');

  const out = await PDFDocument.create();
  let ersteSkalierung = null;

  for (let index = 0; index < pageCount; index += 1) {
    const srcPage = source.getPage(index);
    const { width: srcWidth, height: srcHeight } = srcPage.getSize();
    const rotation = srcPage.getRotation()?.angle || 0;

    const embedded = await out.embedPage(srcPage);
    const placement = computePlacement({
      srcWidth,
      srcHeight,
      targetWidth,
      targetHeight,
      rotation,
    });
    if (index === 0) ersteSkalierung = placement.scale;

    const page = out.addPage([targetWidth, targetHeight]);
    page.drawPage(embedded, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: degrees(placement.rotation),
    });
  }

  const bytes = await out.save();
  return { pdf: Buffer.from(bytes), scale: ersteSkalierung };
}

/**
 * Bequemer Wrapper fuer den Web-Pfad: skaliert, faellt bei JEDEM Problem auf
 * das Original zurueck und meldet, was passiert ist.
 *
 * Der Aufrufer soll sich nicht um try/catch kuemmern muessen — die
 * Fail-open-Regel gehoert genau EINMAL hierher, nicht in jede Route.
 *
 * @returns {Promise<{buffer:Buffer, resized:boolean, reason?:string}>}
 */
async function resizeLabelPdfSafe(buffer, format) {
  if (!format) return { buffer, resized: false, reason: 'kein Zielformat' };
  try {
    const { pdf, scale } = await resizeLabelPdfWithScale(buffer, format);
    // Sichtbar machen, WIE stark verkleinert wurde. Ein Barcode hat eine
    // Mindest-Modulbreite; faellt er darunter, liest ihn der Handscanner im
    // Verteilzentrum nicht mehr zuverlaessig und die Sendung bleibt liegen.
    // SendCloud liefert ueber `label_printer` A6 (105x148) — auf die 62x100er
    // Briefrolle sind das rund 59 %.
    if (scale != null && scale < SCALE_WARN_BELOW) {
      console.warn(
        `[label-resize] Etikett stark verkleinert: ${Math.round(scale * 100)} % `
        + `(${format.key}, Ziel ${format.widthMm}x${format.heightMm} mm) — Barcode-Lesbarkeit pruefen.`
      );
    }
    return { buffer: pdf, resized: true, scale };
  } catch (err) {
    console.warn(`[label-resize] Original durchgereicht (${format.key}): ${err.message}`);
    return { buffer, resized: false, reason: err.message };
  }
}

module.exports = {
  SCALE_WARN_BELOW,
  mmToPoints,
  computePlacement,
  resizeLabelPdf,
  resizeLabelPdfWithScale,
  resizeLabelPdfSafe,
};
