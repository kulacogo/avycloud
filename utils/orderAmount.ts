/**
 * Betraege von Marktplatz-Auftraegen anzeigen — in Euro, mit dem Original daneben.
 *
 * Vorfall M53KUW5 (kaufland.cz, 03.10.2026): der Kaeufer zahlte 534,14 CZK, die
 * Oberflaeche zeigte „534.14 €". Seit dem 05.10.2026 fuehrt der Auftrag
 * `totalAmount`/`priceBrutto` IMMER in Euro (EZB-Kurs des Bestelltages) und das
 * Original additiv (`originalCurrency`, `originalTotalAmount`, `exchangeRate`, …).
 * Diese Helfer sind REIN (kein React) und laufen unter `node --test`.
 */

import type { Order, OrderItem } from "../types";

export type OrderAmountSource = Partial<
  Pick<
    Order,
    | "totalAmount"
    | "currency"
    | "originalCurrency"
    | "originalTotalAmount"
    | "exchangeRate"
    | "exchangeRateDate"
    | "exchangeRateSource"
    | "exchangeRatePending"
  >
>;

export type OrderItemAmountSource = Partial<
  Pick<OrderItem, "priceBrutto" | "currency" | "originalPrice" | "originalCurrency">
>;

export interface OrderAmountView {
  /** Hauptbetrag — Euro, so wie ihn alle Auswertungen fuehren. */
  primary: string;
  /** Originalbetrag in der Marktplatzwaehrung, null bei Euro-Auftraegen. */
  secondary: string | null;
  /** Kurs-Hinweis fuer Tooltip/Detail, null bei Euro-Auftraegen. */
  hint: string | null;
  /** true = mit Notkurs gerechnet oder noch gar nicht umgerechnet. */
  pending: boolean;
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normCurrency(value: string | null | undefined): string {
  return String(value || "EUR").trim().toUpperCase() || "EUR";
}

/** "21.83 €" fuer Euro (wie bisher), "534.14 CZK" fuer Fremdwaehrung, "—" ohne Betrag. */
export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (!isMoney(amount)) return "—";
  const c = normCurrency(currency);
  return c === "EUR" ? `${amount.toFixed(2)} €` : `${amount.toFixed(2)} ${c}`;
}

/** "24,470" — EZB-Quotierung (Fremdwaehrung je 1 EUR), mindestens drei Nachkommastellen. */
export function formatExchangeRate(rate: number | null | undefined): string {
  if (!isMoney(rate)) return "";
  return rate.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}

function formatDateDe(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

export function orderAmountView(order: OrderAmountSource): OrderAmountView {
  const cur = normCurrency(order.currency);
  const original = order.originalCurrency ? normCurrency(order.originalCurrency) : null;
  const primary = formatMoney(order.totalAmount, cur);

  if (!original || (original === "EUR" && cur === "EUR")) {
    return { primary, secondary: null, hint: null, pending: false };
  }

  // Fremdwaehrung, aber (noch) kein Kurs: der Betrag steht ehrlich in CZK/PLN.
  if (cur !== "EUR") {
    return { primary, secondary: null, hint: "Kurs fehlt — noch nicht in Euro umgerechnet", pending: true };
  }

  const secondaryRaw = formatMoney(order.originalTotalAmount, original);
  const rate = formatExchangeRate(order.exchangeRate);
  const date = formatDateDe(order.exchangeRateDate);
  const datePart = date ? ` vom ${date}` : "";
  const pending = order.exchangeRatePending === true || order.exchangeRateSource === "static_fallback";
  const hint = pending
    ? `Noch vorläufig: Notkurs ${rate}${datePart} — wird beim nächsten Abgleich durch den EZB-Kurs ersetzt`
    : `EZB-Kurs ${rate}${datePart}`;

  return { primary, secondary: secondaryRaw === "—" ? null : secondaryRaw, hint, pending };
}

/** Positionssumme (Preis × Menge) in Euro plus Original in der Marktplatzwaehrung. */
export function itemLineAmountView(
  item: OrderItemAmountSource,
  quantity: number,
): { primary: string; secondary: string | null } {
  const qty = Number(quantity) || 0;
  if (!isMoney(item.priceBrutto)) return { primary: "—", secondary: null };
  const cur = normCurrency(item.currency);
  const primary = formatMoney(round2(item.priceBrutto * qty), cur);
  const original = item.originalCurrency ? normCurrency(item.originalCurrency) : null;
  if (!original || original === cur || !isMoney(item.originalPrice)) return { primary, secondary: null };
  return { primary, secondary: formatMoney(round2(item.originalPrice * qty), original) };
}

/** CSV-Spalten: Betrag (Euro, wie bisher), Originalbetrag, Originalwaehrung, Kurs. */
export function orderAmountCsvCells(order: OrderAmountSource): [string, string, string, string] {
  const cur = normCurrency(order.currency);
  const original = order.originalCurrency ? normCurrency(order.originalCurrency) : null;
  const betrag = isMoney(order.totalAmount) ? order.totalAmount.toFixed(2) : "";
  if (!original || (original === "EUR" && cur === "EUR")) return [betrag, "", "", ""];
  // Noch nicht umgerechnet: die Euro-Spalte bleibt leer, statt CZK als Euro auszugeben.
  if (cur !== "EUR") return ["", betrag, cur, ""];
  return [
    betrag,
    isMoney(order.originalTotalAmount) ? order.originalTotalAmount.toFixed(2) : "",
    original,
    isMoney(order.exchangeRate) ? String(order.exchangeRate) : "",
  ];
}
