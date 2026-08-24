/**
 * Hinweis fuer die Erfassung, wenn ein Produkt bereits im Bestand war.
 *
 * Seit 2026-08-18 sucht das Backend nach dem identifizierten Produkt, nicht nur
 * nach seinem Barcode (services/duplicate-search.js). Wird es gefunden, gibt
 * die Erfassung das BESTANDSPRODUKT zurueck und legt weder ein zweites
 * Datenblatt noch eine zweite SKU an.
 *
 * Ohne sichtbaren Hinweis waere das eine stille Aenderung: der Bediener sieht
 * ein gefuelltes Datenblatt und haelt die alten Daten fuer das Ergebnis der
 * frischen Erkennung. Genau diese Klasse von Unsichtbarkeit ist in CLAUDE.md
 * Punkt 16 als Datenverlust-Muster beschrieben.
 */

export interface IdentifyMetaLike {
  reused_existing?: boolean;
}

export interface ReuseNoticeContext {
  label?: string;
  productName?: string;
  productId?: string;
}

export interface ReuseNotice {
  title: string;
  detail: string;
  label?: string;
  productId?: string;
}

export function buildReuseNotice(
  meta?: IdentifyMetaLike | null,
  context: ReuseNoticeContext = {},
): ReuseNotice | null {
  if (!meta?.reused_existing) return null;

  const name = context.productName?.trim();
  const detail = name
    ? `„${name}" war bereits im Bestand — es wurde kein neues Datenblatt und keine neue SKU angelegt. Die vorhandenen Daten bleiben unveraendert.`
    : "Das Produkt war bereits im Bestand — es wurde kein neues Datenblatt und keine neue SKU angelegt. Die vorhandenen Daten bleiben unveraendert.";

  return {
    title: "Produkt bereits vorhanden",
    detail,
    label: context.label,
    productId: context.productId,
  };
}
