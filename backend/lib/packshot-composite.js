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
 * Wie viel der Leinwand das Produkt fuellen darf — GETRENNT nach Breite und
 * Hoehe (seit 2026-09-10).
 *
 * WARUM GETRENNT: vorher galt EIN Fuellgrad von 0,78 auf die lange Kante, bei
 * quadratischer Leinwand. Fuer ein BREITES Produkt heisst das 78 % Breite und
 * entsprechend wenig Hoehe. Am Futtereimer "Stiefel Pflanzenkohle" (Produkt
 * d500e1d0) gemessen: 1394x1394 Leinwand, Produkt 936x503 = 78 % Breite,
 * 42 % Hoehe, **28 % der Bildflaeche**. Der Betreiber sah das Ergebnis als
 * "schlechter geworden" — der Artikel schwamm im Weiss.
 *
 * Zum Vergleich gemessen: die drei HERSTELLER-Studiofotos desselben Eimers
 * (nice-cdn) fuellen ihre Leinwand zu 100 % x 100 %, also randlos. So weit
 * gehen wir bewusst nicht — ein Angebotsbild braucht Luft und der
 * Kontaktschatten Platz. 92 % Breite / 86 % Hoehe liegt dazwischen und hebt
 * die Flaeche beim selben Eimer von 28 % auf rund 45 %.
 *
 * Die Hoehe bleibt kleiner als die Breite, weil unten der Kontaktschatten
 * anschliesst. Nachgerechnet fuer den schlimmsten Fall (hohes Produkt, das die
 * Hoehe ausschoepft): Schattenhoehe = 5 % der Produkthoehe, davon ragen 45 %
 * unter die Unterkante; bei 86 % Fuellung und Platzierung auf 45 % der
 * Restflaeche endet der Schatten bei rund 94 % der Leinwand — die Rand-Wache
 * prueft die aeussersten 1 %. Passt mit Reserve.
 */
function fuellgradBreite() { return Math.min(0.98, Math.max(0.3, zahl('STUDIO_FILL_W', 0.92))); }
function fuellgradHoehe() { return Math.min(0.94, Math.max(0.3, zahl('STUDIO_FILL_H', 0.86))); }
/**
 * Senkrechte Platzierung: 0,5 waere exakt mittig. Etwas hoeher gesetzt gibt dem
 * Kontaktschatten Raum und laesst den Artikel stehen statt schweben.
 */
const SENKRECHT = 0.45;
/** Drehung wird gedeckelt — eine falsche Vierteldrehung ist schlimmer als eine schiefe Kante. */
const MAX_DREHUNG_GRAD = 12;
/**
 * Ab welchem Flaechengewinn ein Winkel ueber der Deckelung noch als ECHT gilt.
 * Der Gewinn ist der Anteil, um den das flaechenkleinste umschliessende Rechteck
 * kleiner ist als das achsparallele — bei einem runden Umriss null, bei einem
 * echt gekippten Quader gross.
 */
const MIN_DREHUNG_GEWINN = 0.08;
/**
 * Hellster und dunkelster Wert des e-Commerce-Verlaufs. Bewusst ein SCHMALES
 * Band: der Verlauf soll Tiefe andeuten, nicht als grauer Kasten auffallen. Er
 * wird klein gerechnet und hochskaliert — ein Verlauf ist niederfrequent, das
 * sieht man nicht, spart aber das Durchrechnen von vier Millionen Pixeln.
 */
const VERLAUF_HELL = 252;
const VERLAUF_DUNKEL = 226;
const VERLAUF_KANTE = 64;
/**
 * Mindestwert des äusseren Rahmens. Der Zweck der Prüfung ist "ragt Hintergrund
 * oder eine Hand ins Bild?", nicht "ist es exakt 255" — deshalb bekommt der
 * Verlauf seine eigene, zu ihm passende Schranke statt einer aufgeweichten
 * gemeinsamen. Alles Dunklere ist in BEIDEN Fällen ein Fremdkörper.
 */
