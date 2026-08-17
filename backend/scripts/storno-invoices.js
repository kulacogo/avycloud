'use strict';

/**
 * storno-invoices.js — Storniert die offenen Rechnungen, die SevDesk nicht
 * loeschen laesst.
 *
 * VORGESCHICHTE: `scripts/purge-invoices.js --apply` lief am 18.08.2026 und
 * konnte GENAU 28 Belege entfernen — die Entwuerfe. Die uebrigen 637 hat
 * SevDesk verweigert, mit drei unmissverstaendlichen Begruendungen:
 *   467 × "Invoice can only be deleted in status 100 but is status 200"
 *    85 × "Invoice can only be deleted in status 100 but is status 1000"
 *    85 × "Already enshrined by object"
 * SevDesk laesst NUR Entwuerfe loeschen. Alles Festgeschriebene ist
 * unwiderruflich — das ist die GoBD-Regel der Software, keine Einstellung.
 *
 * WAS DER STORNO ERREICHT — und was nicht:
 *   ERREICHT: die Rechnung ist danach nicht mehr faellig. Die offenen Posten
 *     (gemessen 467 Stueck / 21.608,41 €) gehen auf NULL, die Auswertung ist
 *     wieder ehrlich, und es gibt nichts mehr, wogegen eine Marktplatz-
 *     Auszahlung faelschlich zugeordnet werden koennte.
 *   ERREICHT NICHT: die Belege verschwinden nicht. Es kommen im Gegenteil je
 *     Rechnung ein Storno-Beleg (SR) dazu. RE und SR heben sich betragsmaessig
 *     exakt auf — genau so sehen die 85 Paare aus, die im Juli entstanden sind
 *     (85 × +3.523,40 € RE gegen 85 × -3.523,40 € SR). Diese 170 Belege
 *     verfaelschen nachweislich nichts.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WAS DIESES SCRIPT BEWUSST NICHT ANFASST
 * ────────────────────────────────────────────────────────────────────────
 * - Stornorechnungen selbst (invoiceType 'SR'). Ein Storno auf einen Storno
 *   ist Unsinn und wuerde die Kette nur verlaengern.
 * - Rechnungen im Status 1000. Die sind BEREITS storniert: beim Stornieren
 *   geht das Original auf 1000 und bekommt seine SR. Genau daher ruehrt das
 *   85/85-Paar. Ein zweiter Durchlauf wuerde Belege verdoppeln.
 * - Entwuerfe (Status 100). Die gehoeren geloescht, nicht storniert —
 *   `purge-invoices.js` hat das bereits erledigt.
 * Ziel ist also GENAU: invoiceType 'RE' mit Status 200.
 *
 * ────────────────────────────────────────────────────────────────────────
 * AUFRUF
 * ────────────────────────────────────────────────────────────────────────
 *   node backend/scripts/storno-invoices.js
 *   node backend/scripts/storno-invoices.js --apply --confirm STORNO_INVOICES_V1
 *
 * OPTIONEN
 *   --tenant <id>   Mandant (Default: TENANT_ID oder 'default')
 *   --since / --until YYYY-MM-DD   Rechnungsdatum eingrenzen
 *   --max <n>       Sicherheits-Obergrenze (Default 600)
 */

