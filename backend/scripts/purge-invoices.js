'use strict';

/**
 * purge-invoices.js — Entfernt die automatisch erzeugten Rechnungen aus
 * SevDesk UND aus AvyCloud.
 *
 * Betreiber-Anweisung 2026-08-17 (woertlich): "die bereits erstellten
 * rechnungen in sevdesk und avycloud muessen entfernt werden. als B2C haendler
 * muss trendocean keine rechnungen ausstellen. ... die automatische
 * rechnungserstellung in sevdesk hat aktuell nur zur folge das ueber 350
 * rechnungen faellig sind welche die gesamte auswertung verfaelschen."
 *
 * Gemessen im SevDesk-Bestand am 17.08.2026: 467 faellige Rechnungen ueber
 * 18.158,48 EUR (offene Posten), EBIT-Kachel -17.626,30 EUR.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DREI DINGE, DIE DIESES SCRIPT BEWUSST NICHT TUT
 * ────────────────────────────────────────────────────────────────────────
 * 1. ES STORNIERT NIE VON SELBST. Ein Storno (POST /Invoice/{id}/cancelInvoice)
 *    erzeugt eine ZUSAETZLICHE Stornorechnung — es entfernt nichts, es
 *    verdoppelt. Genau das Gegenteil des Ziels. Belege, die sich nicht
 *    loeschen lassen (festgeschrieben / bezahlt), werden GEMELDET, nicht
 *    angefasst. Die Entscheidung darueber gehoert dem Betreiber und dem
 *    Steuerberater, nicht einem Script.
 * 2. ES LOESCHT KEINE PDF-DATEIEN. Die Rechnungs-PDFs in GCS sind nach dem
 *    Loeschen der Datensaetze der einzige Nachweis darueber, was ueberhaupt
 *    ausgestellt war. Speicher kostet fast nichts, ein fehlender Nachweis
 *    kostet viel. Optional ueber --delete-pdfs.
 * 3. ES ENTFERNT KEINE FIRESTORE-FELDER. Die Auftragsfelder werden auf null
 *    gesetzt, nicht geloescht (CLAUDE.md: additive only). Falsy ist, was der
 *    Code prueft — `if (!order.invoiceId)` und `{order.invoiceNumber && …}`
 *    verhalten sich mit null identisch zu "nicht vorhanden".
 *
 * ────────────────────────────────────────────────────────────────────────
 * TOTE-ID-FALLE (warum SevDesk und AvyCloud ZUSAMMEN aufgeraeumt werden)
 * ────────────────────────────────────────────────────────────────────────
 * generateInvoice benutzt order.invoiceSevdeskId als "schon geprägt"-Marker
 * und verwendet die ID WIEDER, statt neu zu praegen (invoice-engine.js:285 —
 * Schutz gegen den Doppel-Rechnungs-Vorfall vom 20.07.2026). Wird der Beleg in
 * SevDesk geloescht, ohne dieses Feld zu leeren, laufen sendBy (Z. 310) und
 * der GET-Fallback (Z. 324) gegen eine tote ID: invoiceNumber bleibt null,
 * Z. 343 wirft — der Auftrag bekommt NIE WIEDER eine Rechnung, auch nicht
 * ueber den Knopf. Deshalb loest dieser Lauf im selben Zug die Auftragsfelder,
 * und --sevdesk-only ist nur mit --allow-stale-links erlaubt.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FALSCHE-FIRMA-SCHUTZ
 * ────────────────────────────────────────────────────────────────────────
 * Lokale Scripts loesen Firestore ohne projectId auf und landen dann im
 * fremden GCP-Projekt (gcloud steht lokal auf kalima-503608). Dieses Script
 * erzwingt das Projekt, liest den SevDesk-Mandantennamen und DRUCKT beides,
 * bevor es irgendetwas veraendert. Wer den falschen Namen sieht, bricht ab.
 *
 * ────────────────────────────────────────────────────────────────────────
 * AUFRUF
 * ────────────────────────────────────────────────────────────────────────
 *   # 1. Immer zuerst: Bericht, veraendert nichts
 *   node backend/scripts/purge-invoices.js
 *
 *   # 2. Erst nach Sichtung des Berichts:
 *   node backend/scripts/purge-invoices.js --apply --confirm PURGE_INVOICES_V1
 *
 * OPTIONEN
 *   --tenant <id>      Mandant (Default: TENANT_ID oder 'default')
 *   --sevdesk-only     Nur SevDesk aufraeumen, AvyCloud unberuehrt lassen.
 *                      GEFAEHRLICH — braucht zusaetzlich --allow-stale-links,
 *                      siehe TOTE-ID-FALLE unten.
 *   --firestore-only   Nur AvyCloud aufraeumen, SevDesk unberuehrt lassen
 *   --keep-storno      Stornorechnungen (invoiceType SR) verschonen.
 *                      Default: NEIN — sie werden mit geloescht. Betreiber-
 *                      Anweisung 2026-08-17: "rechnungen in sevdesk inkl.
 *                      stornos restlos entfernen wenn moeglich". Wichtig ist
 *                      nur, dass RE und ihr SR ZUSAMMEN fallen: ein Storno
 *                      ohne sein Original ist ein Beleg ohne Bezug.
 *   --keep-paid        Bezahlte Belege (Status >= 750) verschonen.
 *                      Default: NEIN — auch sie werden geloescht.
 *   --since YYYY-MM-DD Nur Rechnungen ab diesem Rechnungsdatum
 *   --until YYYY-MM-DD Nur Rechnungen bis zu diesem Rechnungsdatum
 *   --max <n>          Sicherheits-Obergrenze (Default 1000)
 *   --delete-pdfs      Zusaetzlich die PDF-Dateien in GCS loeschen
 */