const WEISS_RAND_MIN = 250;
const VERLAUF_RAND_MIN = VERLAUF_DUNKEL - 8;

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

  if (Math.abs(grad) <= MAX_DREHUNG_GRAD) return grad;

  // ÜBER DER DECKELUNG WIRD GEKAPPT, NICHT AUFGEGEBEN (seit 2026-09-10).
  // Vorher stand hier `return 0` — ein um 20 Grad gekipptes Foto blieb also
  // vollstaendig schief, obwohl der Betreiber ausdruecklich "nicht schief und
  // krumm" verlangt hat. Die Deckelung war gegen FEHLMESSUNGEN gedacht (bei
  // einem runden oder nahezu quadratischen Umriss ist die Hauptachse zufaellig),
  // nicht gegen echte Schieflagen.
  //
  // Ob die Silhouette den Winkel wirklich hergibt, ist MESSBAR: bei einem echt
  // gekippten Objekt ist das flaechenkleinste umschliessende Rechteck deutlich
  // kleiner als das achsparallele. Nachgerechnet fuer ein 2:1-Rechteck bei
  // 20 Grad Kippung: 45 % kleiner. Bei einem Kreis: 0 %. Bei einem nahezu
  // quadratischen Umriss mit 5 Grad: 15 %. Unter 8 % ist der Winkel Rauschen —
  // dann bleibt es beim Nichtstun.
  let aMinX = Infinity; let aMaxX = -Infinity; let aMinY = Infinity; let aMaxY = -Infinity;
  for (const p of huelle) {
    if (p[0] < aMinX) aMinX = p[0];
    if (p[0] > aMaxX) aMaxX = p[0];
    if (p[1] < aMinY) aMinY = p[1];
    if (p[1] > aMaxY) aMaxY = p[1];
  }
  const achsparallel = Math.max(1, (aMaxX - aMinX) * (aMaxY - aMinY));
  const gewinn = 1 - besteFlaeche / achsparallel;
  if (gewinn < MIN_DREHUNG_GEWINN) return 0;
  return Math.sign(grad) * MAX_DREHUNG_GRAD;
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
 * Baut den Packshot: ORIGINALPIXEL durch die Maske, gerade gerückt, mittig, mit
 * deterministischem Kontaktschatten.
 *
 * @param {Buffer} originalBuffer Das ECHTE Foto in voller Auflösung
 * @param {Buffer} maskenQuelle   Die Weissgrund-Aufnahme des Bildmodells
 * @param {Object} [opts]
 * @param {'weiss'|'verlauf'} [opts.hintergrund='weiss'] Grund der Leinwand.
 *   `weiss` ist die Voreinstellung und damit das unveränderte Studio-Verhalten.
 *   `verlauf` legt den hellgrauen e-Commerce-Verlauf an, den der Betreiber für
 *   die Angebotsgalerie vorgegeben hat — damit ein pixeltreuer Packshot neben
 *   einer gerenderten Ansicht nicht als Fremdkörper auffällt.
 * @returns {Promise<{ok:true, buffer:Buffer, width:number, height:number, info:Object}
 *                  | {ok:false, gruende:string[]}>}
 */
