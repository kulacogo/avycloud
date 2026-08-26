'use strict';

/**
 * order-financials.js — Der AKTUELLE Betrag eines Auftrags.
 *
 * Betreiber-Anweisung 2026-08-18 (woertlich): "die rechnungen in avycloud
 * muessen wenn sie erstellt werden entsprechend der marktplatz transaktionen
 * erstellt werden, sowas wie eine teilrueckerstattung darf idf nicht fehlen!
 * ... dabei muss der aktuelle betrag dann auch von avycloud festgehalten
 * werden ... gerade was die brutto umsaetze, retouren oder stornos oder
 * teilrueckerstattungen betrifft!"
 *
 * ANLASS (Kaufland M63HGK5): 499 € verkauft, 10 % Teilerstattung. Die Rechnung
 * wies 499 € aus. Schuld war NICHT die Rechnung — generateInvoice rechnet aus
 * order.items + shippingCost, und auf dem Auftrag stand von der Erstattung
 * kein Wort. syncRefunds erkannte sie im Kaufland-Buchungsbericht
 * ("Erstattung Bestell-Nr. M63HGK5", -49,90 €), legte aber nur eine
 * Glocken-Meldung an und schrieb nichts auf orders/{id}.
 * Gemessen 01.05.–30.09.2026: 4 Bestellungen, 95,83 €, KEINE bekannt.
 *
 * WARUM EIN KORREKTURWEG PFLICHT IST: die Erstattungsbuchung kommt Tage bis
 * Wochen NACH der Bestellung (M63HGK5: bestellt 21.08., gebucht 26.08.). Die
 * Rechnung entsteht beim Versand und kann die Erstattung zum Erstellzeitpunkt
 * gar nicht kennen. "Rechnung richtig erstellen" allein loest das Problem
 * also grundsaetzlich nicht.
 *
 * Diese Datei ist REIN — kein Firestore, kein Netz, voll testbar.
 */

/** Cent-genau runden. Ohne das summieren sich Gleitkomma-Reste sichtbar auf. */
function cent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Nimmt eine Erstattung in die Liste auf — genau einmal.
 *
 * IDEMPOTENZ IST HIER KEIN LUXUS: der Buchungsbericht wird regelmaessig neu
 * gelesen und liefert dieselbe Zeile wieder. Ohne den refundId-Abgleich waechst
 * der erstattete Betrag bei jedem Lauf, und der Umsatz sinkt gegen null.
 *
 * @param {Array<object>} vorhandene Bisherige Erstattungen des Auftrags.
 * @param {{refundId: string, marketplace?: string, amount: number, date?: string, source?: string}} neue
 * @returns {{refunds: Array<object>, changed: boolean}}
 */
function mergeRefund(vorhandene, neue) {
  const liste = Array.isArray(vorhandene) ? vorhandene.slice() : [];
  if (!neue || typeof neue !== 'object') return { refunds: liste, changed: false };

  const id = String(neue.refundId || '').trim();
  const betrag = cent(neue.amount);
  // Muell wird verworfen, nicht gebucht: ohne Schluessel gibt es keine
  // Idempotenz, und ein Betrag <= 0 ist keine Erstattung.
  if (!id || !(betrag > 0)) return { refunds: liste, changed: false };

  if (liste.some((r) => String(r?.refundId || '') === id)) {
    return { refunds: liste, changed: false };
  }

  liste.push({
    refundId: id,
    marketplace: neue.marketplace || null,
    amount: betrag,
    date: neue.date || null,
    source: neue.source || null,
    recordedAt: neue.recordedAt || new Date().toISOString(),
  });
  return { refunds: liste, changed: true };
}

/**
 * Der aktuelle Stand eines Auftrags: was wurde verkauft, was zurueckgegeben,
 * was bleibt.
 *
 * @param {{totalAmount?: number, refunds?: Array<object>, cancelled?: boolean}} opts
 * @returns {{grossAmount: number, refundedTotal: number, netAmount: number, overRefunded: boolean, cancelled: boolean}}
 */
