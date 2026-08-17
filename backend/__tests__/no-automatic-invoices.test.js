'use strict';

/**
 * AvyCloud darf KEINE Rechnungen mehr von selbst erstellen.
 *
 * Betreiber-Anweisung 2026-08-17 (woertlich): "avycloud muss aufhoeren
 * rechnungen automatisch zu erstellen. ... als B2C haendler muss trendocean
 * keine rechnungen ausstellen. rechnungen sollen aber trotzdem erstellt werden
 * koennen in sevdesk ueber avycloud, bestellungen muessen diese option bereit
 * halten (button fuer rechnung) ... rechnungen, gutschriften, retoure, stornos
 * etc werden ueber die marktplaetze bereits kalkuliert in den marktplatz
 * reports!"
 *
 * Vorher gab es SECHS voneinander unabhaengige Automatik-Wege:
 *   1. index.js  invoice-sync-Cron → bulkGenerateForShippedOrders
 *      (fuenf Auftragsstatus, KEINE Datumsgrenze, 5 min nach jedem Start +
 *       alle 24 h → jeder Cloud-Run-Neustart war ein Volldurchlauf)
 *   2. index.js  refund-sync-Cron  → Gutschriften
 *   3. order-state-machine.js      → generateInvoice bei Uebergang 'shipped'
 *   4. routes/orders.js  complete  → generateInvoice beim Picken
 *   5. routes/orders.js  transition→'picked'
 *   6. routes/orders.js  transition→'cancelled' → Stornorechnung
 *   (+ returns-engine.js → Storno/Gutschrift bei Retoure)
 *
 * Ergebnis im Bestand: 467 faellige Rechnungen ueber 18.158,48 EUR, die die
 * gesamte Auswertung verfaelschten.
 *
 * Ein Gate INNERHALB von generateInvoice haette nicht gereicht: der
 * Idempotenz-Claim schreibt invoiceClaimedAt aufs Auftragsdokument, bevor
 * irgendetwas geprueft wird. Das Gate muss VOR dem Aufruf sitzen — deshalb
 * prueft dieser Test jeden Ausloeser einzeln.
 */

const fs = require('fs');
const path = require('path');

