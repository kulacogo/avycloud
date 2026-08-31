/**
 * Findet den tatsaechlich BEDRUCKTEN Bereich einer Etikettenseite.
 *
 * WOZU: SendCloud liefert Versandetiketten als A6-Seite (105 x 148 mm), aber der
 * Inhalt belegt davon oft nur einen Streifen — beim Deutsche-Post-Maxibrief
 * gemessen 34,5 x 70,1 mm, also 15,5 %. Passt man die GANZE Seite auf die
 * 62 x 100-mm-Briefrolle ein, schrumpft der Inhalt auf 59 % und der
 * Frankier-Code landet bei ~7 mm — zu klein zum sicheren Lesen.
 *
 * Schneidet man dagegen auf den bedruckten Bereich zu, passt derselbe Inhalt mit
 * Faktor 1,43 auf dieselbe Rolle: 2,4-mal groesser als vorher.
 *
 * WARUM OHNE RASTERER: Das Produktions-Image ist `node:20-slim` — kein Poppler,
 * kein Ghostscript. Der Kasten wird deshalb aus den Zeichenbefehlen berechnet:
 * Text ueber `getTextContent()`, Bilder und Pfade ueber die Operatorliste mit
 * eigener Matrix-Verfolgung. Gegen einen gerasterten Referenzwert geprueft:
 * Abweichung unter 1 mm (2026-08-31, echtes DP-Etikett).
 */

const MM_PER_PT = 25.4 / 72;
const ptToMm = (pt) => pt * MM_PER_PT;
const mmToPt = (mm) => mm / MM_PER_PT;

/** Sicherheitsrand um den erkannten Inhalt. Lieber etwas Luft als ein angeschnittener Barcode. */
const DEFAULT_MARGIN_MM = 2.5;

/**
 * Deckt der Kasten fast die ganze Seite, gibt es nichts zu gewinnen — dann wird
 * NICHT zugeschnitten (jeder Zuschnitt waere nur zusaetzliches Risiko).
 */
const MAX_COVERAGE = 0.92;

/**
 * Winziger Kasten = die Erkennung hat vermutlich etwas uebersehen. Fail-open.
 * 1,5 % entspricht rund 15 x 15 mm auf A6 — darunter ist kein echtes Etikett.
 */
const MIN_COVERAGE = 0.015;

function leererKasten() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function nimmPunkt(k, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < k.minX) k.minX = x;
  if (x > k.maxX) k.maxX = x;
  if (y < k.minY) k.minY = y;
  if (y > k.maxY) k.maxY = y;
}

function istLeer(k) {
  return !Number.isFinite(k.minX) || !Number.isFinite(k.maxX) || k.maxX <= k.minX || k.maxY <= k.minY;
}

/** Matrizen verketten (PDF-Konvention [a b c d e f]). */
function mal(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const anwenden = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Textkasten einsammeln.
 *
 * `width`/`height` sind bei pdf.js bereits LAENGEN im Nutzerraum, keine
 * Textraum-Groessen. Bei gedrehtem Text — und genau so zeichnet SendCloud das
 * DP-Etikett — darf man sie deshalb NICHT entlang x/y auftragen, sondern muss
 * die Richtungsvektoren der Matrix nutzen. Sonst wandert der Kasten um
 * Hunderte Millimeter daneben (gemessen: y bis -299 mm).
 */
function sammleText(kasten, items) {
  let stellen = 0;
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = it.transform;
    if (!Array.isArray(t) || t.length < 6) continue;
    const [a, b, c, d, e, f] = t;
    const laufLaenge = Math.hypot(a, b) || 1;
    const hochLaenge = Math.hypot(c, d) || 1;
    const ux = a / laufLaenge;
    const uy = b / laufLaenge;
    const vx = c / hochLaenge;
    const vy = d / hochLaenge;
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    for (const [s, u] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      nimmPunkt(kasten, e + ux * s + vx * u, f + uy * s + vy * u);
    }
    stellen += 1;
  }
  return stellen;
}

/**
 * Bilder und gezeichnete Pfade einsammeln.
 *
 * WICHTIG — Beschneidungspfade zaehlen NICHT als Inhalt. Das erste, was ein
 * SendCloud-Etikett tut, ist die ganze Seite als Clip zu setzen; wuerde man das
 * mitzaehlen, waere der Kasten immer die volle Seite und der Zuschnitt
 * wirkungslos. Ein Pfad zaehlt erst, wenn er auch GEMALT wird (fill/stroke).
 */