function computeOrderFinancials({ totalAmount = 0, refunds = [], cancelled = false } = {}) {
  const brutto = cent(totalAmount);
  const erstattet = cent((Array.isArray(refunds) ? refunds : [])
    .reduce((s, r) => s + (Number(r?.amount) || 0), 0));

  // Ein stornierter Auftrag hat KEINEN Umsatz — unabhaengig davon, wie viel
  // davon als Erstattung gebucht wurde. Die Ware ging nie raus.
  // (Gemessen an MTZXSS5: storniert, 109,95 €, 25,95 € erstattet. Netto ist 0,
  // nicht 84,00 €.)
  if (cancelled) {
    return { grossAmount: brutto, refundedTotal: erstattet, netAmount: 0, overRefunded: erstattet > brutto, cancelled: true };
  }

  // Nie unter null: ein Minus-Umsatz waere in jeder Auswertung falsch. Der
  // Ueberhang wird aber SICHTBAR gemacht statt still gekappt — er ist ein
  // Hinweis auf einen Fehler in den Quelldaten.
  const netto = cent(Math.max(0, brutto - erstattet));
  return { grossAmount: brutto, refundedTotal: erstattet, netAmount: netto, overRefunded: erstattet > brutto, cancelled: false };
}

/**
 * Rechnungspositionen und Betraege — inklusive Erstattung.
 *
 * Die Erstattung wird als EIGENE Minus-Position gefuehrt, nicht als stille
 * Preisminderung an der Artikelzeile. Der Kaeufer muss sehen koennen, warum
 * der Rechnungsbetrag von seinem Kaufpreis abweicht.
 *
 * Die Umsatzsteuer wird vom GEMINDERTEN Betrag gerechnet — sonst fuehrt die
 * Rechnung mehr USt aus, als tatsaechlich eingenommen wurde.
 *
 * @param {{items?: Array<object>, shippingCost?: number, vatRate?: number, refunds?: Array<object>}} opts
 */
function computeInvoiceAmounts({ items = [], shippingCost = 0, vatRate = 0.19, refunds = [], fallbackTotal = 0, fallbackName = 'Bestellung' } = {}) {
  const artikel = Array.isArray(items) ? items : [];
  const versand = cent(shippingCost);
  const itemsBrutto = cent(artikel.reduce((s, i) => s + (Number(i?.priceBrutto) || 0) * (Number(i?.quantity) || 1), 0));

  const lines = artikel.slice();
  if (versand > 0 && itemsBrutto > 0) {
    lines.push({ name: 'Versandkosten', priceBrutto: versand, quantity: 1 });
  }

  // Auftrag ohne Positionen: auf den Gesamtbetrag zurueckfallen und EINE
  // Sammelzeile bilden. Ohne diesen Zweig kaeme eine 0-€-Rechnung heraus —
  // genau die Klasse Fehler, gegen die generateInvoice seinen Betrags-Guard
  // hat (siehe die 47 "eBay Kaeufer / 0,00 €"-Belege).
  let vorErstattung = cent(itemsBrutto + (itemsBrutto > 0 ? versand : 0));
  if (itemsBrutto <= 0 && cent(fallbackTotal) > 0) {
    vorErstattung = cent(fallbackTotal);
    lines.push({ name: fallbackName, priceBrutto: vorErstattung, quantity: 1 });
  }
  const erstattet = cent((Array.isArray(refunds) ? refunds : [])
    .reduce((s, r) => s + (Number(r?.amount) || 0), 0));

  if (erstattet > 0) {
    lines.push({
      name: 'Teilerstattung Marktplatz',
      priceBrutto: -Math.min(erstattet, vorErstattung),
      quantity: 1,
      isRefund: true,
    });
  }

  const totalBrutto = cent(Math.max(0, vorErstattung - erstattet));
  const totalNetto = cent(totalBrutto / (1 + (Number(vatRate) || 0)));
  // Bewusst als Differenz und nicht eigenstaendig gerechnet: so ergeben
  // Netto + USt IMMER exakt den Bruttobetrag, ohne Ein-Cent-Abweichung.
  const vatAmount = cent(totalBrutto - totalNetto);

  return {
    lines,
    itemsBrutto,
    shippingCost: versand,
    refundedTotal: erstattet,
    totalBrutto,
    totalNetto,
    vatAmount,
    overRefunded: erstattet > vorErstattung,
  };
}

module.exports = { mergeRefund, computeOrderFinancials, computeInvoiceAmounts, cent };