const CONFIRM_TOKEN = 'PURGE_INVOICES_V1';
const SEVDESK_BASE = 'https://my.sevdesk.de/api/v1';

// ─── Argumente ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function value(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const APPLY = flag('apply');
const CONFIRM = value('confirm');
const TENANT = value('tenant', process.env.TENANT_ID || 'default');
const SEVDESK_ONLY = flag('sevdesk-only');
const FIRESTORE_ONLY = flag('firestore-only');
const KEEP_STORNO = flag('keep-storno');
const KEEP_PAID = flag('keep-paid');
const SINCE = value('since');
const UNTIL = value('until');
const MAX = parseInt(value('max', '1000'), 10);
const DELETE_PDFS = flag('delete-pdfs');
const ALLOW_STALE_LINKS = flag('allow-stale-links');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'avycloud';

// MUSS vor dem ersten require von integration-store/firestore stehen: die
// Bibliotheken bauen ihren eigenen Firestore-Client OHNE projectId und landen
// dann in dem Projekt, auf das gcloud lokal gerade zeigt — hier ist das
// kalima-503608, also eine FREMDE Firma. Gemessen am 17.08.2026: lokale
// Scripts lasen darueber stillschweigend fremde Zugangsdaten.
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

// SevDesk-Belegstatus (so kodiert es die API; siehe auch
// invoice-engine.js importFromSevDesk STATUS_MAP und
// sevdesk-storno-duplicates.js).
const STATUS_LABEL = {
  50: 'Entwurf (angelegt)',
  100: 'Entwurf',
  200: 'Offen / faellig',
  750: 'Teilweise bezahlt',
  1000: 'Bezahlt',
};

function statusLabel(s) { return STATUS_LABEL[Number(s)] || `unbekannt (${s})`; }
function eur(n) { return `${(Number(n) || 0).toFixed(2)} €`; }
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── SevDesk ────────────────────────────────────────────────────────────

async function sevdeskMandant(token) {
  try {
    const r = await fetch(`${SEVDESK_BASE}/SevUser`, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const u = Array.isArray(d?.objects) ? d.objects[0] : null;
    return {
      benutzer: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.username || null,
      mandantId: u?.sevClient?.id || null,
    };
  } catch {
    return null;
  }
}

async function ladeAlleRechnungen(token) {
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const alle = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const r = await fetch(`${SEVDESK_BASE}/Invoice?limit=${limit}&offset=${offset}`, { headers });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`SevDesk GET /Invoice ${r.status}: ${t.slice(0, 300)}`);
    }
    const d = await r.json();
    const seite = Array.isArray(d?.objects) ? d.objects : [];
    alle.push(...seite);
    if (seite.length < limit) break;
    offset += limit;
  }
  return alle;
}

