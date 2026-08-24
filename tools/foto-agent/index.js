#!/usr/bin/env node
'use strict';

/**
 * AvyCloud Foto-Agent — erfasst neue Produktfotos vom lokalen Share.
 *
 * Ablauf je Lauf:
 *   RAW/JJJJ-MM-TT  ->  Ruhezeit + LOS.txt pruefen
 *                   ->  Aufnahmezeit je Foto lesen (EXIF, nicht Dateizeit!)
 *                   ->  in handliche Bloecke vorzerteilen
 *                   ->  Bilderkennung gruppiert je Block nach Produkten
 *                   ->  je Gruppe erfassen (der Server erkennt Duplikate selbst)
 *                   ->  Fotos nach IDENT/JJJJ-MM-TT verschieben
 *
 * Ein Foto wird NIE geloescht. Was mehrfach scheitert, wandert nach
 * FEHLER/JJJJ-MM-TT, damit es nicht bei jedem Lauf erneut Geld kostet.
 *
 * Aufruf:
 *   node index.js --dry-run     nichts erfassen, nichts verschieben, nur zeigen
 *   node index.js               echter Lauf
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { leseAufnahmezeit } = require('./lib/exif');
const { erkenneKameras } = require('./lib/kamera');
const { zerlegeNachAufnahme } = require('./lib/gruppierung');
const { pruefeOrdner, LOS_DATEINAME } = require('./lib/tagesordner');
const { berechnePause, DEFAULT_KONTINGENT } = require('./lib/drossel');
const register = require('./lib/register');
const { erstelleApi } = require('./lib/api');

const KONFIG = {
  share: process.env.FOTO_SHARE || '/Volumes/ProduktFotos',
  basisUrl: process.env.AVYCLOUD_URL || '',
  firebaseApiKey: process.env.FIREBASE_API_KEY || '',
  email: process.env.AGENT_EMAIL || '',
  passwort: process.env.AGENT_PASSWORT || '',
  registerPfad: process.env.FOTO_AGENT_REGISTER || path.join(process.env.HOME || '.', '.avycloud-foto-agent.json'),
  ruhezeitMinuten: Number(process.env.FOTO_RUHEZEIT_MINUTEN || 30),
  maxProLauf: Number(process.env.FOTO_MAX_PRO_LAUF || 10),
  maxVersuche: Number(process.env.FOTO_MAX_VERSUCHE || 3),
  kontingent: Number(process.env.FOTO_KONTINGENT || DEFAULT_KONTINGENT),
};

const trockenlauf = process.argv.includes('--dry-run');
const BILD_ENDUNGEN = /\.(jpe?g)$/i;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

function listeTagesordner(wurzel) {
  try {
    return fs.readdirSync(wurzel)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort();
  } catch (err) {
    log(`FEHLER: ${wurzel} nicht lesbar — ist der Share gemountet? (${err.message})`);
    return [];
  }
}

function lesePhoto(pfad) {
  const inhalt = fs.readFileSync(pfad);
  return {
    pfad,
    name: path.basename(pfad),
    inhalt,
    hash: crypto.createHash('sha256').update(inhalt).digest('hex'),
    // Fuer die Aufnahmezeit genuegt der Dateianfang.
    zeit: leseAufnahmezeit(inhalt.subarray(0, 65536)),
  };
}

function verschiebe(quelle, zielOrdner) {
  fs.mkdirSync(zielOrdner, { recursive: true });
  let ziel = path.join(zielOrdner, path.basename(quelle));
  // Niemals eine vorhandene Datei ueberschreiben — das waere Bildverlust.
  if (fs.existsSync(ziel)) {
    const endung = path.extname(ziel);
    ziel = path.join(zielOrdner, `${path.basename(ziel, endung)}_${Date.now()}${endung}`);
  }
  try {
    fs.renameSync(quelle, ziel);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(quelle, ziel);
    fs.unlinkSync(quelle);
  }
  return ziel;
}

async function main() {
  log(`Foto-Agent startet${trockenlauf ? ' (Trockenlauf — es wird nichts erfasst und nichts verschoben)' : ''}`);

  const rawWurzel = path.join(KONFIG.share, 'RAW');
  const identWurzel = path.join(KONFIG.share, 'IDENT');
  const fehlerWurzel = path.join(KONFIG.share, 'FEHLER');

  const reg = register.ladeRegister(KONFIG.registerPfad);
  const api = trockenlauf ? null : erstelleApi(KONFIG);

  const aufrufe = [];
  let erfasst = 0;
  let uebersprungen = 0;

  for (const tag of listeTagesordner(rawWurzel)) {
    if (erfasst >= KONFIG.maxProLauf) {
      log(`Kontingent fuer diesen Lauf erreicht (${KONFIG.maxProLauf} Produkte) — Rest folgt beim naechsten Mal.`);
      break;
    }

    const ordner = path.join(rawWurzel, tag);
    const dateien = fs.readdirSync(ordner).filter((n) => BILD_ENDUNGEN.test(n));
    if (!dateien.length) continue;

    const fotos = [];
    for (const name of dateien) {
      try {
        fotos.push(lesePhoto(path.join(ordner, name)));
      } catch (err) {
        log(`  ${tag}/${name}: nicht lesbar (${err.message})`);
      }
    }

    const offen = fotos.filter((f) => !register.istErledigt(reg, f.hash));
    const bereitsErfasst = fotos.length - offen.length;
    if (bereitsErfasst > 0) {
      // Erfasst, aber beim letzten Mal nicht verschoben — jetzt nachholen.
      for (const foto of fotos.filter((f) => register.istErledigt(reg, f.hash))) {
        if (!trockenlauf) verschiebe(foto.pfad, path.join(identWurzel, tag));
      }
      log(`${tag}: ${bereitsErfasst} bereits erfasste Foto(s) nachtraeglich nach IDENT verschoben.`);
    }
    if (!offen.length) continue;

    const aufgegeben = offen.filter((f) => register.istAufgegeben(reg, f.hash, KONFIG.maxVersuche));
    for (const foto of aufgegeben) {
      log(`${tag}/${foto.name}: nach ${KONFIG.maxVersuche} Versuchen aufgegeben -> FEHLER (${reg[foto.hash]?.letzterFehler})`);
      if (!trockenlauf) verschiebe(foto.pfad, path.join(fehlerWurzel, tag));
    }
    const zuTun = offen.filter((f) => !register.istAufgegeben(reg, f.hash, KONFIG.maxVersuche));
    if (!zuTun.length) continue;

    const losDatei = path.join(ordner, LOS_DATEINAME);
    const losInhalt = fs.existsSync(losDatei) ? fs.readFileSync(losDatei, 'utf8') : null;
    const neueste = zuTun.reduce((max, f) => (f.zeit && (!max || f.zeit > max) ? f.zeit : max), null);

    const pruefung = pruefeOrdner({
      neuesteAufnahme: neueste,
      losInhalt,
      ruhezeitMinuten: KONFIG.ruhezeitMinuten,
    });
    if (!pruefung.bereit) {
      log(`${tag}: uebersprungen (${pruefung.grund}) — ${pruefung.meldung}`);
      uebersprungen += 1;
      continue;
    }

    const kameras = erkenneKameras(zuTun.map((f) => f.name));
    const bloecke = zerlegeNachAufnahme(zuTun.map((f) => ({ ...f, kamera: kameras.get(f.name) })));
    log(`${tag}: ${zuTun.length} Foto(s), Los ${pruefung.losCode}, ${bloecke.length} Block/Bloecke.`);

    for (const block of bloecke) {
      if (erfasst >= KONFIG.maxProLauf) break;

      let gruppen;
      if (trockenlauf) {
        gruppen = [{ label: 'Trockenlauf', image_indices: block.map((_, i) => i) }];
      } else {
        try {
          gruppen = await api.gruppiereBilder(block);
        } catch (err) {
          log(`  Gruppierung fehlgeschlagen (${err.message}) — Block bleibt liegen.`);
          for (const foto of block) register.merkeFehlversuch(reg, foto.hash, `Gruppierung: ${err.message}`);
          continue;
        }
      }

      for (const gruppe of gruppen) {
        if (erfasst >= KONFIG.maxProLauf) break;

        const indizes = Array.isArray(gruppe.image_indices) ? gruppe.image_indices : [];
        const gruppenFotos = indizes.map((i) => block[i]).filter(Boolean);
        if (!gruppenFotos.length) continue;

        log(`  Gruppe "${gruppe.label || '?'}": ${gruppenFotos.map((f) => f.name).join(', ')}`);
        if (trockenlauf) { erfasst += 1; continue; }

        const pause = berechnePause({ letzteAufrufe: aufrufe, maxProFenster: KONFIG.kontingent });
        if (pause > 0) {
          log(`  Drossel: warte ${Math.round(pause / 1000)} s (Kontingent wird mit den Mitarbeitern geteilt).`);
          await schlafe(pause);
        }

        try {
          aufrufe.push(Date.now());
          const { produkt, meta } = await api.erfasse({
            dateien: gruppenFotos,
            barcodes: gruppe.detected_barcode || '',
            losCode: pruefung.losCode,
            hint: gruppe.hint || gruppe.label || '',
          });

          // Erfolg SOFORT vermerken — vor dem Verschieben. Scheitert das
          // Verschieben, laeuft die Datei sonst beim naechsten Lauf erneut
          // durch die Erkennung.
          for (const foto of gruppenFotos) {
            register.merkeErledigt(reg, foto.hash, { produktId: produkt?.id || null, tag });
          }
          register.speichereRegister(KONFIG.registerPfad, reg);

          const hinweis = meta?.reused_existing ? ' (war bereits im Bestand — kein neues Datenblatt)' : '';
          log(`    -> ${produkt?.identification?.name || produkt?.id || 'erfasst'}${hinweis}`);
          erfasst += 1;

          for (const foto of gruppenFotos) verschiebe(foto.pfad, path.join(identWurzel, tag));
        } catch (err) {
          log(`    FEHLER: ${err.message}`);
          for (const foto of gruppenFotos) register.merkeFehlversuch(reg, foto.hash, err.message);
          register.speichereRegister(KONFIG.registerPfad, reg);
        }
      }
    }
  }

  if (!trockenlauf) register.speichereRegister(KONFIG.registerPfad, reg);
  log(`Fertig: ${erfasst} Produkt(e) erfasst, ${uebersprungen} Ordner uebersprungen.`);
}

main().catch((err) => {
  console.error('Foto-Agent abgebrochen:', err?.stack || err);
  process.exit(1);
});
