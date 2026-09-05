'use strict';

/**
 * packshot-composite.js — Studio-Packshot OHNE das Produkt neu zu zeichnen.
 *
 * ============================================================================
 * WARUM (Betreiber 2026-09-04: "kein sauberer Hintergrund, kein Geraderücken,
 * keine Studio-Beschattung" — davor: "Produkt weicht vom Original ab").
 *
 * Gemessen an der echten API über ~50 Läufe: JEDER Durchgang durch ein
 * Bildmodell ist ein vollständiges Neurendern. Es gibt kein "nur ein bisschen".
 * Selbst ein Lauf, der das Bild scheinbar unverändert zurückgab (Änderung 4 %),
 * hatte verfälschten Kleindruck: "Eu.Promotions Group Halding comparly" statt
 * "Holding company", "www.fec.org" statt "www.fsc.org". Über 21 Prompt-Läufe in
 * 6 Fassungen wurde der kopfstehende Textblock AUSNAHMSLOS beschädigt —
 * "glaskoch B. Koch jr. GmbH … 33014 Bad Driburg" wurde zu "gleskooh B. Kosh Jr.
 * GnibH … 39014 Bed Driburg". Ein erfundener Herstellername auf einem
 * Angebotsbild ist eine falsche Produktangabe.
 *
 * DIE LÖSUNG: das Bildmodell liefert nur noch die SEGMENTIERUNG. Seine Pixel
 * werden weggeworfen. In das fertige Bild gehen ausschliesslich ORIGINALPIXEL.
 * Damit ist der Kleindruck bauartbedingt unversehrt — nicht erbeten, erzwungen.
 * Zweitmeinung hat das Zeichen für Zeichen bestätigt, inklusive ß, Makron und
 * Kyrillisch.
 *
 * FALLSTRICK, teuer gelernt: die Maskenquelle darf KEINEN Schatten bestellen.
 * Der gemalte Schatten ist nicht weiss, zählt damit als Produkt — und darunter
 * lag im Original die Hand. In 3 von 3 Läufen kam so die Hand ins Endbild
 * zurück. Der Schatten entsteht deshalb hier, deterministisch aus der Silhouette.
 *
 * FAIL-CLOSED (Lehre aus Incident 2026-07-18, zerstörte Produkte durch einen
 * schwellenwert-basierten Freisteller): fällt eine der Wachen, wird KEIN
 * Packshot geliefert. Der Aufrufer behält dann sein Original. Lieber kein Bild
 * als ein zerfallenes Produkt.
 * ============================================================================
 *
 * Reine Bibliothek: kein Netzzugriff, kein Firestore, kein GCS.
 */

const sharp = require('sharp');

/** Ab welcher Dunkelheit ein Pixel der Maskenquelle als Produkt gilt. */
const SCHWELLE = 228;
/** Auf dieser Kantenlänge wird die Maske gerechnet (niederfrequent, skaliert gut hoch). */
const MASKEN_KANTE = 1200;
/** Kantenlänge der fertigen Leinwand. */
const LEINWAND = 2000;
/**
 * Produkt füllt so viel der Leinwand. BEWUSST NICHT höher: der Kontaktschatten
 * braucht darunter Platz, sonst wird er am Bildrand abgeschnitten und steht als
 * dunkler Balken da (gemessen 2026-09-04).
 */
const FUELLGRAD = 0.78;
/** Drehung wird gedeckelt — eine falsche Vierteldrehung ist schlimmer als eine schiefe Kante. */
const MAX_DREHUNG_GRAD = 12;

function zahl(env, fallback) {
  const raw = parseFloat(process.env[env]);
  return Number.isFinite(raw) ? raw : fallback;
}

/** Nur der exakte Wert 'off' schaltet ab (Hausregel wie bei AUTO_INVOICE). */
function compositeEnabled() {
  return String(process.env.STUDIO_COMPOSITE || '').trim() !== 'off';
}

