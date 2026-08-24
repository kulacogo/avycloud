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

module.exports = {
  medienName,
  benutzerMedienName,
  waehleMedium,
  listeMedien,
  baueLpArgumente,
  waehleDrucker,
  druckeBuffer,
  listeDrucker,
};