function sammleOperatoren(kasten, opListe, OPS) {
  let bilder = 0;
  let pfade = 0;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stapel = [];
  let offenerPfad = null;

  for (let i = 0; i < opListe.fnArray.length; i += 1) {
    const fn = opListe.fnArray[i];
    const args = opListe.argsArray[i];

    if (fn === OPS.save) {
      stapel.push(ctm.slice());
    } else if (fn === OPS.restore) {
      ctm = stapel.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
      ctm = mal(ctm, args);
    } else if (
      fn === OPS.paintImageXObject
      || fn === OPS.paintInlineImageXObject
      || fn === OPS.paintImageMaskXObject
    ) {
      // Ein Bild wird immer ins Einheitsquadrat gezeichnet und von der
      // aktuellen Matrix an seinen Platz gebracht.
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [x, y] = anwenden(ctm, dx, dy);
        nimmPunkt(kasten, x, y);
      }
      bilder += 1;
    } else if (fn === OPS.constructPath) {
      offenerPfad = { koordinaten: args && args[1], ctm: ctm.slice() };
    } else if (
      fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke
      || fn === OPS.fillStroke || fn === OPS.eoFillStroke
      || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke || fn === OPS.closeStroke
    ) {
      const k = offenerPfad;
      if (k && k.koordinaten && k.koordinaten.length >= 2) {
        for (let j = 0; j + 1 < k.koordinaten.length; j += 2) {
          const [x, y] = anwenden(k.ctm, k.koordinaten[j], k.koordinaten[j + 1]);
          nimmPunkt(kasten, x, y);
        }
        pfade += 1;
      }
      offenerPfad = null;
    } else if (fn === OPS.clip || fn === OPS.eoClip) {
      // Beschneidung ist kein Inhalt — verwerfen.
      offenerPfad = null;
    }
  }
  return { bilder, pfade };
}

/**
 * Bedruckten Bereich der ersten Seite bestimmen.
 *
 * @param {Buffer} buffer — das Etikett-PDF
 * @param {{marginMm?: number}} [opts]
 * @returns {Promise<null|{left:number,bottom:number,right:number,top:number,
 *   widthMm:number,heightMm:number,coverage:number,quellen:object}>}
 *   Masse in PDF-Punkten (fuer `embedPage`). `null` = nicht zuschneiden.
 */
async function findInkBox(buffer, opts = {}) {
  const marginMm = Number.isFinite(opts.marginMm) ? opts.marginMm : DEFAULT_MARGIN_MM;
  // Erst hier laden: pdfjs ist gross und wird nur fuers Freistellen gebraucht.
  //
  // pdf.js versucht beim Laden, `DOMMatrix`/`Path2D` ueber das native Paket
  // `canvas` zu ergaenzen, und warnt lautstark, wenn es fehlt. Wir ZEICHNEN
  // nie — wir lesen nur Positionen — deshalb genuegen leere Platzhalter. Ohne
  // sie steht bei jedem ersten Etikett eine irrefuehrende Warnung im
  // Produktionsprotokoll.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {};
  }
  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = class Path2D {};
  }
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    // Ohne Canvas im Image: nur lesen, nie zeichnen.
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const sicht = page.getViewport({ scale: 1 });
    const seiteBreite = sicht.width;
    const seiteHoehe = sicht.height;

    const kasten = leererKasten();
    const stellen = sammleText(kasten, (await page.getTextContent()).items);
    const { bilder, pfade } = sammleOperatoren(kasten, await page.getOperatorList(), pdfjs.OPS);

    if (istLeer(kasten)) return null;

    const rand = mmToPt(marginMm);
    const left = Math.max(0, kasten.minX - rand);
    const bottom = Math.max(0, kasten.minY - rand);
    const right = Math.min(seiteBreite, kasten.maxX + rand);
    const top = Math.min(seiteHoehe, kasten.maxY + rand);
    if (right <= left || top <= bottom) return null;

    const coverage = ((right - left) * (top - bottom)) / (seiteBreite * seiteHoehe);
    // Fail-open in beide Richtungen: fast volle Seite -> nichts zu gewinnen;
    // winziger Kasten -> die Erkennung hat vermutlich etwas uebersehen.
    if (coverage > MAX_COVERAGE || coverage < MIN_COVERAGE) return null;

    return {
      left,
      bottom,
      right,
      top,
      widthMm: ptToMm(right - left),
      heightMm: ptToMm(top - bottom),
      coverage,
      quellen: { textStellen: stellen, bilder, pfade },
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** Wie `findInkBox`, wirft aber nie — der Aufrufer soll die ganze Seite nehmen. */
async function findInkBoxSafe(buffer, opts) {
  try {
    return await findInkBox(buffer, opts);
  } catch (err) {
    console.warn(`[label-ink] Bedruckten Bereich nicht bestimmbar: ${err.message}`);
    return null;
  }
}

module.exports = {
  DEFAULT_MARGIN_MM,
  MAX_COVERAGE,
  MIN_COVERAGE,
  ptToMm,
  mmToPt,
  findInkBox,
  findInkBoxSafe,
};