// ---------------------------------------------------------------------------
// Maske aus der Weissgrund-Aufnahme
// ---------------------------------------------------------------------------

/**
 * Binarisiert die Maskenquelle: alles, was dunkler als die Schwelle ist, gilt
 * als Produkt. Die Quelle zeigt das Produkt auf reinweissem Grund, deshalb
 * trennt eine einfache Schwelle hier sauber — anders als beim alten Freisteller,
 * der auf dem ECHTEN Foto mit Lagerhintergrund arbeiten musste.
 */
async function binarisiere(genBuffer) {
  const bild = sharp(genBuffer).resize(MASKEN_KANTE, MASKEN_KANTE, {
    fit: 'inside',
    withoutEnlargement: false,
  });
  const { data, info } = await bild.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: k } = info;
  const maske = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += k, p += 1) {
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    maske[p] = min < SCHWELLE ? 1 : 0;
  }
  return { maske, w, h };
}

/**
 * Behält nur die grösste zusammenhängende Fläche. Ein Produkt ist EIN Objekt;
 * verstreute Flecken sind Rauschen oder Reste des Hintergrunds.
 * 4er-Nachbarschaft, iterativ (kein Rekursions-Stapelüberlauf bei 1,4 Mio Pixeln).
 */
function groessteKomponente(maske, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let beste = null;
  let besteGroesse = 0;
  let gesamt = 0;
  let aktuell = 0;

  for (let start = 0; start < maske.length; start += 1) {
    if (!maske[start] || label[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = aktuell;
    let groesse = 0;
    while (sp > 0) {
      const p = stack[--sp];
      groesse += 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && maske[p - 1] && label[p - 1] === -1) { label[p - 1] = aktuell; stack[sp++] = p - 1; }
      if (x < w - 1 && maske[p + 1] && label[p + 1] === -1) { label[p + 1] = aktuell; stack[sp++] = p + 1; }
      if (y > 0 && maske[p - w] && label[p - w] === -1) { label[p - w] = aktuell; stack[sp++] = p - w; }
      if (y < h - 1 && maske[p + w] && label[p + w] === -1) { label[p + w] = aktuell; stack[sp++] = p + w; }
    }
    gesamt += groesse;
    if (groesse > besteGroesse) { besteGroesse = groesse; beste = aktuell; }
    aktuell += 1;
  }

  const out = new Uint8Array(w * h);
  if (beste === null) return { maske: out, groesse: 0, anteilGroesste: 0 };
  for (let p = 0; p < out.length; p += 1) out[p] = label[p] === beste ? 1 : 0;
  return { maske: out, groesse: besteGroesse, anteilGroesste: gesamt ? besteGroesse / gesamt : 0 };
}

/**
 * Füllt Löcher: was vom Bildrand aus NICHT erreichbar ist, liegt innerhalb des
 * Produkts und gehört dazu. Ohne diesen Schritt werden helle Produktflächen
 * (weisse Kartonfelder, Chrom) durchsichtig — genau der Schaden aus dem
 * Freisteller-Vorfall 2026-07-18.
 */
function fuelleLoecher(maske, w, h) {
  const aussen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const schiebe = (p) => { if (!maske[p] && !aussen[p]) { aussen[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x += 1) { schiebe(x); schiebe((h - 1) * w + x); }
  for (let y = 0; y < h; y += 1) { schiebe(y * w); schiebe(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) schiebe(p - 1);
    if (x < w - 1) schiebe(p + 1);
    if (y > 0) schiebe(p - w);
    if (y < h - 1) schiebe(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p += 1) out[p] = aussen[p] ? 0 : 1;
  return out;
}

/**
 * Echte morphologische Erosion über ein separables Minimum-Filter.
 * BEWUSST NICHT über sharp .blur(): das schrumpft nur um etwa r/2 und rundet
 * Ecken ab. Die Erosion zieht den Rand nach innen, damit kein Saum des alten
 * Hintergrunds am Produkt kleben bleibt.
 */
function erodiere(maske, w, h, r) {
  if (r <= 0) return maske;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const zeile = y * w;
    for (let x = 0; x < w; x += 1) {
      let min = 1;
      const von = Math.max(0, x - r);
      const bis = Math.min(w - 1, x + r);
      for (let i = von; i <= bis; i += 1) { if (!maske[zeile + i]) { min = 0; break; } }
      tmp[zeile + x] = min;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let min = 1;
      const von = Math.max(0, y - r);
      const bis = Math.min(h - 1, y + r);
      for (let i = von; i <= bis; i += 1) { if (!tmp[i * w + x]) { min = 0; break; } }
      out[y * w + x] = min;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------------

function konvexeHuelle(punkte) {
  if (punkte.length < 3) return punkte;
  const pts = [...punkte].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const kreuz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const unten = [];
  for (const p of pts) {
    while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], p) <= 0) unten.pop();
    unten.push(p);
  }
  const oben = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], p) <= 0) oben.pop();
    oben.push(p);
  }
  unten.pop(); oben.pop();
  return unten.concat(oben);
}

