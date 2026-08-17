'use strict';

/**
 * auto-invoice-gate.js — EIN Schalter fuer JEDE automatische Erzeugung von
 * Rechnungen, Gutschriften und Stornorechnungen.
 *
 * Betreiber-Anweisung 2026-08-17 (woertlich): "avycloud muss aufhoeren
 * rechnungen automatisch zu erstellen. ... als B2C haendler muss trendocean
 * keine rechnungen ausstellen. rechnungen sollen aber trotzdem erstellt werden
 * koennen in sevdesk ueber avycloud, bestellungen muessen diese option bereit
 * halten (button fuer rechnung) fuer den fall das kaeufer eine rechnung haben
 * wollen. ... rechnungen, gutschriften, retoure, stornos etc werden ueber die
 * marktplaetze bereits kalkuliert in den marktplatz reports!"
 *
 * WARUM EIN SCHALTER STATT LOESCHEN: der Weg bleibt vollstaendig im Code — ein
 * Betreiber mit B2B-Anteil braucht ihn. Abgeschaltet ist er nur fuer diesen
 * Mandanten.
 *
 * WARUM NUR DER EXAKTE WERT 'on': dieselbe Haerte wie beim
 * Marktplatz-Erstattungs-Push (siehe returns-engine.js
 * marketplaceRefundPushEnabled). 'true'/'1'/'yes' schalten bewusst NICHT ein.
 * Eine Rechnung ist ein steuerrelevantes Dokument mit fortlaufender Nummer aus
 * SevDesk — ein Tippfehler in der Konfiguration darf hier keine 400 Belege
 * praegen. Gemessen am Bestand vor dem Abschalten: 467 faellige Rechnungen
 * ueber 18.158,48 EUR, die die gesamte Auswertung verfaelschten (EBIT-Kachel,
 * offene Posten, UStVA).
 *
 * WAS DER SCHALTER NICHT BERUEHRT (bleibt IMMER erreichbar):
 *   - POST /api/orders/:orderId/invoice        (Knopf "Rechnung erstellen")
 *   - POST /api/invoices/:invoiceId/export-sevdesk
 *   - POST /api/orders/:orderId/delivery-note  (Lieferschein, keine Rechnung)
 *   - importFromSevDesk()                      (liest nur, praegt nichts)
 * Ein Mensch, der auf einen Knopf drueckt, ist genau der Fall, den der
 * Betreiber ausdruecklich erhalten wissen will.
 */

/**
 * Ist die automatische Rechnungserzeugung eingeschaltet?
 * @returns {boolean} true NUR beim exakten Wert 'on' (Gross-/Kleinschreibung
 *   und Leerzeichen werden verziehen).
 */
function autoInvoiceEnabled() {
  return String(process.env.AUTO_INVOICE || '').trim().toLowerCase() === 'on';
}

/**
 * Einheitliche Antwort fuer uebersprungene Laeufe. Kein Fehler — das ist der
 * NORMALFALL. Aufrufer koennen `skipped` auswerten, ohne den Grund zu raten.
 * @returns {{ skipped: true, reason: 'auto_invoice_disabled' }}
 */
function autoInvoiceSkipResult() {
  return { skipped: true, reason: 'auto_invoice_disabled' };
}

/**
 * Darf ueberhaupt IRGENDEINE Rechnung nach SevDesk geschrieben werden?
 *
 * Betreiber-Anweisung 2026-08-17 (woertlich): "rechnungen werden nur noch
 * ueber die bestellung manuell erstellt wenn kunde rechnung fordert,
 * rechnung nur in avycloud nicht in sevdesk."
 *
 * DAS IST EINE ANDERE FRAGE ALS `autoInvoiceEnabled()` und deshalb ein
 * eigener Schalter:
 *   - `AUTO_INVOICE`         = darf AvyCloud von SELBST eine Rechnung anlegen?
 *   - `INVOICE_SEVDESK_PUSH` = darf eine Rechnung — egal wer sie ausloest —
 *                              in SevDesk landen?
 * Der Knopf im Auftrag bleibt offen (erste Frage: ja, ein Mensch loest aus),
 * schreibt aber nur noch lokal (zweite Frage: nein).
 *
 * WARUM DAS WICHTIG IST — die Rechnung darf die Buchhaltung nicht doppelt
 * fuellen: zahlt der Marktplatz 2.000 € aus und stehen daneben Rechnungen
 * ueber 2.000 €, die als bezahlt markiert werden, weist SevDesk 4.000 €
 * Umsatz aus. Die Marktplatz-Transaktionsberichte halten jeden Vorgang
 * bereits fest; die AvyCloud-Rechnung ist nur noch ein BELEG FUER DEN KUNDEN.
 *
 * Ohne SevDesk kommt die Nummer aus dem lokalen Nummernkreis
 * (`services/number-sequence.js`, Typ 'invoice' → `RE-<Jahr>-<0001>`). Der
 * kollidiert nicht mit den SevDesk-Nummern (`RE-1636`, ohne Jahresteil).
 *
 * @returns {boolean} true NUR beim exakten Wert 'on'.
 */
function invoiceSevdeskPushEnabled() {
  return String(process.env.INVOICE_SEVDESK_PUSH || '').trim().toLowerCase() === 'on';
}

module.exports = { autoInvoiceEnabled, autoInvoiceSkipResult, invoiceSevdeskPushEnabled };
