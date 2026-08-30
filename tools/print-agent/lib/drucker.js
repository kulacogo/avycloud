'use strict';

/**
 * drucker.js — Etikett an den richtigen Drucker geben.
 *
 * Es gibt ZWEI physische Drucker mit zwei verschiedenen Rollen:
 *   parcel  -> 103 x 164 mm (DHL, DPD)
 *   letter  ->  62 x 100 mm (Deutsche Post)
 *
 * Die Rolle kommt fertig aus AvyCloud (`printerRole` am Druckauftrag). Der
 * Agent bildet sie nur noch auf einen CUPS-Druckernamen ab — er entscheidet
 * NICHT selbst, welches Format ein Etikett hat. Die Entscheidung gehoert genau
 * einmal ins Backend (`lib/label-format.js`), sonst driften zwei Wahrheiten
 * auseinander.
 */

const { execFile } = require('node:child_process');

/**
 * Der BENANNTE Mediename fuer ein Millimetermass, z. B. `103x164mm`.
 *
 * Die Brother-Etikettendrucker fuehren ihre Rollenformate unter genau diesem
 * Namen (gemessen am Geraet: `lpoptions -p Versandlabel -l` listet
 * `*103x164mm … 62x100mm Custom.WIDTHxHEIGHT`).
 */
function medienName(widthMm, heightMm) {
  const w = Math.round(Number(widthMm));
  const h = Math.round(Number(heightMm));
  if (!(w > 0) || !(h > 0)) throw new Error(`Ungueltiges Etikettenmass: ${widthMm}x${heightMm}`);
  return `${w}x${h}mm`;
}

/** Der allgemeine Custom-Name als Rueckfall, wenn der Drucker das Mass nicht benannt fuehrt. */
function benutzerMedienName(widthMm, heightMm) {
  return `Custom.${medienName(widthMm, heightMm)}`;
}

/**
 * Das richtige Medium waehlen.
 *
 * WARUM NICHT EINFACH IMMER `Custom.103x164mm`: Das ist NICHT dasselbe wie das
 * benannte `103x164mm`. Der benannte Eintrag ist die vom Treiber kalibrierte
 * Rollenvorlage samt der echten nicht bedruckbaren Raender; bei `Custom.`
 * schaetzt CUPS die Raender selbst. Der Unterschied faellt als versetzter Druck
 * auf — und niemand findet die Ursache.
 *
 * Deshalb: fuehrt der Drucker das Mass benannt, gewinnt der benannte Eintrag.
 * Sonst der Custom-Name.
 *
 * @param {string[]} vorhandeneMedien — Ausgabe von `listeMedien()`
 */
function waehleMedium(widthMm, heightMm, vorhandeneMedien = []) {
  const benannt = medienName(widthMm, heightMm);
  return vorhandeneMedien.includes(benannt) ? benannt : benutzerMedienName(widthMm, heightMm);
}

/** Die vom Drucker gefuehrten Medien-Namen auslesen (`PageSize`-Zeile von `lpoptions -l`). */
function listeMedien(druckerName, { execImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execImpl('lpoptions', ['-p', String(druckerName), '-l'], { encoding: 'utf8' }, (fehler, stdout) => {
      if (fehler) return resolve([]);
      const zeile = String(stdout || '')
        .split('\n')
        .find((z) => /^PageSize(\/|:)/i.test(z.trim()));
      if (!zeile) return resolve([]);
      const nachDoppelpunkt = zeile.slice(zeile.indexOf(':') + 1);
      resolve(
        nachDoppelpunkt
          .trim()
          .split(/\s+/)
          // Der Stern markiert die Voreinstellung und gehoert nicht zum Namen.
          .map((n) => n.replace(/^\*/, ''))
          .filter(Boolean)
      );
    });
  });
}

/**
 * Argumente fuer `lp` bauen. Rein, damit der Aufruf ohne Drucker pruefbar ist.
 *
 * `fit-to-page` ist bewusst voreingestellt: das PDF hat bereits exakt das
 * Rollenmass, aber jeder Drucker hat einen nicht bedruckbaren Rand. Ohne
 * Einpassen wuerde genau dieser Rand den Barcode anschneiden — und ein
 * angeschnittener Barcode ist ein Paket, das im Verteilzentrum liegen bleibt.
 * Das Einpassen behaelt das Seitenverhaeltnis, es verzerrt nichts.
 *
 * @param {{druckerName:string, widthMm:number, heightMm:number, copies?:number,
 *          jobId?:string, fitToPage?:boolean}} input
 * @returns {string[]}
 */
function baueLpArgumente({
  druckerName, widthMm, heightMm, copies = 1, jobId, fitToPage = true, vorhandeneMedien = [],
}) {
  if (!druckerName) throw new Error('Kein Druckername fuer diese Rolle hinterlegt.');
  const anzahl = Math.min(10, Math.max(1, Math.floor(Number(copies) || 1)));

  const args = [
    '-d', String(druckerName),
    '-n', String(anzahl),
    '-o', `media=${waehleMedium(widthMm, heightMm, vorhandeneMedien)}`,
  ];
  if (fitToPage) args.push('-o', 'fit-to-page');
  // Ein Etikett ist nie mehrseitig nebeneinander.
  args.push('-o', 'number-up=1');
  if (jobId) args.push('-t', `avycloud-${jobId}`);
  // Von der Standardeingabe lesen — wir haben das PDF im Speicher und wollen
  // keine temporaere Datei anlegen, die bei einem Absturz liegen bleibt.
  args.push('--');
  return args;
}

/**
 * Rolle -> CUPS-Druckername.
 * Fehlt der Name, wird NICHT auf den Standarddrucker ausgewichen: dann laege
 * ein 103-mm-Etikett womoeglich auf der Briefrolle.
 */
