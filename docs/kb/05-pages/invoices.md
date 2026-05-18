---
title: Invoices (Rechnungen)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Rechnungs-Übersicht aller generierten Verkaufs-Rechnungen (SevDesk-Integration). Listet Rechnungen mit Status (offen, bezahlt, mahnung, …), erlaubt Statusänderungen und direkten PDF-Download.

## Komponente(n)

- [components/orders/InvoicesView.tsx](../../../components/orders/InvoicesView.tsx) — Single-File-View mit Tabelle, Filter, Status-Toggles und PDF-Download-Button.

## API-Calls

- `fetchInvoices(params)` — `/api/invoices`. Liefert `InvoiceData[]`.
- `updateInvoiceStatus(id, status)` — Status-Patch.
- `downloadInvoicePdfBlob(invoiceId)` — Lädt das PDF als Blob, wird im Browser geöffnet/gespeichert.

Pro-Endpunkt-Doku: `docs/kb/09-api/invoices.md` (TBD).

## Datenquellen

- Lokaler `useState`-Cache — kein React-Query.
- `useToast` für UX-Feedback.

## Wichtige Edge-Cases

- **Empty-State**: `EmptyState`-Component aus [components/ui/EmptyState.tsx](../../../components/ui/EmptyState.tsx).
- **Loading**: lokaler Spinner.
- **Error**: Toast.
- **PDF-Download**: Blob-basiert; Browser muss Pop-ups erlauben.
- **Mobile**: kein dedizierter Mobile-View.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-073** Rechnungen: Fehler beim Klick auf grünen Haken (P1, offen). Status-Toggle wirft Backend-Error.
- **BUG-074** Rechnungs-PDF Design — TrendOcean-Branding (✅ gefixt).
