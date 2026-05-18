---
title: Returns (Retouren)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Retouren-Management für eBay-/Kaufland-Returns. Listet alle eingehenden Rücksendungen mit Grund-Klassifikation (Defekt, Falsche Lieferung, Meinungsänderung, …), erlaubt Statusübergänge (`eingegangen → in_pruefung → erstattet/abgelehnt/abgeschlossen`), Refund-Issue und Event-Historie pro Return.

## Komponente(n)

- [components/orders/ReturnsView.tsx](../../../components/orders/ReturnsView.tsx) — Haupt-View mit Filter, Tabelle, Detail-Drawer, Bulk-Actions.

## API-Calls

- `fetchReturns(params)` — `/api/returns`. Liefert `ReturnData[]`.
- `fetchReturnEvents(id)` — Event-Historie pro Return.
- `updateReturn(id, patch)` — Status/Notes patchen.
- `syncReturns()` — Pull aktueller Rückgaben von eBay/Kaufland.
- `processReturn(id, payload)` — Manuelle Verarbeitung (Wareneingang, Zustandsprüfung).
- `issueReturnRefund(id, payload)` — Refund über Marketplace-API auslösen.
- `closeReturn(id)` — Return abschließen.
- `bulkReturnAction(returnIds, action)` — Massen-Aktion.

Pro-Endpunkt-Doku: `docs/kb/09-api/returns.md` (TBD).

## Datenquellen

- Lokaler `useState` — kein React-Query in dieser View.
- `useToast` für UX-Feedback.
- Mapping-Konstanten lokal im File: `REASON_LABELS`, `STATUS_CONFIG`, `MARKETPLACE_BADGE`.

## Wichtige Edge-Cases

- **Empty-State**: `EmptyState`-Component.
- **Loading**: lokaler Spinner.
- **Error**: Toast.
- **Unbekannter Grund**: Fallback-Badge `sonstiges` (`bg-app-elevated text-txt-muted`).
- **Unbekannter Status**: Backend liefert nur Werte aus `STATUS_CONFIG`-Keys; sonst kein Badge, Text-Only.
- **Mobile**: kein dedizierter Mobile-View.

## Bekannte Issues

Keine Returns-spezifischen offenen Bugs in [TASKS.md](../../../TASKS.md) (Stand 2026-05-18).
