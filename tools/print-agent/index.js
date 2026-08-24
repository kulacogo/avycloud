'use strict';

/**
 * AvyCloud Druck-Agent.
 *
 * Laeuft auf einem Rechner IM Buero-Netz (dort, wo die Etikettendrucker
 * haengen) und holt Druckauftraege aus AvyCloud ab. Damit sieht der Bediener am
 * Handscanner nie wieder Androids Teilen-/Druckauswahl und muss nie wieder den
 * Drucker raten: er tippt in AvyCloud auf „Drucken", und das Etikett kommt aus
 * dem richtigen Geraet.
 *
 * Warum nicht direkt aus dem Backend drucken: Cloud Run (europe-west3) kann
 * eine private LAN-Adresse prinzipiell nicht erreichen. Und der Browser des
 * Handscanners darf von einer HTTPS-Seite aus kein http:// im lokalen Netz
 * aufrufen (gemischte Inhalte). Der Agent loest beides.
 *
 * Einrichtung: README.md
 */

const { erstelleApi } = require('./lib/api');
const { waehleDrucker, druckeBuffer, listeDrucker, listeMedien, waehleMedium } = require('./lib/drucker');

const argumente = process.argv.slice(2);
const istProbelauf = argumente.includes('--dry-run');
const nurDrucker = argumente.includes('--list-printers');

const konfig = {
  basisUrl: (process.env.AVYCLOUD_URL || '').replace(/\/+$/, ''),
  firebaseApiKey: process.env.FIREBASE_API_KEY || '',
  email: process.env.AGENT_EMAIL || '',
  passwort: process.env.AGENT_PASSWORT || '',
  agentId: process.env.PRINT_AGENT_ID || `print-agent-${require('node:os').hostname()}`,
  drucker: {
    parcel: process.env.PRINTER_PARCEL || '',
    letter: process.env.PRINTER_LETTER || '',
  },
  // Wie oft nachgefragt wird. Ein Etikett soll gefuehlt sofort kommen.
  taktMs: Number(process.env.PRINT_POLL_MS || 2000),
  fitToPage: String(process.env.PRINT_FIT_TO_PAGE || 'on').toLowerCase() !== 'off',
};

const jetzt = () => new Date().toISOString().slice(11, 19);
const log = (...teile) => console.log(`[${jetzt()}]`, ...teile);

/**
 * Welche Medien-Namen jeder Drucker fuehrt. Einmal beim Start gelesen —
 * Rollenformate aendern sich nicht im Betrieb.
 */
const medienJeDrucker = new Map();

async function ladeMedien() {
  for (const name of Object.values(konfig.drucker)) {
    if (!name || medienJeDrucker.has(name)) continue;
    medienJeDrucker.set(name, await listeMedien(name));
  }
}

async function einAuftrag(api) {
  const auftrag = await api.holeAuftrag({ agentId: konfig.agentId });
  if (!auftrag) return false;

  const kennung = auftrag.jobId || auftrag.id;
  log(`Auftrag ${kennung}: ${auftrag.orderId} — Rolle ${auftrag.printerRole} `
    + `(${auftrag.widthMm}x${auftrag.heightMm} mm, ${auftrag.copies}x)`);

  try {
    const druckerName = waehleDrucker(auftrag.printerRole, konfig.drucker);
    const vorhandeneMedien = medienJeDrucker.get(druckerName) || [];
    const pdf = await api.ladeDokument(kennung);

    if (istProbelauf) {
      const medium = waehleMedium(auftrag.widthMm, auftrag.heightMm, vorhandeneMedien);
      log(`  Probelauf: wuerde ${pdf.length} Bytes an "${druckerName}" geben `
        + `(media=${medium}) — nichts gedruckt.`);
      return true;
    }

    const antwort = await druckeBuffer({
      buffer: pdf,
      druckerName,
      widthMm: auftrag.widthMm,
      heightMm: auftrag.heightMm,
      copies: auftrag.copies,
      jobId: kennung,
      fitToPage: konfig.fitToPage,
      vorhandeneMedien,
    });
    log(`  gedruckt auf "${druckerName}" ${antwort ? `(${antwort})` : ''}`);
    await api.melderErgebnis(kennung, { ok: true });
  } catch (fehler) {
    log(`  FEHLER: ${fehler.message}`);
    if (!istProbelauf) {
      // Immer zurueckmelden — sonst haengt der Auftrag bis zum Ablauf der
      // Zusage und der Bediener wartet auf ein Etikett, das nie kommt.
      await api.melderErgebnis(kennung, { ok: false, fehler: fehler.message }).catch(() => {});
    }
  }
  return true;
}

async function hauptschleife() {
  if (nurDrucker) {
    const liste = await listeDrucker();
    console.log(liste.length ? liste.join('\n') : 'Keine Drucker gefunden (laeuft CUPS?).');
    return;
  }

  const api = erstelleApi(konfig);
  await ladeMedien();
  log(`Druck-Agent "${konfig.agentId}" startet${istProbelauf ? ' (Probelauf)' : ''}.`);
  for (const [rolle, mass] of [['parcel', [103, 164]], ['letter', [62, 100]]]) {
    const name = konfig.drucker[rolle];
    if (!name) {
      log(`  ${mass[0]}x${mass[1]} mm -> NICHT EINGERICHTET`);
      continue;
    }
    const medien = medienJeDrucker.get(name) || [];
    const medium = waehleMedium(mass[0], mass[1], medien);
    // Ehrlich melden, ob das Rollenformat benannt gefuehrt wird. Ein
    // `Custom.`-Name ist kein Fehler, aber ein Hinweis darauf, dass CUPS die
    // Raender schaetzt — und damit die haeufigste Ursache versetzter Drucke.
    const art = medium.startsWith('Custom.') ? 'geschaetzt' : 'kalibriert';
    log(`  ${mass[0]}x${mass[1]} mm -> "${name}" (media=${medium}, ${art})`);
  }

  let letzteMeldung = 0;
  for (;;) {
    try {
      // Regelmaessig am Leben melden — die Oberflaeche entscheidet daran, ob
      // sie den Druckauftrag einreiht oder auf den alten Weg zurueckfaellt.
      if (Date.now() - letzteMeldung > 30000) {
        await api.melde({ agentId: konfig.agentId, drucker: konfig.drucker });
        letzteMeldung = Date.now();
      }

      // Solange Auftraege da sind, ohne Pause weitermachen.
      let gearbeitet = true;
      while (gearbeitet) gearbeitet = await einAuftrag(api);
    } catch (fehler) {
      log(`Schleifenfehler: ${fehler.message}`);
    }
    await new Promise((r) => setTimeout(r, konfig.taktMs));
  }
}

if (require.main === module) {
  hauptschleife().catch((fehler) => {
    console.error(`Abbruch: ${fehler.message}`);
    process.exit(1);
  });
}

module.exports = { konfig, einAuftrag };