/**
 * Drehwinkel aus dem flächenkleinsten umschliessenden Rechteck (rotierende
 * Schieblehre auf der konvexen Hülle).
 * BILDMOMENTE TAUGEN HIER NICHT — bei einem nahezu quadratischen Karton ist die
 * Hauptachse zufällig und kippt das Bild um 45 Grad.
 */
function winkelMinRechteck(maske, w, h) {
  const rand = [];
  for (let y = 0; y < h; y += 1) {
    let links = -1;
    let rechts = -1;
    for (let x = 0; x < w; x += 1) {
      if (maske[y * w + x]) { if (links < 0) links = x; rechts = x; }
    }
    if (links >= 0) { rand.push([links, y]); rand.push([rechts, y]); }
  }
  if (rand.length < 3) return 0;
  const huelle = konvexeHuelle(rand);
  if (huelle.length < 3) return 0;

  let besteFlaeche = Infinity;
  let besterWinkel = 0;
  for (let i = 0; i < huelle.length; i += 1) {
    const a = huelle[i];
    const b = huelle[(i + 1) % huelle.length];
    const phi = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-phi);
    const sin = Math.sin(-phi);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const p of huelle) {
      const px = p[0] * cos - p[1] * sin;
      const py = p[0] * sin + p[1] * cos;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const flaeche = (maxX - minX) * (maxY - minY);
    if (flaeche < besteFlaeche) { besteFlaeche = flaeche; besterWinkel = phi; }
  }

  // Auf die nächste Vierteldrehung normieren: wir richten nur GERADE, wir
  // drehen nicht um 90 Grad. Die Leserichtung darf nicht geraten werden.
  let grad = (besterWinkel * 180) / Math.PI;
  grad = ((grad % 90) + 90) % 90;
  if (grad > 45) grad -= 90;
  if (Math.abs(grad) > MAX_DREHUNG_GRAD) return 0;
  return grad;
}

function bereichAusMaske(maske, w, h) {
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  let flaeche = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!maske[y * w + x]) continue;
      flaeche += 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, breite: maxX - minX + 1, hoehe: maxY - minY + 1, flaeche };
}

// ---------------------------------------------------------------------------
// Wachen
// ---------------------------------------------------------------------------

/**
 * FAIL-CLOSED. Jede Wache, die fällt, verhindert die Ausgabe komplett.
 * Der Aufrufer behält dann sein Original — das ist immer noch ein echtes Foto.
 */
/**
 * Wie viele BILDRÄNDER die Maske berührt. Eine saubere Maskenquelle zeigt das
 * Produkt freigestellt auf Weiss — es klebt dann höchstens an ein bis zwei
 * Rändern. Klebt es an drei oder vier, hat das Modell den Hintergrund NICHT
 * entfernt (Hand, Kiste, Tisch hängen noch dran) und die Maske umfasst mehr als
 * das Produkt. Gemessen: genau so kamen Hand und blaue Kiste ins Endbild.
 */