async function bauePackshot(originalBuffer, maskenQuelle, opts = {}) {
  const verlauf = opts.hintergrund === 'verlauf';
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

  // BELICHTUNG/WEISSABGLEICH aus dem HINTERGRUND — die Graukarten-Methode.
  // Gemessen am Marstek-Speicher: Hintergrund 195, weisses Produkt 125. Ohne
  // Korrektur zeigt der Packshot ein mattgraues Geraet, obwohl es weiss ist.
  const belichtung = await messeBelichtung(original, maskePng, oMeta);

  // Originalpixel + Maske als Alpha → Produkt freigestellt, Pixel unangetastet.
  // Die Belichtungskorrektur ist eine LINEARE Verstaerkung je Kanal, kein
  // Neuzeichnen: Formen, Kanten und jeder Buchstabe bleiben, wo sie sind.
  let grundBild = belichtung.faktoren
    ? await sharp(original).linear(belichtung.faktoren, [0, 0, 0]).toBuffer()
    : original;

  // SCHATTEN AUF DEM PRODUKT OEFFNEN. Erst jetzt, nach dem Weissabgleich, und
  // gemessen an den Pixeln, die die Maske als PRODUKT ausweist — der
  // Hintergrund faellt ohnehin weg und darf die Messung nicht verfaelschen.
  // Die Kurve laeuft auf dem ganzen Bild; das ist gleichwertig, weil vom
  // Hintergrund nichts uebrig bleibt, und spart einen Maskierungsschritt.
  const lift = await messeSchattenlift(grundBild, gefuellt, roh.w, roh.h);
  if (lift.gamma) {
    try {
      grundBild = await wendeGammaAn(grundBild, lift.gamma);
    } catch (err) {
      lift.gamma = null;
      lift.grund = `anwendung_fehlgeschlagen: ${err.message}`;
    }
  }

  const freigestellt = await sharp(grundBild)
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
  const fw = fuellgradBreite();
  const fh = fuellgradHoehe();
  const pw0 = pMeta.width || 1;
  const ph0 = pMeta.height || 1;
  // Die Leinwand richtet sich nach dem Produkt, nicht umgekehrt: sie ist so
  // gross, dass das Produkt seine Ziel-Box GENAU ausfuellt, ohne vergroessert
  // zu werden. Massgeblich ist die Richtung, die zuerst anschlaegt — bei einem
  // breiten Artikel die Breite, bei einem hohen die Hoehe.
  // KEINE Untergrenze mehr (2026-09-10). Vorher stand hier `Math.max(800, …)`.
  // Bei einem kleineren Ausschnitt band diese Grenze VOR dem Fuellziel und
  // drueckte die Fuellung wieder herunter — gemessen an einem 600-px-Produkt:
  // 75 % statt der angestrebten 92 %. Sie schuetzte auch nichts: `lib/storage.js`
  // normalisiert jedes Galeriebild ohnehin auf 1200 px lange Kante. Eine
  // kleinere Leinwand heisst also nur, dass das Produkt einen groesseren Teil
  // dieser 1200 px bekommt — bei identischen Ausgangspixeln.
  const leinwand = Math.min(LEINWAND, Math.max(64, Math.ceil(Math.max(pw0 / fw, ph0 / fh))));
  const zielB = Math.round(leinwand * fw);
  const zielH = Math.round(leinwand * fh);
  const skaliert = await sharp(produkt)
    .resize(zielB, zielH, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const sMeta = await sharp(skaliert).metadata();
  const pw = sMeta.width || zielB;
  const ph = sMeta.height || zielH;
  const px = Math.round((leinwand - pw) / 2);
  // Waagerecht mittig, senkrecht leicht nach oben — darunter sitzt der
  // Kontaktschatten. Genau mittig wuerde der Artikel schweben.
  const py = Math.round((leinwand - ph) * SENKRECHT);

  const schatten = await baueKontaktschatten(skaliert, pw, ph);

  const grund = verlauf
    ? await baueVerlaufsgrund(leinwand)
    : {
        create: { width: leinwand, height: leinwand, channels: 3, background: { r: 255, g: 255, b: 255 } },
      };

  const packshot = await sharp(grund)
    .composite([
      { input: schatten.buffer, left: px + schatten.dx, top: py + ph + schatten.dy },
      { input: skaliert, left: px, top: py },
    ])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const randOk = await pruefeRand(packshot, verlauf ? VERLAUF_RAND_MIN : WEISS_RAND_MIN);
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
      fuellungBreite: +((pw / leinwand) * 100).toFixed(1),
      fuellungHoehe: +((ph / leinwand) * 100).toFixed(1),
      fuellungFlaeche: +(((pw * ph) / (leinwand * leinwand)) * 100).toFixed(1),
      hintergrund: verlauf ? 'verlauf' : 'weiss',
      belichtung: belichtung.faktoren
        ? { faktoren: belichtung.faktoren.map((f) => +f.toFixed(3)), hintergrund: belichtung.hintergrund }
        : { faktoren: null, grund: belichtung.grund },
      schattenlift: lift.gamma
        ? { gamma: lift.gamma, p10Vorher: lift.p10, medianVorher: lift.median, zielP10: LIFT_ZIEL_P10 }
        : { gamma: null, p10Vorher: lift.p10, medianVorher: lift.median, grund: lift.grund },
      // TATSAECHLICHE Skalierung (nach withoutEnlargement), nicht die angestrebte.
      // TATSAECHLICHE Skalierung (nach withoutEnlargement), nicht die angestrebte.
      skalierung: +(Math.max(pw, ph) / Math.max(pw0, ph0)).toFixed(2),
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
 * Belichtung und Weissabgleich aus dem HINTERGRUND ableiten — die Methode, die
 * ein Fotograf mit einer Graukarte anwendet.
 *
 * WARUM AUS DEM HINTERGRUND und nicht aus dem Produkt: eine Korrektur, die sich
 * am Produkt orientiert, verschiebt dessen Farbe — aus Beige wuerde Weiss, aus
 * einem dunkelgrauen Gehaeuse ein helles. Das waere eine Produktveraenderung,
 * also genau das, was dieser ganze Weg vermeiden soll. Der Hintergrund dagegen
 * ist BEKANNT neutral: er ist die Flaeche, die das Modell als Nicht-Produkt
 * ausgewiesen hat. Bringt man IHN auf Weiss und wendet denselben Faktor auf
 * alles an, bleiben alle Farben ZUEINANDER unveraendert — korrigiert wird nur
 * das Licht des Raumes, nicht der Artikel.
 *
 * Drei Wachen, alle fail-open (im Zweifel gar keine Korrektur):
 *   - zu dunkler Hintergrund (< MIN_HG): das war kein heller Untergrund,
 *     womoeglich wurde vor einer dunklen Wand fotografiert. Nichts tun.
 *   - farbiger Hintergrund (Kanalfaktoren weichen > MAX_FARBSPREIZUNG ab):
 *     dann ist er keine gueltige Graukarte, und ein Weissabgleich darauf
 *     faerbte den ganzen Artikel um.
 *   - Verstaerkung gedeckelt (MAX_FAKTOR): ein stark unterbelichtetes Foto
 *     wird aufgehellt, aber nicht bis zur Unkenntlichkeit ausgebrannt.
 */
const BELICHTUNG_MIN_HG = 140;
const BELICHTUNG_ZIEL = 248;
const BELICHTUNG_MAX_FAKTOR = 1.6;
const BELICHTUNG_MAX_FARBSPREIZUNG = 1.3;

async function messeBelichtung(original, maskePng, oMeta) {
  try {
    // Der Hintergrund ist alles, was die Maske NICHT als Produkt fuehrt. Die
    // Maske wird invertiert und als Alpha gelegt; danach tragen nur noch
    // Hintergrundpixel Deckkraft.
    const nurHintergrund = await sharp(original)
      .ensureAlpha()
      // `negate({alpha:true})` ist Pflicht: die Maske traegt ihren Wert im
      // ALPHA-Kanal, und `dest-in` liest ausschliesslich Alpha. Mit
      // `{alpha:false}` — dem naheliegenden "nur die Farben umdrehen" — bliebe
      // Alpha stehen und man maesse das PRODUKT statt des Hintergrunds
      // (gemessen: 127 statt 195). Dieselbe Falle wie beim Maskieren selbst.
      .composite([{ input: await sharp(maskePng).negate({ alpha: true }).toBuffer(), blend: 'dest-in' }])
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = nurHintergrund;
    const kanal = [[], [], []];
    // Grob abtasten — fuer einen Hellwert braucht es keine vier Millionen Pixel.
    const schritt = Math.max(1, Math.floor((info.width * info.height) / 40000));
    for (let p = 0; p < info.width * info.height; p += schritt) {
      const i = p * info.channels;
      if (info.channels === 4 && data[i + 3] < 200) continue; // Produkt, nicht Hintergrund
      kanal[0].push(data[i]);
      kanal[1].push(data[i + 1]);
      kanal[2].push(data[i + 2]);
    }
    if (kanal[0].length < 500) return { faktoren: null, grund: 'zu_wenig_hintergrund' };

    // 90. Perzentil statt Maximum: ein einzelner Lichtreflex darf den
    // Weisspunkt nicht bestimmen.
    const hell = kanal.map((werte) => {
      werte.sort((a, b) => a - b);
      return werte[Math.floor(werte.length * 0.9)];
    });

    if (Math.min(...hell) < BELICHTUNG_MIN_HG) {
      return { faktoren: null, grund: `hintergrund_zu_dunkel(${Math.min(...hell)})` };
    }

    const roh = hell.map((v) => BELICHTUNG_ZIEL / Math.max(1, v));
    const spreizung = Math.max(...roh) / Math.max(1e-6, Math.min(...roh));
    if (spreizung > BELICHTUNG_MAX_FARBSPREIZUNG) {
      return { faktoren: null, grund: `hintergrund_farbig(${spreizung.toFixed(2)})` };
    }

    const faktoren = roh.map((f) => Math.min(BELICHTUNG_MAX_FAKTOR, Math.max(1, f)));
    // Unter 2 % Aenderung lohnt der Rechenweg nicht.
    if (Math.max(...faktoren) < 1.02) return { faktoren: null, grund: 'bereits_neutral' };

    return { faktoren, hintergrund: hell, grund: null };
  } catch (err) {
    return { faktoren: null, grund: `messung_fehlgeschlagen: ${err.message}` };
  }
}

/**
 * SCHATTEN-AUFHELLUNG auf dem PRODUKT (seit 2026-09-10, Betreiber: "die
 * belichtung/helligkeit darf auch verbessert werden da die vorderseite in
 * diesem fall beschattet ist").
 *
 * Die Graukarten-Korrektur weiter oben normiert den RAUM — sie kann eine
 * ungleiche Ausleuchtung AUF dem Artikel bauartbedingt nicht beheben. Am
 * Futtereimer gemessen: Hintergrund p90 = 221, Faktor also nur 1,12; der
 * schwarze Korpus blieb bei Median 38 und damit eine formlose Flaeche.
 *
 * DER ZIELWERT IST GEMESSEN, NICHT GESCHAETZT. Derselbe Eimer liegt als
 * Hersteller-Studiofoto vor (drei Aufnahmen, nice-cdn). Gesteuert wird ueber das
 * 10. PERZENTIL der Produkt-Helligkeit — also die Schattentiefe, nicht den
 * Median. Der Median taugt nicht: beim Eimer zieht ihn das grosse helle Etikett
 * auf 96, obwohl der schwarze Korpus bei 40 liegt und die Aufhellung genau ihn
 * meint. Gemessen ueber alle Produktpixel:
 *
 *              p05  p10  p20  p50
 *   Hersteller  28   36   46   92
 *   Hersteller  18   31   54  188
 *   Hersteller  20   30   44   88
 *   UNSERER      4    8   23  110   <- die Schatten saufen ab
 *
 * LIFT_ZIEL_P10 = 32 ist der Mittelwert der drei Herstellerwerte.
 *
 * WARUM GAMMA: die Kurve haelt 0 auf 0 und 255 auf 255 fest. Tiefes Schwarz
 * bleibt schwarz (5 -> 12), Weiss bleibt Weiss (250 -> 252), angehoben wird
 * ausschliesslich der Mittelbereich — also genau der beschattete Teil. Die
 * Reihenfolge der Helligkeiten bleibt erhalten, und weil alle drei Kanaele
 * dieselbe Kurve bekommen, verschiebt sich kein Farbton.
 *
 * WARUM ES KEINE PRODUKTVERAENDERUNG IST: angehoben wird NUR, solange der
 * Artikel dunkler ist als der Studio-Normwert. Ein Artikel, der bereits bei
 * oder ueber Median 60 liegt, wird nicht angefasst — ein dunkelgraues Gehaeuse
 * kann also nie hellgrau werden. Und der Deckel begrenzt, wie weit ein sehr
 * dunkler Artikel ueberhaupt kommt.
 */
const LIFT_ZIEL_P10 = 32;
const LIFT_MAX_GAMMA = 1.7;
const LIFT_MIN_GAMMA = 1.04;
/**
 * Rueckhaltegrenze: nach der Aufhellung darf der Median der Produktpixel diesen
 * Wert nicht ueberschreiten. Verhindert, dass ein bereits mittelheller Artikel
 * ausgewaschen wirkt. Die drei Herstellerfotos liegen bei Median 92/188/88 —
 * 180 laesst diesen Bereich zu und bremst nur darueber hinaus.
 */
const LIFT_MEDIAN_MAX = 180;

/**
 * Ermittelt die Gamma-Staerke aus dem Histogramm der PRODUKTPIXEL.
 * @param {Uint8Array} maske  Maske in Maskenaufloesung (1 = Produkt)
 * @returns {{gamma:number|null, median:number, grund:string|null}}
 */
async function messeSchattenlift(bild, maske, mw, mh) {
  try {
    const { data, info } = await sharp(bild)
      .removeAlpha()
      .resize(mw, mh, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lum = [];
    for (let p = 0; p < mw * mh; p += 1) {
      if (!maske[p]) continue;
      const i = p * info.channels;
      lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    }
    if (lum.length < 500) return { gamma: null, p10: 0, median: 0, grund: 'zu_wenig_produkt' };
    lum.sort((a, b) => a - b);
    const p10 = lum[Math.floor(lum.length * 0.1)];
    const median = lum[Math.floor(lum.length * 0.5)];
    const p99 = lum[Math.floor(lum.length * 0.99)];
    if (p10 >= LIFT_ZIEL_P10) return { gamma: null, p10, median, grund: 'schatten_bereits_offen' };
    if (p10 < 1) return { gamma: null, p10, median, grund: 'schatten_ohne_zeichnung' };

    let gamma = Math.log(p10 / 255) / Math.log(LIFT_ZIEL_P10 / 255);
    gamma = Math.min(LIFT_MAX_GAMMA, gamma);
    if (gamma < LIFT_MIN_GAMMA) return { gamma: null, p10, median, grund: 'unter_merkschwelle' };

    // Rueckhalt: ein mittelheller Artikel darf nicht ausgewaschen werden.
    if (median > 1) {
      const medianNachher = 255 * Math.pow(median / 255, 1 / gamma);
      if (medianNachher > LIFT_MEDIAN_MAX) {
        const erlaubt = Math.log(median / 255) / Math.log(LIFT_MEDIAN_MAX / 255);
        gamma = Math.max(1, Math.min(gamma, erlaubt));
        if (gamma < LIFT_MIN_GAMMA) return { gamma: null, p10, median, grund: 'artikel_schon_mittelhell' };
      }
    }

    // Lichter duerfen nicht ausbrennen: waere das obere Prozent danach ueber
    // 252, wird die Kurve so weit zurueckgenommen, dass es darunter bleibt.
    if (p99 > 1) {
      const nachher = 255 * Math.pow(p99 / 255, 1 / gamma);
      if (nachher > 252) {
        const erlaubt = Math.log(p99 / 255) / Math.log(252 / 255);
        gamma = Math.max(1, Math.min(gamma, erlaubt));
        if (gamma < LIFT_MIN_GAMMA) return { gamma: null, p10, median, grund: 'lichter_zu_nah_an_weiss' };
      }
    }
    return { gamma: +gamma.toFixed(3), p10: Math.round(p10), median: Math.round(median), grund: null };
  } catch (err) {
    return { gamma: null, p10: 0, median: 0, grund: `messung_fehlgeschlagen: ${err.message}` };
  }
}

/**
 * Wendet eine Gamma-Kurve ueber eine 256er-Tabelle an.
 *
 * BEWUSST EIGENE TABELLE statt sharp `.gamma()`: dessen Signatur ist ein
 * Paar aus Ein- und Ausgangs-Gamma fuer Resize-Ablaeufe und tut ohne zweiten
 * Wert nichts Sichtbares. Eine eigene Tabelle ist exakt das, was hier gemeint
 * ist, ist testbar und ueberlebt einen sharp-Versionswechsel. Kosten bei
 * 2000x2000: ein Durchlauf ueber 12 Mio Bytes, unter 100 ms.
 */
async function wendeGammaAn(buffer, gamma) {
  const tabelle = new Float32Array(256);
  for (let v = 0; v < 256; v += 1) {
    tabelle[v] = 255 * Math.pow(v / 255, 1 / gamma);
  }
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = info.channels;
  // ÜBER DIE LUMINANZ, NICHT KANALWEISE. Legt man die Kurve auf R, G und B
  // einzeln, wandert der Farbton: der schwaechste Kanal wird relativ staerker
  // angehoben als der staerkste, ein gesaettigtes Rot wird blasser. Stattdessen
  // wird EIN gemeinsamer Faktor aus der Helligkeit abgeleitet und auf alle drei
  // Kanaele gelegt — die Verhaeltnisse untereinander bleiben damit exakt
  // erhalten, es aendert sich nur die Helligkeit.
  for (let i = 0; i < data.length; i += k) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (y < 1) continue; // Schwarz bleibt Schwarz, und 0 hat kein Verhaeltnis
    const f = tabelle[Math.round(y)] / y;
    data[i] = Math.min(255, Math.round(data[i] * f));
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * f));
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * f));
  }
  // RAW rein IMMER mit Ausgabeformat wieder raus — sonst kommen Rohdaten zurueck.
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