const CONFIRM_TOKEN = 'STORNO_INVOICES_V1';
const SEVDESK_BASE = 'https://my.sevdesk.de/api/v1';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
function value(n, fallback = null) {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const APPLY = flag('apply');
const CONFIRM = value('confirm');
const TENANT = value('tenant', process.env.TENANT_ID || 'default');
const SINCE = value('since');
const UNTIL = value('until');
const MAX = parseInt(value('max', '600'), 10);

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'avycloud';
// MUSS vor dem ersten require von integration-store stehen — sonst baut die
// Bibliothek ihren Firestore-Client ohne projectId und liest die FREMDE Firma
// (gcloud zeigt lokal auf kalima-503608).
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const eur = (n) => `${(Number(n) || 0).toFixed(2)} €`;
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

async function sevdeskMandant(token) {
  try {
    const r = await fetch(`${SEVDESK_BASE}/SevUser`, { headers: { Authorization: token } });
    if (!r.ok) return null;
    const u = (await r.json())?.objects?.[0];
    return {
      benutzer: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.username || null,
      mandantId: u?.sevClient?.id || null,
    };
  } catch { return null; }
}

async function ladeAlleRechnungen(token) {
  const alle = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const r = await fetch(`${SEVDESK_BASE}/Invoice?limit=${limit}&offset=${offset}`, { headers: { Authorization: token } });
    if (!r.ok) throw new Error(`GET /Invoice ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const seite = (await r.json())?.objects || [];
    alle.push(...seite);
    if (seite.length < limit) break;
    offset += limit;
  }
  return alle;
}

/** Storniert EINEN Beleg. Wirft nie — der Aufrufer braucht den Grund. */
async function storniere(token, id) {
  for (let versuch = 1; versuch <= 3; versuch++) {
    let r;
    try {
      r = await fetch(`${SEVDESK_BASE}/Invoice/${id}/cancelInvoice`, {
        method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      if (versuch === 3) return { ok: false, body: `Netzfehler: ${err.message}` };
      await schlaf(1000 * versuch);
      continue;
    }
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      return { ok: true, stornoId: d?.objects?.id || d?.objects?.invoice?.id || null };
    }
    if (r.status === 429 || r.status >= 500) {
      if (versuch === 3) return { ok: false, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) };
      await schlaf(2000 * versuch);
      continue;
    }
    return { ok: false, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) };
  }
  return { ok: false, body: 'unerreichbar' };
}

async function main() {
  console.log('═'.repeat(72));
  console.log(`  RECHNUNGS-STORNO — ${APPLY ? 'APPLY (erzeugt echte Storno-Belege!)' : 'DRY-RUN (veraendert nichts)'}`);
  console.log('═'.repeat(72));
  console.log(`  GCP-Projekt : ${PROJECT_ID}`);
  console.log(`  Mandant     : ${TENANT}`);

  if (APPLY && CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }

  const { getIntegrationSecret } = require('../services/integration-store');
  const token = await getIntegrationSecret('SEVDESK_API_TOKEN', { tenantId: TENANT });
  if (!token) throw new Error('Kein SevDesk-Token aufloesbar.');

  const mandant = await sevdeskMandant(token);
  console.log(`  SevDesk     : ${mandant?.benutzer || 'unbekannt'} (Mandant-ID ${mandant?.mandantId || '?'})`);
  console.log('─'.repeat(72));

  const alle = await ladeAlleRechnungen(token);
  console.log(`\n[sevdesk] ${alle.length} Belege geladen.`);

  const kandidaten = [];
  const uebersprungen = { sr: 0, bereitsStorniert: 0, entwurf: 0, ausserhalbZeitraum: 0 };
  for (const inv of alle) {
    const typ = String(inv.invoiceType || '');
    const status = Number(inv.status);
    const datum = String(inv.invoiceDate || '').split('T')[0];
    if (typ === 'SR') { uebersprungen.sr++; continue; }
    if (status === 1000) { uebersprungen.bereitsStorniert++; continue; }
    if (status < 200) { uebersprungen.entwurf++; continue; }
    if ((SINCE && datum && datum < SINCE) || (UNTIL && datum && datum > UNTIL)) { uebersprungen.ausserhalbZeitraum++; continue; }
    kandidaten.push({ id: String(inv.id), nr: inv.invoiceNumber || null, datum, brutto: Number(inv.sumGross) || 0 });
  }

  const summe = kandidaten.reduce((s, k) => s + k.brutto, 0);
  console.log(`\n  Zu stornieren : ${kandidaten.length} offene Rechnungen · ${eur(summe)}`);
  console.log(`  Uebersprungen : ${uebersprungen.sr} Stornobelege, ${uebersprungen.bereitsStorniert} bereits storniert, ${uebersprungen.entwurf} Entwuerfe, ${uebersprungen.ausserhalbZeitraum} ausserhalb Zeitraum`);
  console.log(`\n  Danach: offene Posten 0,00 €. Belege im Mandanten: ${alle.length} → ${alle.length + kandidaten.length}`);
  console.log('  (RE und SR heben sich betragsmaessig auf — wie die 85 Paare vom Juli.)');

  if (kandidaten.length > MAX) throw new Error(`Sicherheits-Abbruch: ${kandidaten.length} > --max ${MAX}.`);

  if (!APPLY) {
    kandidaten.slice(0, 15).forEach((k) => console.log(`    ✂ ${String(k.nr || k.id).padEnd(12)} ${k.datum} ${eur(k.brutto).padStart(12)}`));
    if (kandidaten.length > 15) console.log(`    … und ${kandidaten.length - 15} weitere`);
    console.log('\n  DRY-RUN — nichts storniert.');
    return;
  }

  // Lokalen Spiegel mitziehen, damit die AvyCloud-Rechnungsliste den Beleg
  // nicht mehr als offen zaehlt.
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ projectId: PROJECT_ID });
  const spiegel = new Map();
  const snap = await db.collection('invoices').where('tenantId', '==', TENANT).get();
  for (const d of snap.docs) {
    const sid = String(d.data().sevdeskId || '').trim();
    if (sid) spiegel.set(sid, d.ref);
  }

  console.log('\n[sevdesk] storniere …');
  let ok = 0;
  const fehler = [];
  let i = 0;
  for (const k of kandidaten) {
    i++;
    const res = await storniere(token, k.id);
    if (res.ok) {
      ok++;
      const ref = spiegel.get(k.id);
      if (ref) {
        await ref.update({
          type: 'storniert',
          status: 'storniert',
          cancelledAt: new Date().toISOString(),
          cancellationSevdeskId: res.stornoId ? String(res.stornoId) : null,
          cancelReason: 'b2c_keine_eigenen_rechnungen_2026-08-18',
        }).catch(() => {});
      }
    } else {
      fehler.push({ ...k, http: res.status || null, antwort: res.body || null });
    }
    if (i % 25 === 0 || i === kandidaten.length) {
      console.log(`  ${i}/${kandidaten.length} — storniert ${ok}, Fehler ${fehler.length}`);
    }
    await schlaf(300); // SevDesk-Ratenbegrenzung schonen
  }

  const fs = require('fs');
  const pfad = `/tmp/storno-invoices-${Date.now()}.json`;
  fs.writeFileSync(pfad, JSON.stringify({ ok, fehler, kandidaten: kandidaten.length }, null, 2));

  console.log('\n' + '═'.repeat(72));
  console.log(`  ${ok} storniert, ${fehler.length} Fehler.`);
  fehler.slice(0, 15).forEach((f) => console.log(`    ✖ ${String(f.nr || f.id).padEnd(12)} HTTP ${f.http} — ${String(f.antwort || '').slice(0, 90)}`));
  console.log(`  Bericht: ${pfad}`);
  console.log('═'.repeat(72));
}

main().catch((err) => { console.error(`\n[storno-invoices] ABBRUCH: ${err.message}`); process.exit(1); });