function randberuehrungen(maske, w, h) {
  let oben = 0; let unten = 0; let links = 0; let rechts = 0;
  for (let x = 0; x < w; x += 1) {
    if (maske[x]) oben += 1;
    if (maske[(h - 1) * w + x]) unten += 1;
  }
  for (let y = 0; y < h; y += 1) {
    if (maske[y * w]) links += 1;
    if (maske[y * w + w - 1]) rechts += 1;
  }
  // Ein paar Pixel sind Rauschen; erst ab 2 % der Kantenlänge zählt es.
  const schwelleX = w * 0.02;
  const schwelleY = h * 0.02;
  return [oben > schwelleX, unten > schwelleX, links > schwelleY, rechts > schwelleY]
    .filter(Boolean).length;
}

/**
 * Kompaktheit (Solidität): Maskenfläche geteilt durch die Fläche ihrer konvexen
 * Hülle. Ein Produkt ist ein kompakter Körper und liegt typisch über 0,9.
 *
 * DIESE WACHE FÄNGT DEN TEURSTEN FEHLER: hat das Modell den Hintergrund nicht
 * sauber entfernt, hängen Hand, Kiste oder Tischkante als Ausläufer an der
 * Produktfläche. Die Fläche wächst dann kaum, die konvexe Hülle aber stark —
 * die Solidität bricht ein. Gemessen an einem Lauf, bei dem Hand und blaue Kiste
 * im Ergebnis standen: die Bounding-Box-Prüfungen liessen ihn durch, die
 * Solidität nicht.
 */
