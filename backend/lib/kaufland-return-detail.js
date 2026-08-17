'use strict';

/**
 * Eine Kaufland-Retoure vollständig zusammensetzen.
 *
 * Der Abrufweg ist am 17.08.2026 live gegen das echte Konto ermittelt worden
 * (nicht aus der Dokumentation abgeleitet):
 *
 *   1. GET /returns?storefront=de&…               → Liste, nur 8 Felder
 *   2. GET /returns/{id}?embedded=return_units    → die Positionen
 *   3. GET /order-units/{id_order_unit}           → Beträge + Produkt
 *
 * Entscheidend: `embedded` wirkt NUR in der Detailansicht. In der Liste ist der
 * Parameter wirkungslos — jede der zwölf geprüften Varianten lieferte kein
 * einziges zusätzliches Feld.
 *
 * Gemessen über alle 13 Retouren: 15 Positionen, **zwei Retouren haben mehr als
 * eine**. Der bisherige Code las nur `return_units[0]` und verlor damit deren
 * Beträge.
 *
 * ERSTATTUNGSBETRAG: Kaufland gibt ihn über diese Schnittstelle NICHT heraus.
 * Es gibt kein Feld `refund_amount` — weder in der Liste noch im Detail noch
 * bei den Positionen; `embedded=refund`/`refunds` liefern nichts. Die beste
 * belegbare Größe ist `order_unit.price` = **Käuferbrutto in Cent**, also der
 * Betrag, den der Käufer bezahlt hat und bei Vollerstattung zurückbekommt. Er
 * passt zum Bruttoumsatz, gegen den er verrechnet wird.
 *
 * Zum Vergleich, gemessen über alle 15 Positionen:
 *   price          1.006,28 €   (Käuferbrutto — genutzt)
 *   revenue_gross    845,58 €   (nach Kaufland-Provision)
 *   revenue_net      710,58 €   (zusätzlich ohne Steuer)
 *
 * Jede Retoure trägt deshalb `amountBasis`, damit im Bericht sichtbar bleibt,
 * dass es sich um eine Näherung handelt und nicht um einen bestätigten Geldfluss.
 */

/** Retouren-Status, bei denen die Ware noch NICHT beim Händler ist. */
const WARE_NOCH_UNTERWEGS = new Set(['label_generated', 'package_sent', 'need_to_be_returned']);

function centsZuEuro(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

/**
 * Setzt Retoure + Positionen + Bestellpositionen zu einem Datensatz zusammen.
 *
 * @param {object} retoure       Antwort von GET /returns/{id}?embedded=return_units
 * @param {Map<string,object>} bestellpositionen  id_order_unit → GET /order-units/{id}
 * @returns {{
 *   refundAmount: number, amountBasis: string, currency: string,
 *   positionen: Array<object>, positionCount: number,
 *   reasons: string[], skus: string[],
 *   warePendent: boolean, receivedAt: string|null,
 *   revenueGross: number, revenueNet: number
 * }}
 */
function buildKauflandReturnDetail(retoure, bestellpositionen, erstattungsBuchungen = null) {
  const units = Array.isArray(retoure?.return_units) ? retoure.return_units : [];
  const map = bestellpositionen instanceof Map ? bestellpositionen : new Map();

  let refundAmount = 0;
  let echterBetrag = 0;      // aus dem Buchungsbericht, wenn vorhanden
  let echteTreffer = 0;
  let revenueGross = 0;
  let revenueNet = 0;
  const positionen = [];
  const reasons = [];
  const skus = [];
  let currency = 'EUR';

  for (const u of units) {
    const orderUnitId = safeString(u?.id_order_unit);
    const ou = orderUnitId ? map.get(orderUnitId) || map.get(Number(orderUnitId)) : null;

    const preis = centsZuEuro(ou?.price);
    refundAmount += preis;

    // Gibt es zu dieser Bestellposition eine ECHTE Erstattungsbuchung, gewinnt
    // sie gegen die Naeherung — sie ist gemessenes Geld statt Bestellpreis.
    if (erstattungsBuchungen && orderUnitId) {
      const echt = erstattungsBuchungen.get(orderUnitId) ?? erstattungsBuchungen.get(Number(orderUnitId));
      if (typeof echt === 'number' && echt > 0) {
        echterBetrag += echt;
        echteTreffer += 1;
      }
    }
    revenueGross += centsZuEuro(ou?.revenue_gross);
    revenueNet += centsZuEuro(ou?.revenue_net);
    if (ou?.currency) currency = safeString(ou.currency) || currency;

    const grund = safeString(u?.reason);
    if (grund && !reasons.includes(grund)) reasons.push(grund);
    const sku = safeString(ou?.id_offer);
    if (sku && !skus.includes(sku)) skus.push(sku);

    positionen.push({
      returnUnitId: safeString(u?.id_return_unit) || null,
      orderUnitId: orderUnitId || null,
      status: safeString(u?.status) || null,
      reason: grund || null,
      note: safeString(u?.note) || null,
      sku: sku || null,
      title: safeString(ou?.product?.title) || null,
      ean: Array.isArray(ou?.product?.eans) ? ou.product.eans[0] || null : null,
      priceGross: preis,
      revenueGross: centsZuEuro(ou?.revenue_gross),
      revenueNet: centsZuEuro(ou?.revenue_net),
      vat: Number(ou?.vat) || null,
    });
  }

  const status = safeString(retoure?.status);
  // "Ware noch unterwegs": zaehlt weiter mit, wird aber getrennt ausgewiesen —
  // gemessen 6 Retouren ueber 366,09 €, die abgezogen werden, obwohl nichts da ist.
  const warePendent = WARE_NOCH_UNTERWEGS.has(status)
    || units.some((u) => WARE_NOCH_UNTERWEGS.has(safeString(u?.status)));

  // Erstattungsdatum gibt Kaufland nicht heraus. Naeherung: der Zeitpunkt, an
  // dem die Retoure zuletzt geaendert wurde, sobald das Paket angekommen ist —
  // dann loest Kaufland die Erstattung automatisch aus.
  const receivedAt = status === 'package_received' ? safeString(retoure?.ts_updated_iso) || null : null;

  // Nur wenn JEDE Position eine echte Buchung hat, ist die Summe belastbar.
  // Sonst mischte sich gemessenes Geld mit geschaetztem — schlimmer als eine
  // durchgaengige Naeherung, weil niemand mehr wuesste, was die Zahl ist.
  const alleEchtBelegt = positionen.length > 0 && echteTreffer === positionen.length;

  return {
    refundAmount: alleEchtBelegt
      ? Math.round(echterBetrag * 100) / 100
      : Math.round(refundAmount * 100) / 100,
    amountBasis: alleEchtBelegt ? 'kaufland_booking_refund' : 'kaufland_order_unit_price',
    refundBookingCount: echteTreffer,
    currency,
    positionen,
    positionCount: positionen.length,
    reasons,
    skus,
    warePendent,
    receivedAt,
    revenueGross: Math.round(revenueGross * 100) / 100,
    revenueNet: Math.round(revenueNet * 100) / 100,
  };
}

module.exports = { buildKauflandReturnDetail, WARE_NOCH_UNTERWEGS, centsZuEuro };
