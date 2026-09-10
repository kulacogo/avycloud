'use strict';

/**
 * image-cost.js — was ein Bilderzeugungs-Lauf kostet, und wo Schluss ist.
 *
 * ============================================================================
 * WARUM (Betreiber 2026-09-10): "bilder generierung ist teurer als text. wir
 * muessen effizient und sparsam sein sonst gehen die kosten durch die decke."
 *
 * In CLAUDE.md stand seit dem 02.09. als offener Punkt: "es gibt keinen Zaehler
 * und keinen Deckel fuer die Bildaufrufe je Knopfdruck". Das ist hier behoben.
 *
 * PREISE (ai.google.dev/gemini-api/docs/pricing, recherchiert 2026-09-02).
 * Bildausgabe wird als TOKEN abgerechnet, die Tokenzahl haengt an der Groesse:
 *   gemini-3-pro-image        120 $/1M   1K/2K = 1120 Tk = 0,134 $   4K = 2000 Tk = 0,240 $
 *   gemini-3.1-flash-image     60 $/1M   512  =  747 Tk = 0,045 $    1K = 1120 Tk = 0,067 $
 *                                        2K   = 1680 Tk = 0,101 $    4K = 2520 Tk = 0,151 $
 *   gemini-3.1-flash-lite-image 30 $/1M  1K   = 1120 Tk = 0,034 $
 *   gemini-2.5-flash-image (Legacy)      1290 Tk = 0,039 $
 *
 * Die Token-mal-Preis-Rechnung geht bei jeder Zeile exakt auf — das ist die
 * Gegenprobe, dass die Tabelle stimmt.
 *
 * WICHTIG: das sind SCHAETZWERTE fuer die Vorabrechnung und den Deckel, kein
 * Abrechnungsbeleg. Die Wahrheit steht in der Google-Rechnung. Ein unbekanntes
 * Modell bekommt den TEUERSTEN bekannten Preis — im Zweifel lieber zu frueh
 * bremsen als eine Rechnung, die niemand erwartet hat.
 * ============================================================================
 */

/** $ je erzeugtem Bild, nach Modell und Zielgroesse. */
const PREISE = Object.freeze(
  Object.assign(Object.create(null), {
    'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24, standard: 0.134 },
    'gemini-3.1-flash-image': { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151, standard: 0.101 },
    'gemini-3.1-flash-lite-image': { '512': 0.02, '1K': 0.034, standard: 0.034 },
    'gemini-2.5-flash-image': { standard: 0.039 },
  })
);

const TEUERSTER_BEKANNTER = 0.24;

/**
 * Preis EINES Bildes. Unbekanntes Modell oder unbekannte Groesse → teuerster
 * bekannter Preis (fail-expensive, damit der Deckel frueher greift).
 */
function preisJeBild(model, imageSize) {
  const tabelle = PREISE[String(model || '').trim()];
  if (!tabelle) return TEUERSTER_BEKANNTER;
  const key = String(imageSize || '').trim();
  if (key && typeof tabelle[key] === 'number') return tabelle[key];
  return typeof tabelle.standard === 'number' ? tabelle.standard : TEUERSTER_BEKANNTER;
}