function lies(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function ladeGate() {
  const p = require.resolve('../lib/auto-invoice-gate');
  delete require.cache[p];
  return require('../lib/auto-invoice-gate');
}

/**
 * Steht `gate` im Quelltext VOR `aufruf`, und zwar nah genug, dass es
 * denselben Block betrifft? Naehe statt Reihenfolge allein — sonst wuerde ein
 * Gate am Dateianfang jeden spaeteren ungeschuetzten Aufruf decken.
 */
function istGegatet(quelle, marker, aufruf, fenster = 1500) {
  const i = quelle.indexOf(marker);
  if (i === -1) return { ok: false, grund: `Marker nicht gefunden: ${marker}` };
  const j = quelle.indexOf(aufruf, i);
  if (j === -1) return { ok: false, grund: `Aufruf nicht gefunden nach Marker: ${aufruf}` };
  const davor = quelle.slice(Math.max(0, j - fenster), j);
  return { ok: /autoInvoiceEnabled/.test(davor), grund: 'kein autoInvoiceEnabled im Umfeld' };
}

describe('Der Schalter selbst', () => {
  const alt = process.env.AUTO_INVOICE;
  afterEach(() => {
    if (alt === undefined) delete process.env.AUTO_INVOICE;
    else process.env.AUTO_INVOICE = alt;
  });

  it('ist ohne Konfiguration AUS — Standard ist "keine Rechnung"', () => {
    delete process.env.AUTO_INVOICE;
    expect(ladeGate().autoInvoiceEnabled()).toBe(false);
  });

  it('bleibt bei jedem anderen Wert als "on" AUS', () => {
    // 'true'/'1'/'yes' schalten BEWUSST nicht ein: eine Rechnung ist ein
    // steuerrelevantes Dokument mit fortlaufender SevDesk-Nummer. Ein
    // Tippfehler in der Konfiguration darf hier keine 400 Belege praegen.
    for (const wert of ['', 'off', 'false', '0', 'nein', 'true', '1', 'yes', 'ON.', 'onn']) {
      process.env.AUTO_INVOICE = wert;
      expect(ladeGate().autoInvoiceEnabled()).toBe(false);
    }
  });

  it('laesst sich nur mit dem ausdruecklichen Wert "on" einschalten', () => {
    for (const wert of ['on', 'ON', ' on ', 'On']) {
      process.env.AUTO_INVOICE = wert;
      expect(ladeGate().autoInvoiceEnabled()).toBe(true);
    }
  });
});

describe('Der Massen-Praeger laeuft ohne Schalter gar nicht erst', () => {
  const alt = process.env.AUTO_INVOICE;
  afterEach(() => {
    if (alt === undefined) delete process.env.AUTO_INVOICE;
    else process.env.AUTO_INVOICE = alt;
  });

  it('bulkGenerateForShippedOrders meldet sich als uebersprungen, ohne Firestore anzufassen', async () => {
    delete process.env.AUTO_INVOICE;
    const { bulkGenerateForShippedOrders } = require('../services/invoice-engine');
    const res = await bulkGenerateForShippedOrders({ tenantId: 'default' });
    expect(res.generated).toBe(0);
    expect(res.reason).toBe('auto_invoice_disabled');
    expect(res.errors).toEqual([]);
  });

  it('das Gate sitzt zusaetzlich in der Funktion, nicht nur beim Aufrufer', () => {
    // Ein Massen-Praeger darf nicht an genau einer Stelle haengen.
    const quelle = lies('services/invoice-engine.js');
    const i = quelle.indexOf('async function bulkGenerateForShippedOrders');
    expect(i).toBeGreaterThan(-1);
    expect(quelle.slice(i, i + 600)).toMatch(/autoInvoiceEnabled/);
  });
});

describe('Jeder automatische Ausloeser ist gegatet', () => {
  it('order-state-machine: Uebergang auf "shipped" praegt keine Rechnung', () => {
    const quelle = lies('services/order-state-machine.js');
    const r = istGegatet(quelle, "toStatus === 'shipped'", 'generateInvoice({ orderId, tenantId, actor })');
    expect(r.ok, r.grund).toBe(true);
  });

  it('routes/orders.js: Fertigmelden (complete) praegt keine Rechnung', () => {
    const quelle = lies('routes/orders.js');
    const r = istGegatet(quelle, '// Auto-generate invoice + SevDesk export on pick', 'generateInvoice({ orderId,');
    expect(r.ok, r.grund).toBe(true);
  });

  it('routes/orders.js: Uebergang auf "picked" praegt keine Rechnung', () => {
    const quelle = lies('routes/orders.js');
    const r = istGegatet(quelle, '// Auto-generate invoice + SevDesk export when order is picked', 'generateInvoice({ orderId,');
    expect(r.ok, r.grund).toBe(true);
  });

  it('routes/orders.js: Stornieren praegt keine Stornorechnung', () => {
    const quelle = lies('routes/orders.js');
    const r = istGegatet(quelle, '// Auto-create Stornorechnung', 'createCorrectionInvoice({');
    expect(r.ok, r.grund).toBe(true);
  });

  it('returns-engine: Retoure praegt keine Gutschrift/Storno', () => {
    const quelle = lies('services/returns-engine.js');
    const r = istGegatet(quelle, '// Create Storno / Gutschrift in SevDesk', 'createCorrectionInvoice({');
    expect(r.ok, r.grund).toBe(true);
  });

  it('index.js: der Gutschrift-Cron (refund-sync) wird gar nicht erst gestartet', () => {
    const quelle = lies('index.js');
    const i = quelle.indexOf('const runRefundSync = async () =>');
    expect(i).toBeGreaterThan(-1);
    expect(quelle.slice(Math.max(0, i - 1200), i)).toMatch(/autoInvoiceEnabled\s*\(\s*\)/);
  });

  it('index.js: der invoice-sync-Cron importiert weiter, praegt aber nichts', () => {
    const quelle = lies('index.js');
    const i = quelle.indexOf('const runInvoiceSync = async () =>');
    expect(i).toBeGreaterThan(-1);
    const block = quelle.slice(i, i + 1400);
    // Import bleibt (liest nur, praegt nichts) …
    expect(block).toMatch(/importFromSevDesk\(/);
    // … der Massen-Praeger steht hinter dem Schalter.
    const j = block.indexOf('bulkGenerateForShippedOrders({');
    expect(j).toBeGreaterThan(-1);
    expect(block.slice(0, j)).toMatch(/autoInvoiceEnabled\(\)/);
  });

  it('routes/invoices.js: der Massen-Endpunkt lehnt ohne Schalter ab', () => {
    const quelle = lies('routes/invoices.js');
    const r = istGegatet(quelle, "'/invoices/bulk-generate'", 'generateInvoice({ orderId: order.id', 2500);
    expect(r.ok, r.grund).toBe(true);
    expect(quelle).toMatch(/AUTO_INVOICE_DISABLED/);
  });
});

describe('Der Aufraeum-Lauf darf sich nicht selbst rueckgaengig machen', () => {
  it('importFromSevDesk haengt Belege ohne Schalter an KEINEN Auftrag', () => {
    // Die Zuordnung ist eine Raterunde: erstbester Auftrag ohne Rechnung, der
    // betragsmaessig auf 1 EUR passt — und sie schreibt invoiceId/
    // invoiceNumber auf diesen Auftrag zurueck. Der Cron laeuft 5 Minuten nach
    // JEDEM Neustart. Nach dem Aufraeumen haette er die nicht loeschbaren
    // Restbelege an willkuerliche Auftraege gehaengt.
    const quelle = lies('services/invoice-engine.js');
    const i = quelle.indexOf('// Match to order by gross amount');
    expect(i).toBeGreaterThan(-1);
    const block = quelle.slice(i, i + 1600);
    expect(block).toMatch(/autoInvoiceEnabled\(\)/);
    expect(block).toMatch(/grossAmount > 0 && autoInvoiceEnabled\(\)/);
  });

  it('der Import selbst laeuft weiter — er spiegelt nur, er praegt nichts', () => {
    const quelle = lies('services/invoice-engine.js');
    const i = quelle.indexOf('async function importFromSevDesk');
    expect(i).toBeGreaterThan(-1);
    // Kein Frueh-Ausstieg am Funktionsanfang: die Liste bleibt ehrlich.
    expect(quelle.slice(i, i + 700)).not.toMatch(/if\s*\(\s*!autoInvoiceEnabled/);
  });

  it('das Aufraeum-Script kennt die Tote-ID-Falle und blockt --sevdesk-only', () => {
    // In SevDesk loeschen und order.invoiceSevdeskId stehen lassen macht den
    // Auftrag dauerhaft rechnungsunfaehig (invoice-engine.js:285 verwendet die
    // ID wieder, statt neu zu praegen).
    const quelle = lies('scripts/purge-invoices.js');
    expect(quelle).toMatch(/allow-stale-links/);
    expect(quelle).toMatch(/invoiceSevdeskId/);
    expect(quelle).toMatch(/PURGE_INVOICES_V1/);
    // Kein Selbst-Storno: ein Storno erzeugt ein ZUSAETZLICHES Dokument statt
    // eines zu entfernen — das Gegenteil des Ziels. Das Wort darf im
    // Kopfkommentar stehen (dort wird genau das erklaert), aber es darf keine
    // Adresse gebaut werden, die darauf zeigt.
    expect(quelle).not.toMatch(/\/cancelInvoice[`'"]/);
  });

  it('das Aufraeum-Script laeuft ohne --apply garantiert trocken', () => {
    const quelle = lies('scripts/purge-invoices.js');
    expect(quelle).toMatch(/const APPLY = flag\('apply'\)/);
    expect(quelle).toMatch(/CONFIRM !== CONFIRM_TOKEN/);
  });

  it('lokal wird nur geloest, was in SevDesk wirklich weg ist', () => {
    // Der schwerste Defekt der ersten Fassung: die Firestore-Haelfte nullte
    // invoiceSevdeskId an ALLEN Auftraegen — auch an denen, deren Beleg
    // SevDesk nicht loeschen liess. Damit faellt der Praegeschutz weg UND der
    // Knopf "Rechnung erstellen" erscheint wieder (er haengt an
    // !order.invoiceNumber): ein Klick praegt neben der noch lebenden alten
    // eine ZWEITE echte, fortlaufend nummerierte Rechnung.
    const quelle = lies('scripts/purge-invoices.js');
    expect(quelle).toMatch(/lebendeIds/);
    // Datensatz faellt nur ohne lebenden Beleg …
    expect(quelle).toMatch(/!sid \|\| !lebendeIds\.has\(sid\)/);
    // … und der Auftrag ebenso.
    expect(quelle).toMatch(/if \(sid\) return !lebendeIds\.has\(sid\)/);
    // Die SevDesk-Liste wird IMMER geladen, sonst ist die Frage nicht
    // beantwortbar — auch bei --firestore-only.
    expect(quelle).not.toMatch(/if \(!FIRESTORE_ONLY\) \{\s*\n\s*const \{ getIntegrationSecret \}/);
  });

  it('der Standardumfang ist ALLES — inklusive Stornos und bezahlter Belege', () => {
    // Betreiber-Anweisung 2026-08-17: "rechnungen in sevdesk inkl. stornos
    // restlos entfernen wenn moeglich - das gesamte bild der buchhaltung wird
    // durch diese rechnungen und stornos verfaelscht".
    const quelle = lies('scripts/purge-invoices.js');
    expect(quelle).toMatch(/KEEP_STORNO = flag\('keep-storno'\)/);
    expect(quelle).toMatch(/KEEP_PAID = flag\('keep-paid'\)/);
    // Verschont wird nur auf ausdruecklichen Wunsch, nicht als Standard.
    expect(quelle).toMatch(/typ === 'SR' && KEEP_STORNO/);
    expect(quelle).toMatch(/status >= 750 && KEEP_PAID/);
  });

  it('Stornorechnungen fallen VOR ihren Originalen', () => {
    // Eine SR verweist auf ihre RE. Loescht man die RE zuerst, kann SevDesk
    // verweigern oder die SR bleibt als Beleg ohne Bezug stehen.
    const quelle = lies('scripts/purge-invoices.js');
    expect(quelle).toMatch(/kandidaten\.sort/);
    expect(quelle).toMatch(/a\.typ === 'SR' \? -1 : 1/);
  });
});

describe('Die Rechnung bleibt in AvyCloud und geht NICHT nach SevDesk', () => {
  const alt = process.env.INVOICE_SEVDESK_PUSH;
  afterEach(() => {
    if (alt === undefined) delete process.env.INVOICE_SEVDESK_PUSH;
    else process.env.INVOICE_SEVDESK_PUSH = alt;
  });

  it('ist ohne Konfiguration AUS und nur mit "on" einschaltbar', () => {
    delete process.env.INVOICE_SEVDESK_PUSH;
    expect(ladeGate().invoiceSevdeskPushEnabled()).toBe(false);
    for (const wert of ['', 'off', 'true', '1', 'yes', 'ja']) {
      process.env.INVOICE_SEVDESK_PUSH = wert;
      expect(ladeGate().invoiceSevdeskPushEnabled()).toBe(false);
    }
    process.env.INVOICE_SEVDESK_PUSH = 'on';
    expect(ladeGate().invoiceSevdeskPushEnabled()).toBe(true);
  });

  it('ist ein EIGENER Schalter, nicht derselbe wie AUTO_INVOICE', () => {
    // Zwei verschiedene Fragen: (a) darf AvyCloud von selbst eine Rechnung
    // anlegen? (b) darf eine Rechnung ueberhaupt nach SevDesk? Der Knopf im
    // Auftrag beantwortet (a) mit ja und (b) mit nein.
    const g = ladeGate();
    expect(typeof g.autoInvoiceEnabled).toBe('function');
    expect(typeof g.invoiceSevdeskPushEnabled).toBe('function');
    const quelle = lies('lib/auto-invoice-gate.js');
    expect(quelle).toMatch(/AUTO_INVOICE/);
    expect(quelle).toMatch(/INVOICE_SEVDESK_PUSH/);
  });

  it('generateInvoice zieht die Nummer aus dem lokalen Nummernkreis', () => {
    // Ohne SevDesk gibt es keine fremde Nummernquelle mehr. number-sequence
    // Typ 'invoice' liefert atomar `RE-<Jahr>-<0001>` — kollidiert nicht mit
    // den SevDesk-Nummern (`RE-1636`, ohne Jahresteil).
    const quelle = lies('services/invoice-engine.js');
    const i = quelle.indexOf('async function generateInvoice');
    expect(i).toBeGreaterThan(-1);
    const block = quelle.slice(i, quelle.indexOf('async function generateDeliveryNote'));
    expect(block).toMatch(/invoiceSevdeskPushEnabled/);
    expect(block).toMatch(/getNextNumber\(\{ tenantId, type: 'invoice' \}\)/);
    // Der SevDesk-Praegeblock haengt am Schalter, nicht mehr nur am Token.
    expect(block).toMatch(/if \(nachSevdesk && token\)/);
  });

  it('kein Weg schreibt ohne Schalter nach SevDesk', () => {
    const quelle = lies('services/invoice-engine.js');
    for (const fn of ['async function exportToSevDesk', 'async function createCorrectionInvoice']) {
      const i = quelle.indexOf(fn);
      expect(i, fn).toBeGreaterThan(-1);
      // Vor dem ersten Netz-Aufruf muss der Schalter geprueft sein.
      const bisFetch = quelle.slice(i, quelle.indexOf('my.sevdesk.de', i));
      expect(bisFetch, fn).toMatch(/invoiceSevdeskPushEnabled/);
    }
  });
});

describe('Der Weg fuer Kaeufer, die eine Rechnung wollen, bleibt offen', () => {
  it('POST /api/orders/:orderId/invoice ist NICHT gegatet', () => {
    // Der Knopf "Rechnung erstellen" im Auftrag ist ausdruecklich gewuenscht.
    // Ein spaeterer Umbau darf ihn nicht "mit aufraeumen".
    const quelle = lies('routes/orders.js');
    const i = quelle.indexOf("router.post('/orders/:orderId/invoice'");
    expect(i).toBeGreaterThan(-1);
    const handler = quelle.slice(i, i + 1400);
    expect(handler).toMatch(/generateInvoice\(\{/);
    expect(handler).not.toMatch(/autoInvoiceEnabled/);
  });

  it('POST /api/invoices/:invoiceId/export-sevdesk ist NICHT gegatet', () => {
    const quelle = lies('routes/orders.js');
    const i = quelle.indexOf("router.post('/invoices/:invoiceId/export-sevdesk'");
    expect(i).toBeGreaterThan(-1);
    expect(quelle.slice(i, i + 900)).not.toMatch(/autoInvoiceEnabled/);
  });

  it('der Lieferschein ist keine Rechnung und bleibt unberuehrt', () => {
    const quelle = lies('routes/orders.js');
    const i = quelle.indexOf("router.post('/orders/:orderId/delivery-note'");
    expect(i).toBeGreaterThan(-1);
    expect(quelle.slice(i, i + 800)).not.toMatch(/autoInvoiceEnabled/);
  });

  it('der Knopf steht im Auftrag und ruft den Einzel-Endpunkt', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'OrderDetail.tsx'), 'utf8');
    expect(ui).toMatch(/label="Rechnung erstellen"/);
    expect(ui).toMatch(/generateInvoice\(orderId/);
  });
});
