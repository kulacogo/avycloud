/**
 * Centralized OMS labels for all status values.
 * Used across OrdersView, ShippingView, ReturnsView, InvoicesView.
 * Prerequisite for future i18n integration.
 */

export const OMS_STATUS_LABELS: Record<string, string> = {
  pending: "Neu",
  confirmed: "Bestätigt",
  picking: "Kommissionierung",
  picked: "Kommissioniert",
  packing: "Verpackung",
  packed: "Verpackt",
  shipped: "Versendet",
  delivered: "Zugestellt",
  completed: "Abgeschlossen",
  cancelled: "Storniert",
  returned: "Retoure",
  on_hold: "Pausiert",
  refunded: "Erstattet",
};

export const RETURN_REASON_LABELS: Record<string, string> = {
  defekt: "Defekt",
  falsche_lieferung: "Falsche Lieferung",
  nicht_wie_beschrieben: "Nicht wie beschrieben",
  zu_spaet: "Zu spät",
  meinungsaenderung: "Meinungsänderung",
  doppelbestellung: "Doppelbestellung",
  sonstiges: "Sonstiges",
};

export const RETURN_STATUS_LABELS: Record<string, string> = {
  eingegangen: "Eingegangen",
  neu: "Neu",
  in_pruefung: "In Prüfung",
  erstattet: "Erstattet",
  teilweise_erstattet: "Teilerstattung",
  abgelehnt: "Abgelehnt",
  abgeschlossen: "Abgeschlossen",
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  offen: "Offen",
  erstellt: "Erstellt",
  gesendet: "Gesendet",
  bezahlt: "Bezahlt",
  ueberfaellig: "Überfällig",
  storniert: "Storniert",
  entwurf: "Entwurf",
};

export const SHIPPING_TAB_LABELS: Record<string, string> = {
  alle: "Alle",
  ausstehend: "Ausstehend",
  in_zustellung: "In Zustellung",
  zugestellt: "Zugestellt",
  problem: "Probleme",
  sonstige: "Sonstige",
};