function zahl(env, fallback) {
  const raw = parseFloat(process.env[env]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Kostendeckel JE LAUF in US-Dollar.
 *
 * Voreinstellung 0,90 $, gerechnet statt geraten. Der schlimmste ZULAESSIGE
 * Fall ist eine volle Serie ohne ein einziges brauchbares Foto der jeweiligen
 * Seite, also vier ABGELEITETE Studio-Ansichten:
 *   4 x (Render 2K 0,101 $ + Masken-Aufruf fuer die einheitliche Leinwand
 *        0,034 $)                                      = 0,540 $
 *   2 Anwendungsszenen x 0,067 $ (flash-image @ 1K)     = 0,134 $
 *   Summe                                               = 0,674 $
 *   dazu Luft fuer etwa einen Rueckfall auf das teure Modell (0,134 $).
 *
 * Der typische Lauf liegt deutlich darunter: sitzen zwei Ansichten auf echten
 * Fotos, kosten sie nur ihre Maske (0,034 $ statt 0,135 $).
 *
 * ANGEHOBEN VON 0,75 AUF 0,90 (2026-09-10): mit der einheitlichen Leinwand kam
 * je abgeleiteter Studio-Ansicht ein Maskenaufruf dazu. Beim alten Deckel
 * verhungerten dadurch die zuletzt geplanten Bilder — die Anwendungsszenen —,
 * und der Bediener bekam statt eines uneinheitlichen Hintergrunds GAR KEIN
 * Bild. Der Deckel bleibt eine harte Grenze, nur an der richtigen Stelle.
 *
 * Derselbe Lauf auf `gemini-3-pro-image` kostete deutlich mehr und schlaegt
 * bewusst an den Deckel — wer Pro als Primaermodell will, muss ihn anheben und
 * weiss dann, was er tut. `0` schaltet den Deckel ab.
 */
function deckelJeLauf() {
  return zahl('IMAGE_COST_CAP_USD', 0.9);
}

/**
 * Ein Kostenzaehler fuer einen Lauf. Fragt VOR jedem Bild, ob es noch ins
 * Budget passt, und bucht danach die tatsaechlich erzeugten Bilder.
 *
 * Der Deckel ist eine HARTE Grenze, keine Empfehlung: `darfNoch()` sagt nein,
 * und der Aufrufer erzeugt das Bild dann gar nicht erst. Ein Deckel, der erst
 * nach dem Bezahlen greift, spart nichts.
 */
function neuerZaehler(opts = {}) {
  const deckel = Number.isFinite(opts.deckel) ? opts.deckel : deckelJeLauf();
  let ausgegeben = 0;
  let bilder = 0;
  const posten = [];

  return {
    deckel,
    /** Passt ein weiteres Bild dieses Modells/dieser Groesse noch ins Budget? */
    darfNoch(model, imageSize) {
      if (deckel <= 0) return true; // 0 = kein Deckel
      return ausgegeben + preisJeBild(model, imageSize) <= deckel + 1e-9;
    },
    /** Bucht ein erzeugtes Bild. Auch ein VERWORFENES Bild wurde bezahlt. */
    buche(model, imageSize, zweck) {
      const p = preisJeBild(model, imageSize);
      ausgegeben += p;
      bilder += 1;
      posten.push({ model, imageSize: imageSize || null, zweck: zweck || null, usd: +p.toFixed(4) });
      return p;
    },
    get usd() {
      return +ausgegeben.toFixed(4);
    },
    get anzahl() {
      return bilder;
    },
    get erschoepft() {
      return deckel > 0 && ausgegeben >= deckel - 1e-9;
    },
    bericht() {
      return {
        bildaufrufe: bilder,
        kostenUsd: +ausgegeben.toFixed(4),
        deckelUsd: deckel,
        deckelErreicht: deckel > 0 && ausgegeben >= deckel - 1e-9,
        posten,
      };
    },
  };
}

/** Vorabschaetzung fuer einen Plan — fuer Log und Anzeige, ohne Nebenwirkung. */
function schaetze(plan, model, imageSize) {
  const n = Array.isArray(plan) ? plan.length : 0;
  return +(n * preisJeBild(model, imageSize)).toFixed(4);
}

/**
 * Vorabschaetzung, wenn die Posten UNTERSCHIEDLICH abgerechnet werden.
 *
 * Seit der pixeltreue Weg existiert, kostet nicht mehr jedes Bild dasselbe: eine
 * Ansicht mit echtem Foto braucht nur eine billige Maske, eine abgeleitete einen
 * vollen Render, eine Szene einen Render in kleinerer Groesse. Eine Schaetzung
 * mit EINEM Preis waere seitdem systematisch zu hoch — und eine Zahl, die
 * regelmaessig danebenliegt, liest bald niemand mehr.
 *
 * @param {Array<{model:string, imageSize:string}>} posten
 */
function schaetzePosten(posten) {
  if (!Array.isArray(posten)) return 0;
  const summe = posten.reduce((acc, p) => acc + preisJeBild(p?.model, p?.imageSize), 0);
  return +summe.toFixed(4);
}

module.exports = {
  PREISE,
  preisJeBild,
  deckelJeLauf,
  neuerZaehler,
  schaetze,
  schaetzePosten,
};