function waehleDrucker(rolle, drucker = {}) {
  const name = drucker[rolle];
  if (!name) {
    throw new Error(
      `Fuer die Rolle "${rolle}" ist kein Drucker eingerichtet `
      + '(PRINTER_PARCEL / PRINTER_LETTER setzen).'
    );
  }
  return name;
}

/** PDF an `lp` uebergeben. */
function druckeBuffer({
  buffer, druckerName, widthMm, heightMm, copies, jobId, fitToPage,
  vorhandeneMedien = [], execImpl = execFile,
}) {
  const args = baueLpArgumente({
    druckerName, widthMm, heightMm, copies, jobId, fitToPage, vorhandeneMedien,
  });
  return new Promise((resolve, reject) => {
    const kind = execImpl('lp', args, { encoding: 'buffer' }, (fehler, stdout, stderr) => {
      if (fehler) {
        const text = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr || '');
        reject(new Error(`lp fehlgeschlagen: ${text.trim() || fehler.message}`));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout.toString().trim() : String(stdout || '').trim());
    });
    kind.stdin.end(buffer);
  });
}

/** Verfuegbare Drucker auflisten — fuer die Einrichtung. */
function listeDrucker({ execImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execImpl('lpstat', ['-a'], { encoding: 'utf8' }, (fehler, stdout) => {
      if (fehler) return resolve([]);
      resolve(
        String(stdout || '')
          .split('\n')
          .map((zeile) => zeile.trim().split(/\s+/)[0])
          .filter(Boolean)
      );
    });
  });
}

/** Rollenmass je Rolle — dieselbe Wahrheit wie backend/lib/label-format.js. */
const ROLLEN_MASS = { parcel: [103, 164], letter: [62, 100] };

/**
 * Bewertet, wie gut ein Drucker zu einer Rolle passt.
 *
 * WARUM NICHT UEBER DEN NAMEN: Namen aendern sich (aus "Versandlabel" wurde am
 * 2026-08-24 "DHL_DPD_Label" und die Einrichtung brach ab). Das ROLLENFORMAT ist
 * die stabile Eigenschaft — ein Drucker, der 103x164 mm fuehrt, hat die
 * Paketrolle eingelegt, wie er auch heisst.
 *
 * @param {{name:string, beschreibung?:string, medien:string[]}} drucker
 * @returns {number} Punkte; <= 0 bedeutet "kommt nicht in Frage"
 */
function bewerteDrucker(rolle, drucker) {
  const mass = ROLLEN_MASS[rolle];
  if (!mass) return -1;
  const noetig = `${mass[0]}x${mass[1]}mm`;
  const medien = drucker.medien || [];
  // Ohne das Mass kommt der Drucker gar nicht in Frage.
  if (!medien.includes(noetig)) return -1;
  // Der Paketdrucker fuehrt BEIDE Masse. Fuer die Briefrolle scheidet er aus,
  // sonst laegen beide Rollen auf demselben Geraet und die Trennung waere
  // sinnlos.
  if (rolle === 'letter' && medien.includes('103x164mm')) return -1;

  const text = `${drucker.name} ${drucker.beschreibung || ''}`.toLowerCase();
  const passend = rolle === 'parcel' ? /dhl|dpd|paket|versand/ : /\bdp\b|post|brief/;
  const unpassend = /sku|bin\b|produkt|inventur/;
  let punkte = 1;
  if (passend.test(text)) punkte += 10;
  if (unpassend.test(text)) punkte -= 5;
  return punkte;
}

/**
 * Den Drucker fuer eine Rolle bestimmen.
 *
 * Bei Gleichstand an der Spitze wird NICHT geraten — ein 103-mm-Etikett auf der
 * falschen Rolle hat einen abgeschnittenen Barcode. Dann muss der Mensch
 * entscheiden (PRINTER_PARCEL / PRINTER_LETTER setzen).
 *
 * @returns {{name: string|null, kandidaten: string[]}}
 */
function ermittleDrucker(rolle, drucker = []) {
  const bewertet = drucker
    .map((d) => ({ d, punkte: bewerteDrucker(rolle, d) }))
    .filter((x) => x.punkte > 0)
    .sort((a, b) => b.punkte - a.punkte);

  const kandidaten = bewertet.map((x) => x.d.name);
  if (!bewertet.length) return { name: null, kandidaten: [] };
  if (bewertet.length > 1 && bewertet[0].punkte === bewertet[1].punkte) {
    return { name: null, kandidaten };
  }
  return { name: bewertet[0].d.name, kandidaten };
}

/** Alle Drucker samt Beschreibung und gefuehrten Medien einsammeln. */
async function sammleDrucker({ execImpl = execFile } = {}) {
  const namen = await listeDrucker({ execImpl });
  const ergebnis = [];
  for (const name of namen) {
    const medien = await listeMedien(name, { execImpl });
    const beschreibung = await new Promise((resolve) => {
      execImpl('lpstat', ['-l', '-p', name], { encoding: 'utf8' }, (fehler, stdout) => {
        if (fehler) return resolve('');
        const zeile = String(stdout || '').split('\n')
          .find((z) => /(Beschreibung|Description):/i.test(z));
        resolve(zeile ? zeile.split(':').slice(1).join(':').trim() : '');
      });
    });
    ergebnis.push({ name, beschreibung, medien });
  }
  return ergebnis;
}

module.exports = {
  medienName,
  benutzerMedienName,
  waehleMedium,
  listeMedien,
  baueLpArgumente,
  waehleDrucker,
  druckeBuffer,
  listeDrucker,
  ROLLEN_MASS,
  bewerteDrucker,
  ermittleDrucker,
  sammleDrucker,
};