/**
 * Loescht EINEN Beleg. Gibt niemals throw — der Aufrufer braucht den Grund,
 * nicht einen Abbruch mitten im Lauf.
 * @returns {Promise<{ok: boolean, status?: number, body?: string}>}
 */
async function loescheRechnung(token, id) {
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  for (let versuch = 1; versuch <= 3; versuch++) {
    let r;
    try {
      r = await fetch(`${SEVDESK_BASE}/Invoice/${id}`, { method: 'DELETE', headers });
    } catch (err) {
      if (versuch === 3) return { ok: false, body: `Netzfehler: ${err.message}` };
      await schlaf(1000 * versuch);
      continue;
    }
    if (r.ok) return { ok: true, status: r.status };
    // 429 = Ratenbegrenzung, 5xx = voruebergehend → erneut versuchen.
    // 4xx sonst = SevDesk verweigert dauerhaft (festgeschrieben o.ae.).
    if (r.status === 429 || r.status >= 500) {
      if (versuch === 3) return { ok: false, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) };
      await schlaf(2000 * versuch);
      continue;
    }
    return { ok: false, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) };
  }
  return { ok: false, body: 'unerreichbar' };
}

// ─── Hauptlauf ──────────────────────────────────────────────────────────

async function main() {
  const bericht = {
    lauf: { modus: APPLY ? 'APPLY' : 'DRY-RUN', tenant: TENANT, projekt: PROJECT_ID, zeit: new Date().toISOString() },
    sevdesk: { gesamt: 0, kandidaten: [], geloescht: [], verweigert: [], uebersprungen: [] },
    avycloud: { rechnungsdocs: 0, auftraege: 0, pdfs: 0 },
  };

  console.log('═'.repeat(72));
  console.log(`  RECHNUNGS-BEREINIGUNG — ${APPLY ? 'APPLY (veraendert echte Daten!)' : 'DRY-RUN (veraendert nichts)'}`);
  console.log('═'.repeat(72));
  console.log(`  GCP-Projekt : ${PROJECT_ID}`);
  console.log(`  Mandant     : ${TENANT}`);

  if (SEVDESK_ONLY && FIRESTORE_ONLY) {
    throw new Error('--sevdesk-only und --firestore-only schliessen einander aus.');
  }
  if (SEVDESK_ONLY && !ALLOW_STALE_LINKS) {
    // TOTE-ID-FALLE, siehe Kopf dieser Datei. In SevDesk loeschen und die
    // Auftragsfelder stehen lassen macht die betroffenen Auftraege dauerhaft
    // rechnungsunfaehig — auch ueber den Knopf.
    throw new Error(
      '--sevdesk-only wuerde order.invoiceSevdeskId auf geloeschte Belege zeigen lassen. '
      + 'Diese Auftraege koennten NIE WIEDER eine Rechnung bekommen (invoice-engine.js:285). '
      + 'Entweder ohne --sevdesk-only laufen lassen, oder bewusst --allow-stale-links setzen.'
    );
  }
  if (APPLY && CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }

  // ── 1. SevDesk ────────────────────────────────────────────────────────
  //
  // SEVDESK IST DIE AUTORITAET. Die Liste wird IMMER geladen — auch bei
  // --firestore-only. Erst sie sagt, welcher Beleg noch lebt; und nur was dort
  // NICHT mehr existiert, darf lokal geloest werden. Ohne diese Regel loeste
  // der Lauf auch Auftraege von Belegen, die SevDesk gar nicht loeschen liess:
  // dann faellt der Praegeschutz (order.invoiceSevdeskId) weg UND der Knopf
  // "Rechnung erstellen" erscheint wieder (er haengt an !order.invoiceNumber)
  // — ein Klick praegt neben der noch lebenden alten eine ZWEITE echte,
  // fortlaufend nummerierte Rechnung.
  //
  // Nebeneffekt derselben Regel: --since/--until/--include-paid/--max wirken
  // damit automatisch auch auf die Firestore-Haelfte. Vorher raeumte sie
  // ungefiltert alles ab, ein als Probelauf gedachter Aufruf hatte also lokal
  // volle Wirkung.
  const { getIntegrationSecret } = require('../services/integration-store');
  const token = await getIntegrationSecret('SEVDESK_API_TOKEN', { tenantId: TENANT });
  if (!token) throw new Error('Kein SevDesk-Token aufloesbar (INTEGRATION_CREDENTIALS_STORE / ENV pruefen).');

  const mandant = await sevdeskMandant(token);
  console.log(`  SevDesk     : ${mandant?.benutzer || 'unbekannt'} (Mandant-ID ${mandant?.mandantId || '?'})`);
  console.log('─'.repeat(72));
  console.log('  Stimmen Projekt und SevDesk-Mandant? Wenn nein: JETZT abbrechen (Strg-C).');
  console.log('─'.repeat(72));

  const alle = await ladeAlleRechnungen(token);
  bericht.sevdesk.gesamt = alle.length;
  console.log(`\n[sevdesk] ${alle.length} Belege geladen.`);

  /** IDs, die nach diesem Lauf in SevDesk noch existieren. */
  const lebendeIds = new Set(alle.map((inv) => String(inv.id)));

  {

    // Verteilung zeigen, BEVOR gefiltert wird — sonst weiss niemand, was da liegt.
    const nachStatus = new Map();
    for (const inv of alle) {
      const k = `${statusLabel(inv.status)} · ${inv.invoiceType || '?'}`;
      const e = nachStatus.get(k) || { n: 0, brutto: 0 };
      e.n++; e.brutto += Number(inv.sumGross) || 0;
      nachStatus.set(k, e);
    }
    console.log('\n  Bestand nach Status:');
    for (const [k, v] of [...nachStatus.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`    ${String(v.n).padStart(5)} × ${k.padEnd(34)} ${eur(v.brutto).padStart(14)}`);
    }

    for (const inv of alle) {
      const typ = String(inv.invoiceType || '');
      const status = Number(inv.status);
      const datum = String(inv.invoiceDate || '').split('T')[0];
      const zeile = {
        id: String(inv.id),
        nr: inv.invoiceNumber || null,
        typ,
        status,
        statusText: statusLabel(status),
        datum,
        brutto: Number(inv.sumGross) || 0,
      };

      if (typ === 'SR' && KEEP_STORNO) {
        bericht.sevdesk.uebersprungen.push({ ...zeile, grund: 'Stornorechnung (--keep-storno)' });
        continue;
      }
      if (status >= 750 && KEEP_PAID) {
        bericht.sevdesk.uebersprungen.push({ ...zeile, grund: 'bezahlt (--keep-paid)' });
        continue;
      }
      if (SINCE && datum && datum < SINCE) {
        bericht.sevdesk.uebersprungen.push({ ...zeile, grund: `vor --since ${SINCE}` });
        continue;
      }
      if (UNTIL && datum && datum > UNTIL) {
        bericht.sevdesk.uebersprungen.push({ ...zeile, grund: `nach --until ${UNTIL}` });
        continue;
      }
      bericht.sevdesk.kandidaten.push(zeile);
    }

    // STORNORECHNUNGEN ZUERST. Eine SR verweist auf ihre RE; loescht man die
    // RE zuerst, kann SevDesk die Loeschung verweigern oder die SR bleibt als
    // Beleg ohne Bezug stehen. Innerhalb einer Gruppe die juengste zuerst
    // (absteigende Nummer), damit die Nummernfolge von hinten abgebaut wird.
    bericht.sevdesk.kandidaten.sort((a, b) => {
      if (a.typ !== b.typ) return a.typ === 'SR' ? -1 : 1;
      return String(b.nr || '').localeCompare(String(a.nr || ''), 'de', { numeric: true });
    });

    const summe = bericht.sevdesk.kandidaten.reduce((s, k) => s + k.brutto, 0);
    console.log(`\n  Zum Loeschen vorgesehen: ${bericht.sevdesk.kandidaten.length} Belege · ${eur(summe)}`);
    console.log(`  Uebersprungen         : ${bericht.sevdesk.uebersprungen.length}`);

    if (bericht.sevdesk.kandidaten.length > MAX) {
      throw new Error(`Sicherheits-Abbruch: ${bericht.sevdesk.kandidaten.length} Kandidaten > --max ${MAX}.`);
    }

    if (APPLY && !FIRESTORE_ONLY) {
      console.log('\n[sevdesk] loesche …');
      let i = 0;
      for (const k of bericht.sevdesk.kandidaten) {
        i++;
        const res = await loescheRechnung(token, k.id);
        if (res.ok) {
          bericht.sevdesk.geloescht.push(k);
          lebendeIds.delete(k.id); // ab jetzt darf der lokale Bezug fallen
        } else {
          bericht.sevdesk.verweigert.push({ ...k, http: res.status || null, antwort: res.body || null });
        }
        if (i % 25 === 0 || i === bericht.sevdesk.kandidaten.length) {
          console.log(`  ${i}/${bericht.sevdesk.kandidaten.length} — geloescht ${bericht.sevdesk.geloescht.length}, verweigert ${bericht.sevdesk.verweigert.length}`);
        }
        await schlaf(150); // SevDesk-Ratenbegrenzung schonen
      }
    } else if (FIRESTORE_ONLY) {
      // SevDesk bleibt unberuehrt. Geloest wird lokal nur, was dort ohnehin
      // schon fehlt (z. B. von Hand geloescht) — der Bestand entscheidet.
      console.log('\n  (--firestore-only — SevDesk wird nicht angefasst; lokal wird nur geloest, was dort bereits fehlt)');
    } else {
      // Trockenlauf: den Endzustand simulieren, damit der Bericht zeigt, was
      // die Firestore-Haelfte danach tatsaechlich anfassen wuerde.
      bericht.sevdesk.kandidaten.forEach((k) => lebendeIds.delete(k.id));
      console.log('\n  (DRY-RUN — es wurde nichts geloescht)');
      bericht.sevdesk.kandidaten.slice(0, 30).forEach((k) => {
        console.log(`    ✗ ${String(k.nr || '(ohne Nr.)').padEnd(12)} ${k.datum} ${eur(k.brutto).padStart(12)}  ${k.statusText}`);
      });
      if (bericht.sevdesk.kandidaten.length > 30) {
        console.log(`    … und ${bericht.sevdesk.kandidaten.length - 30} weitere (vollstaendig im Bericht)`);
      }
    }
  }

  // ── 2. AvyCloud (Firestore) ───────────────────────────────────────────
  if (!SEVDESK_ONLY) {
    const { Firestore, FieldValue } = require('@google-cloud/firestore');
    const db = new Firestore({ projectId: PROJECT_ID });

    const invSnap = await db.collection('invoices').where('tenantId', '==', TENANT).get();

    // Ein Rechnungs-Datensatz faellt nur, wenn sein SevDesk-Beleg nicht mehr
    // existiert. Ueberlebt der Beleg (Loeschung verweigert, ausserhalb von
    // --since/--until, bezahlt), bleibt der Spiegel stehen — sonst luegt die
    // Rechnungsliste, und der 24h-Import legt ihn ohnehin wieder an.
    const zuLoeschendeDocs = invSnap.docs.filter((d) => {
      const sid = String(d.data().sevdeskId || '').trim();
      return !sid || !lebendeIds.has(sid);
    });
    /** Doc-IDs, deren Beleg weg ist — daran haengt die Auftrags-Loesung. */
    const gefalleneDocIds = new Set(zuLoeschendeDocs.map((d) => d.id));

    const ordSnap = await db.collection('orders').where('tenantId', '==', TENANT).get();
    const betroffeneAuftraege = ordSnap.docs.filter((d) => {
      const o = d.data();
      const hatBezug = o.invoiceId || o.invoiceNumber || o.invoiceSevdeskId || o.sevdeskInvoiceId || o.invoiceClaimedAt;
      if (!hatBezug) return false;
      // ZWEI Feldnamen fuer dieselbe Sache: invoiceSevdeskId schreibt
      // generateInvoice, sevdeskInvoiceId schreibt importFromSevDesk.
      const sid = String(o.invoiceSevdeskId || o.sevdeskInvoiceId || '').trim();
      if (sid) return !lebendeIds.has(sid);
      // Kein SevDesk-Bezug: dann entscheidet der lokale Datensatz.
      if (o.invoiceId) return gefalleneDocIds.has(String(o.invoiceId));
      // Nur eine haengengebliebene Praege-Sperre ohne Beleg — die darf weg.
      return !!o.invoiceClaimedAt && !o.invoiceNumber;
    });

    bericht.avycloud.rechnungsdocs = zuLoeschendeDocs.length;
    bericht.avycloud.auftraege = betroffeneAuftraege.length;
    bericht.avycloud.rechnungsdocsBleiben = invSnap.size - zuLoeschendeDocs.length;

    console.log(`\n[avycloud] Rechnungs-Datensaetze gesamt: ${invSnap.size}`);
    console.log(`[avycloud]   davon zu loeschen (Beleg in SevDesk weg): ${zuLoeschendeDocs.length}`);
    console.log(`[avycloud]   bleiben stehen (Beleg lebt weiter)      : ${invSnap.size - zuLoeschendeDocs.length}`);
    console.log(`[avycloud] Auftraege zu loesen: ${betroffeneAuftraege.length} von ${ordSnap.size}`);

    if (APPLY) {
      // PDFs nur auf ausdruecklichen Wunsch — sie sind der letzte Nachweis.
      if (DELETE_PDFS) {
        const { Storage } = require('@google-cloud/storage');
        const storage = new Storage({ projectId: PROJECT_ID });
        for (const doc of zuLoeschendeDocs) {
          const url = doc.data().pdfUrl;
          if (!url || !String(url).startsWith('gs://')) continue;
          const pfad = String(url).slice('gs://'.length);
          const schnitt = pfad.indexOf('/');
          try {
            await storage.bucket(pfad.slice(0, schnitt)).file(pfad.slice(schnitt + 1)).delete();
            bericht.avycloud.pdfs++;
          } catch { /* schon weg oder unzugaenglich — kein Grund abzubrechen */ }
        }
        console.log(`[avycloud] PDFs geloescht: ${bericht.avycloud.pdfs}`);
      }

      // Firestore-Batches fassen 500 Operationen; 400 laesst Luft.
      const BATCH = 400;
      for (let i = 0; i < zuLoeschendeDocs.length; i += BATCH) {
        const b = db.batch();
        zuLoeschendeDocs.slice(i, i + BATCH).forEach((d) => b.delete(d.ref));
        await b.commit();
      }
      console.log(`[avycloud] ${zuLoeschendeDocs.length} Rechnungs-Datensaetze geloescht.`);

      // Auftragsfelder auf null — NICHT entfernen (CLAUDE.md: additive only).
      // null ist falsy, verhaelt sich fuer jeden Leser wie "nicht vorhanden",
      // und der Verlauf bleibt im Dokument sichtbar.
      for (let i = 0; i < betroffeneAuftraege.length; i += BATCH) {
        const b = db.batch();
        betroffeneAuftraege.slice(i, i + BATCH).forEach((d) => b.set(d.ref, {
          invoiceId: null,
          invoiceNumber: null,
          invoiceSevdeskId: null,
          sevdeskInvoiceId: null,
          invoiceClaimedAt: null,
          invoicePurgedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, { merge: true }));
        await b.commit();
      }
      console.log(`[avycloud] ${betroffeneAuftraege.length} Auftraege vom Rechnungsbezug geloest.`);
      void FieldValue; // bewusst ungenutzt: keine Feld-Loeschung, nur null
    } else {
      console.log('  (DRY-RUN — es wurde nichts geloescht)');
    }
  }

  // ── 3. Bericht ────────────────────────────────────────────────────────
  const fs = require('fs');
  const pfad = `/tmp/purge-invoices-${APPLY ? 'apply' : 'dry'}-${Date.now()}.json`;
  fs.writeFileSync(pfad, JSON.stringify(bericht, null, 2));

  console.log('\n' + '═'.repeat(72));
  if (bericht.sevdesk.verweigert.length > 0) {
    console.log(`  ⚠ ${bericht.sevdesk.verweigert.length} Belege hat SevDesk NICHT geloescht.`);
    console.log('    Das sind in aller Regel festgeschriebene oder bezahlte Rechnungen.');
    console.log('    Sie brauchen eine Entscheidung von Betreiber + Steuerberater —');
    console.log('    dieses Script storniert bewusst nicht von selbst.');
    bericht.sevdesk.verweigert.slice(0, 15).forEach((v) => {
      console.log(`      ${String(v.nr || v.id).padEnd(12)} HTTP ${v.http} — ${String(v.antwort || '').slice(0, 90)}`);
    });
  }
  console.log(`  Bericht: ${pfad}`);
  console.log('═'.repeat(72));
}

main().catch((err) => {
  console.error(`\n[purge-invoices] ABBRUCH: ${err.message}`);
  process.exit(1);
});