function solid(maske, w, h) {
  const rand = [];
  for (let y = 0; y < h; y += 1) {
    let links = -1;
    let rechts = -1;
    for (let x = 0; x < w; x += 1) {
      if (maske[y * w + x]) { if (links < 0) links = x; rechts = x; }
    }
    if (links >= 0) { rand.push([links, y]); rand.push([rechts, y]); }
  }
  if (rand.length < 6) return 0;
  const huelle = konvexeHuelle(rand);
  if (huelle.length < 3) return 0;
  let a2 = 0;
  for (let i = 0; i < huelle.length; i += 1) {
    const p = huelle[i];
    const q = huelle[(i + 1) % huelle.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  const huellFlaeche = Math.abs(a2) / 2;
  if (huellFlaeche <= 0) return 0;
  let flaeche = 0;
  for (let i = 0; i < maske.length; i += 1) if (maske[i]) flaeche += 1;
  return flaeche / huellFlaeche;
}

function pruefeMaske({ anteilGroesste, deckung, seitenAbweichung, raender, solidität }) {
  const minKomponente = zahl('STUDIO_MASK_MIN_COMPONENT', 90) / 100;
  const gruende = [];
  if (deckung < 0.05) gruende.push(`zu_wenig_produkt(${(deckung * 100).toFixed(1)}%)`);
  if (deckung > 0.95) gruende.push(`kein_hintergrund_erkannt(${(deckung * 100).toFixed(1)}%)`);
  if (anteilGroesste < minKomponente) {
    gruende.push(`produkt_zerfaellt(groesste_flaeche=${(anteilGroesste * 100).toFixed(1)}%)`);
  }
  if (seitenAbweichung > 0.02) {
    gruende.push(`maskenquelle_verschoben(${(seitenAbweichung * 100).toFixed(1)}%)`);
  }
  if (raender >= 3) {
    gruende.push(`hintergrund_nicht_entfernt(${raender}_raender_beruehrt)`);
  }
  const minSolid = zahl('STUDIO_MASK_MIN_SOLIDITY', 0.9);
  if (solidität < minSolid) {
    gruende.push(`maske_nicht_kompakt(${(solidität * 100).toFixed(1)}%)`);
  }
  return { ok: gruende.length === 0, gruende };
}

// ---------------------------------------------------------------------------
// Hauptweg
// ---------------------------------------------------------------------------

/**
 * Baut den Packshot: ORIGINALPIXEL durch die Maske auf reinweiss, gerade
 * gerückt, mittig, mit deterministischem Kontaktschatten.
 *
 * @param {Buffer} originalBuffer Das ECHTE Foto in voller Auflösung
 * @param {Buffer} maskenQuelle   Die Weissgrund-Aufnahme des Bildmodells
 * @returns {Promise<{ok:true, buffer:Buffer, width:number, height:number, info:Object}
 *                  | {ok:false, gruende:string[]}>}
 */
async function bauePackshot(originalBuffer, maskenQuelle) {
  // EXIF anwenden, damit Original und Maskenquelle dieselbe Orientierung haben.
  const original = await sharp(originalBuffer).rotate().toBuffer();
  const oMeta = await sharp(original).metadata();
  const gMeta = await sharp(maskenQuelle).metadata();

  const oSeite = (oMeta.width || 1) / (oMeta.height || 1);
  const gSeite = (gMeta.width || 1) / (gMeta.height || 1);
  const seitenAbweichung = Math.abs(oSeite - gSeite) / oSeite;

  const roh = await binarisiere(maskenQuelle);
  const komp = groessteKomponente(roh.maske, roh.w, roh.h);
  const gefuellt = fuelleLoecher(komp.maske, roh.w, roh.h);

  const grob = bereichAusMaske(gefuellt, roh.w, roh.h);
  if (!grob) return { ok: false, gruende: ['keine_maske'] };

  const erosionPct = zahl('STUDIO_MASK_EROSION_PCT', 1) / 100;
  const r = Math.max(1, Math.round(grob.breite * erosionPct));
  const maske = erodiere(gefuellt, roh.w, roh.h, r);

  const bereich = bereichAusMaske(maske, roh.w, roh.h);
  if (!bereich) return { ok: false, gruende: ['maske_nach_erosion_leer'] };

  const deckung = bereich.flaeche / (roh.w * roh.h);
  const raender = randberuehrungen(maske, roh.w, roh.h);
  const solidität = solid(maske, roh.w, roh.h);
  const wache = pruefeMaske({
    anteilGroesste: komp.anteilGroesste, deckung, seitenAbweichung, raender, solidität,
  });
  if (!wache.ok) return { ok: false, gruende: wache.gruende };

  const winkel = winkelMinRechteck(maske, roh.w, roh.h);

  // Maske als Graustufenbild, auf die ORIGINALGRÖSSE hochskaliert. Die Maske ist
  // niederfrequent — hochskalieren kostet nichts. Umgekehrt (Produkt auf
  // Maskengrösse verkleinern) kostete 27 % Schärfe im Kleindruck.
  // DIE MASKE MUSS IM ALPHAKANAL LIEGEN, nicht in der Helligkeit.
  // `blend:'dest-in'` behält das Ziel dort, wo die QUELLE ALPHA hat. Ein
  // Graustufen-PNG ohne Alphakanal hat überall Alpha 255 — dann wird NICHTS
  // maskiert und es kommt schlicht das Originalfoto zurück, mit Hand und
  // Lagerhintergrund. Genau dieser Fehler kostete zwei Anläufe: die Maske war
  // korrekt, sie wurde nur nie angewendet.
  const rgba = Buffer.alloc(roh.w * roh.h * 4);
  for (let p = 0; p < maske.length; p += 1) {
    rgba[p * 4 + 3] = maske[p] ? 255 : 0; // RGB bleibt 0, nur Alpha trägt die Maske
  }
  const maskePng = await sharp(rgba, { raw: { width: roh.w, height: roh.h, channels: 4 } })
    .resize(oMeta.width, oMeta.height, { fit: 'fill' })
    .blur(2) // weiche 2-px-Feder gegen harte Treppenkanten
    // `.png()` ist ZWINGEND: bei RAW-Eingabe ohne Ausgabeformat liefert
    // toBuffer() wieder Rohdaten, und composite() kann die nicht lesen.
    .png()
    .toBuffer();

  // Originalpixel + Maske als Alpha → Produkt freigestellt, Pixel unangetastet.
  const freigestellt = await sharp(original)
    .ensureAlpha()
    .composite([{ input: maskePng, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Auf den Produktbereich zuschneiden (in Originalkoordinaten).
  const sx = (oMeta.width || 1) / roh.w;
  const sy = (oMeta.height || 1) / roh.h;
  const left = Math.max(0, Math.floor(bereich.minX * sx));
  const top = Math.max(0, Math.floor(bereich.minY * sy));
  const breite = Math.min((oMeta.width || 1) - left, Math.ceil(bereich.breite * sx));
  const hoehe = Math.min((oMeta.height || 1) - top, Math.ceil(bereich.hoehe * sy));
  if (breite < 8 || hoehe < 8) return { ok: false, gruende: ['produkt_zu_klein'] };

  // extract und rotate NIE in derselben Pipeline mischen — rotate liefe zuerst.
  let produkt = await sharp(freigestellt).extract({ left, top, width: breite, height: hoehe }).png().toBuffer();
  if (Math.abs(winkel) >= 0.5) {
    produkt = await sharp(produkt)
      .rotate(-winkel, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .trim({ threshold: 1 })
      .png()
      .toBuffer();
  }

  const pMeta = await sharp(produkt).metadata();

  // NIE VERGRÖSSERN (Korrektur 2026-09-04). Vorher wurde jedes Produkt auf
  // LEINWAND × FUELLGRAD gezogen — ein 980-px-Ausschnitt also auf 1560 px, das
  // 1,6-fache. Das ist reine Qualitätsvernichtung: die Galeriebilder sind
  // ohnehin schon auf 1200 px normalisiert, mehr Pixel gibt es nicht. Die
  // Leinwand richtet sich jetzt nach dem Produkt, nicht umgekehrt.
  const langeKante = Math.max(pMeta.width || 1, pMeta.height || 1);
  const leinwand = Math.min(
    LEINWAND,
    Math.max(800, Math.round(Math.min(langeKante, LEINWAND * FUELLGRAD) / FUELLGRAD))
  );
  const zielKante = Math.round(leinwand * FUELLGRAD);
  const skaliert = await sharp(produkt)
    .resize(zielKante, zielKante, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const sMeta = await sharp(skaliert).metadata();
  const pw = sMeta.width || zielKante;
  const ph = sMeta.height || zielKante;
  const px = Math.round((leinwand - pw) / 2);
  const py = Math.round((leinwand - ph) / 2);

  const schatten = await baueKontaktschatten(skaliert, pw, ph);

  const packshot = await sharp({
    create: { width: leinwand, height: leinwand, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: schatten.buffer, left: px + schatten.dx, top: py + ph + schatten.dy },
      { input: skaliert, left: px, top: py },
    ])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const randOk = await pruefeRand(packshot);
  if (!randOk.ok) return { ok: false, gruende: [randOk.grund] };

  return {
    ok: true,
    buffer: packshot,
    width: leinwand,
    height: leinwand,
    info: {
      deckung: +(deckung * 100).toFixed(1),
      anteilGroessteFlaeche: +(komp.anteilGroesste * 100).toFixed(1),
      drehungGrad: +winkel.toFixed(2),
      erosionPx: r,
      randberuehrungen: raender,
      soliditaet: +(solidität * 100).toFixed(1),
      produktQuelle: `${pMeta.width}x${pMeta.height}`,
      leinwand,
      // TATSAECHLICHE Skalierung (nach withoutEnlargement), nicht die angestrebte.
      skalierung: +(Math.max(pw, ph) / langeKante).toFixed(2),
    },
  };
}

/**
 * Kontaktschatten aus der SILHOUETTE, nicht als Rechteck. Ein Rechteck ergibt
 * den grauen Balken, den niemand für einen Schatten hält.
 */
async function baueKontaktschatten(produktPng, pw, ph) {
  const hoehe = Math.max(6, Math.round(ph * 0.05));
  const alpha = await sharp(produktPng)
    .ensureAlpha()
    .extractChannel('alpha')
    .toColourspace('b-w')
    .png()
    .toBuffer();

  // NUR DIE UNTERSTEN ZEILEN — die AUFSTANDSFLÄCHE (Korrektur 2026-09-04).
  // Vorher wurde das untere DRITTEL der Silhouette gestaucht: bei einem Produkt,
  // dessen Seitenkante schräg verläuft, ragte der Schatten dadurch weit über die
  // Standfläche hinaus und stand als grauer Balken neben dem Produkt.
  // Ein Kontaktschatten liegt da, wo das Objekt den Boden berührt — sonst nirgends.
  const bandHoehe = Math.max(2, Math.round(ph * 0.04));
  const zuschnitt = await sharp(alpha)
    .extract({ left: 0, top: Math.max(0, ph - bandHoehe), width: pw, height: bandHoehe })
    .resize(pw, hoehe, { fit: 'fill' })
    .png()
    .toBuffer();
  const unteres = await sharp(zuschnitt).removeAlpha().toColourspace('b-w').raw().toBuffer();

  const data = unteres;
  const deckkraft = zahl('STUDIO_SHADOW_OPACITY', 0.30);
  const out = Buffer.alloc(pw * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    // Nach unten ausblenden (Potenz 1,5) — nah am Produkt dunkel, dann weich weg.
    const abfall = Math.pow(1 - y / hoehe, 1.5);
    for (let x = 0; x < pw; x += 1) {
      out[y * pw + x] = Math.round(data[y * pw + x] * abfall * deckkraft);
    }
  }

  // Wie bei der Produktmaske: die Staerke gehoert in den ALPHAKANAL. Ein raw-
  // Puffer mit channels:1 gilt als Graustufe OHNE Alpha — `dest-in` liesse dann
  // das volle graue Rechteck stehen, und genau das erschien als schwarzer Balken
  // unter dem Produkt (gemessen 2026-09-04).
  const rgba = Buffer.alloc(pw * hoehe * 4);
  for (let p = 0; p < out.length; p += 1) {
    rgba[p * 4] = 40;
    rgba[p * 4 + 1] = 40;
    rgba[p * 4 + 2] = 40;
    rgba[p * 4 + 3] = out[p];
  }
  const schatten = await sharp(rgba, { raw: { width: pw, height: hoehe, channels: 4 } })
    .blur(Math.max(2, pw * 0.012))
    .png()
    .toBuffer();

  // Leicht unter die Unterkante schieben, damit er anliegt statt zu schweben.
  return { buffer: schatten, dx: 0, dy: -Math.round(hoehe * 0.55) };
}

/**
 * Schlusskontrolle: der äussere Rahmen MUSS reinweiss sein. Ist er es nicht,
 * ragt Hintergrund oder Hand ins Bild — dann lieber gar kein Packshot.
 */
async function pruefeRand(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  const d = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  const streifen = [
    { left: 0, top: 0, width: w, height: d },
    { left: 0, top: h - d, width: w, height: d },
    { left: 0, top: 0, width: d, height: h },
    { left: w - d, top: 0, width: d, height: h },
  ];
  for (const s of streifen) {
    const teil = await sharp(buffer).extract(s).removeAlpha().toBuffer();
    const stats = await sharp(teil).stats();
    for (const kanal of stats.channels.slice(0, 3)) {
      if (kanal.min < 250) return { ok: false, grund: `rand_nicht_weiss(${kanal.min})` };
    }
  }
  return { ok: true };
}

module.exports = {
  bauePackshot,
  compositeEnabled,
  _internal: {
    binarisiere,
    groessteKomponente,
    fuelleLoecher,
    erodiere,
    winkelMinRechteck,
    randberuehrungen,
    solid,
    bereichAusMaske,
    pruefeMaske,
    pruefeRand,
    baueKontaktschatten,
    SCHWELLE,
    LEINWAND,
  },
};