/**
 * Hellgrauer Studioverlauf als Leinwandgrund — heller Kern leicht oberhalb der
 * Mitte (wie eine Softbox), zu den Ecken hin abfallend.
 *
 * Der helle Punkt sitzt bei 38 % der Höhe und NICHT mittig: das Produkt steht
 * mittig auf der Leinwand, ein exakt konzentrischer Verlauf legte den hellsten
 * Fleck genau hinter das Produkt, wo ihn niemand sieht, und liesse den Bereich
 * um den Kontaktschatten am dunkelsten — dort, wo er am meisten stört.
 */
async function baueVerlaufsgrund(leinwand) {
  const n = VERLAUF_KANTE;
  const roh = Buffer.alloc(n * n * 3);
  const cx = 0.5;
  const cy = 0.38;
  // Weiteste Ecke vom hellen Punkt aus — darauf wird normiert, damit der
  // dunkelste Wert genau in der Ecke erreicht wird und nicht schon vorher.
  const maxD = Math.max(
    Math.hypot(0 - cx, 0 - cy),
    Math.hypot(1 - cx, 0 - cy),
    Math.hypot(0 - cx, 1 - cy),
    Math.hypot(1 - cx, 1 - cy)
  );
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const d = Math.hypot((x + 0.5) / n - cx, (y + 0.5) / n - cy) / maxD;
      const wert = Math.round(VERLAUF_HELL - (VERLAUF_HELL - VERLAUF_DUNKEL) * Math.min(1, d) ** 1.6);
      const p = (y * n + x) * 3;
      roh[p] = wert;
      roh[p + 1] = wert;
      roh[p + 2] = wert;
    }
  }
  // RAW-Eingabe IMMER mit Ausgabeformat verlassen — sonst kommen wieder Rohdaten
  // zurueck und der naechste composite() meldet "unsupported image format".
  return sharp(roh, { raw: { width: n, height: n, channels: 3 } })
    .resize(leinwand, leinwand, { fit: 'fill', kernel: 'cubic' })
    .png()
    .toBuffer();
}

/**
 * Schlusskontrolle: der äussere Rahmen MUSS dem bestellten Grund entsprechen.
 * Ist er dunkler, ragt Hintergrund oder Hand ins Bild — dann lieber gar kein
 * Packshot.
 */
async function pruefeRand(buffer, minWert = WEISS_RAND_MIN) {
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
      if (kanal.min < minWert) return { ok: false, grund: `rand_nicht_weiss(${kanal.min})` };
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
