/**
 * Einordnung einer Rechnung in die Reiter der Rechnungsansicht.
 *
 * Der Reiter "Überfällig" filterte auf `status === "ueberfaellig"`. Diesen
 * Status gibt es nicht: gemessen 2026-08-17 über 666 Rechnungen stehen dort
 * ausschließlich `offen` (552), `bezahlt` (86) und `entwurf` (28). Der Reiter
 * war also garantiert leer — während die Kennzahl darüber, die korrekt über
 * das Fälligkeitsdatum rechnet, **256 überfällige Rechnungen** meldete.
 *
 * Der Mensch sah "Überfällig: 256", klickte darauf und bekam nichts. 256
 * offene Forderungen waren über den dafür gebauten Weg nicht auffindbar.
 *
 * Beide Stellen rechnen jetzt mit derselben Regel — deshalb liegt sie hier.
 */

export type InvoiceTabKey = "offen" | "bezahlt" | "ueberfaellig" | "storniert" | "entwurf";

export type InvoiceLike = {
  status?: string | null;
  type?: string | null;
  dueDate?: string | number | Date | null;
};

/** Offene Rechnungen — Schreibweisen aus SevDesk und aus dem eigenen Bestand. */
export const OPEN_INVOICE_STATUSES = new Set([
  "offen",
  "erstellt",
  "gesendet",
  "versendet",
  "teilbezahlt",
  "open",
  "sent",
]);

/**
 * Ist die Rechnung über ihr Fälligkeitsdatum hinaus?
 *
 * Tagesgenau — eine Rechnung, die heute fällig ist, ist noch nicht überfällig.
 * `now` ist übergebbar, damit die Regel prüfbar bleibt.
 */
export function istUeberfaellig(invoice: InvoiceLike | null | undefined, now: number = Date.now()): boolean {
  if (!invoice) return false;
  const status = String(invoice.status || "").toLowerCase();
  if (status === "bezahlt" || status === "paid" || status === "storniert" || status === "cancelled") return false;
  // Ein Entwurf wurde nie verschickt — er kann nicht überfällig sein.
  if (status === "entwurf" || status === "draft") return false;
  if (!invoice.dueDate) return false;
  const due = new Date(invoice.dueDate as any).getTime();
  if (!Number.isFinite(due) || due <= 0) return false;
  return due < now;
}

export function classifyInvoiceTab(invoice: InvoiceLike | null | undefined, now: number = Date.now()): InvoiceTabKey {
  if (!invoice) return "offen";
  const status = String(invoice.status || "").toLowerCase();
  const type = String(invoice.type || "").toLowerCase();

  if (type === "storno" || type === "gutschrift" || status === "storniert") return "storniert";
  if (status === "bezahlt") return "bezahlt";
  if (status === "entwurf") return "entwurf";
  // Erst hier: der Status "ueberfaellig" existiert in den Daten nicht, die
  // Fälligkeit tut es. Beides gilt, damit ein künftiger Status nicht wieder
  // still durchfällt.
  if (status === "ueberfaellig" || istUeberfaellig(invoice, now)) return "ueberfaellig";
  if (OPEN_INVOICE_STATUSES.has(status)) return "offen";
  return "offen";
}
