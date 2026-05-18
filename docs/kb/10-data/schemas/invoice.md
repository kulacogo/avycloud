---
title: Schema — invoices
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `invoices`

> Quelle: [services/invoice-engine.js](../../../../backend/services/invoice-engine.js). Mirror der SevDesk-Rechnungen plus Korrekturen (Storno/Gutschrift). Drei Write-Pfade: `generateInvoice()` (initial), `importFromSevDesk()` (Backfill aus SevDesk), `createCorrectionInvoice()` (Storno/Gutschrift).

## DocID-Strategie

Auto-generierte Firestore-DocID via `.add()`. Verknuepfung zur Order via `orderId`-Feld; SevDesk-Doppel-Import verhindert ueber `where('sevdeskId', '==', …).limit(1)`-Check vor `.add()`.

Korrektur-Docs leben in derselben Collection; Unterscheidung via `type`/`source`-Felder.

## Identitaet + Verknuepfung

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | CLAUDE.md §8. |
| `invoiceNumber` | string \| null | ja | SevDesk-Sequenz-Nummer (z. B. `RE-2026-00012`). Bei SevDesk-Outage: Local-Fallback aus `services/number-sequence.getNextNumber({type:'invoice'})`. |
| `sevdeskId` | string \| null | optional | SevDesk-Invoice-ID. Dedup-Schluessel. |
| `sevdeskExportedAt` | string (ISO) \| null | optional | Zeitpunkt des SevDesk-Exports. |
| `orderId` | string \| null | optional | Firestore-DocID der `orders`-Doku. |
| `orderNumber` | string \| undefined | optional | `order.marketplaceOrderId` / `order.orderId` / Fallback. |
| `marketplaceOrderId` | string \| null | optional | Original-Marketplace-ID. |
| `marketplace` | string \| null | optional | `'ebay'` / `'kaufland'`. |

## Customer

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `customer` | object \| null | Spiegel von `orders.customer`. Bei SevDesk-Import nur `{ name }` (Detail-Daten via SevDesk-Contact-Embed). |

## Betraege

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `amountNetto` | number | Netto-Summe. |
| `amountNet` | number | **Synonym zu `amountNetto`** — beide Felder werden geschrieben fuer UI-Compat. |
| `amountBrutto` | number | Brutto-Summe (inkl. Versand). |
| `amountGross` | number | **Synonym zu `amountBrutto`**. |
| `vatRate` | number | Default `0.19`. |
| `vatAmount` | number | Brutto − Netto. |
| `currency` | string | `'EUR'`. |

## Datums-Felder

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `date` | string (`YYYY-MM-DD`) | Rechnungsdatum. |
| `dueDate` | string (`YYYY-MM-DD`) | Faelligkeit (Default `+14 Tage` via `paymentTermDays`). |
| `createdAt` | string (ISO) | Firestore-Insert-Zeit. |
| `importedAt` | string (ISO) | Nur fuer SevDesk-Import-Docs. |
| `correctedAt` | string (ISO) | Auf Original-Invoice gesetzt wenn Storno/Gutschrift erfolgte. |

## Status

| Feld | Typ | Werte | Beschreibung |
|------|-----|-------|--------------|
| `status` | string | `'entwurf'`, `'offen'`, `'bezahlt'`, `'storniert'`, `'teilkorrigiert'` | Aus SevDesk-Status-Mapping (`STATUS_MAP = { '100': 'entwurf', '200': 'offen', '1000': 'bezahlt' }` in [invoice-engine.js:854](../../../../backend/services/invoice-engine.js)). |

## PDF

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `pdfUrl` | string \| null | GCS-Pfad: `gs://${GCS_BUCKET}/${tenantId}/invoices/${invoiceNumber}.pdf`. Bei SevDesk-Import: aktuell `null` (PDF nicht re-importiert). |

## Source + Author

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `source` | string \| undefined | `'sevdesk_import'` fuer Imports. Sonst nicht gesetzt (impliziert "in-app generated"). |
| `createdBy` | string \| null | Firebase-`uid` des Actors (nur fuer `generateInvoice`-Pfad). |

## Korrektur-Felder

### Auf der ORIGINAL-Invoice (von `createCorrectionInvoice()` gesetzt):

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `correctionId` | string | DocID des Korrektur-Docs. |
| `correctionType` | `'storno'` \| `'gutschrift'` | Art der Korrektur. |
| `correctedAt` | string (ISO) | Zeitpunkt. |
| `status` | string | Wird auf `'storniert'` (bei Full-Storno) oder `'teilkorrigiert'` (bei Gutschrift) gesetzt. |
| `updatedAt` | string (ISO) | |

### Auf dem KORREKTUR-Doc (separate Doku, gleiche Collection):

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `type` | `'storno'` \| `'gutschrift'` | |
| `originalInvoiceId` | string | DocID der Original-Invoice. |
| `originalInvoiceNumber` | string | Spiegel. |
| `amountGross` | number | Korrektur-Betrag (= Refund-Betrag bei Gutschrift; = Full-Invoice-Brutto bei Storno). |
| `amountNetto` / `amountNet` | number | Korrektur-Netto. |
| `vatRate`, `currency`, `customer` | analog Original | |
| `reason` | string | Aus `transitionReturn()`-Note oder Default-Text. |
| `status` | `'storniert'` | Korrekturen werden immer als `'storniert'` markiert. |
| `date` | string (`YYYY-MM-DD`) | Korrektur-Datum. |
| `createdAt` | string (ISO) | |
| `sevdeskId` | string \| null | SevDesk-ID der Stornorechnung (SR). |

## Composite-Indexes

- `(tenantId, createdAt desc)` — UI Invoices-Liste, `routes/invoices.js:18`.
- `(tenantId, status, createdAt desc)` — Filter nach `offen` / `bezahlt` / `storniert`.

## Idempotenz

- `generateInvoice()` — Skip wenn `order.invoiceId` bereits gesetzt ist ([invoice-engine.js:127-130](../../../../backend/services/invoice-engine.js)).
- `importFromSevDesk()` — Skip wenn ein Invoice-Doc mit `sevdeskId === sdInv.id` existiert.
- `createCorrectionInvoice()` — Skip wenn Original-Invoice schon `correctionId` mit gleichem `correctionType` hat.

## Side-Effects

- `generateInvoice()`:
  1. POST/PUT zu SevDesk (`/Invoice/Factory/saveInvoice` → `/Invoice/{id}/sendBy`) — gibt offizielle `invoiceNumber` zurueck.
  2. Generiert PDF via `buildInvoicePdf()` mit pdfkit.
  3. Upload zu GCS-Bucket (`process.env.GCS_BUCKET || 'prodsandjobs'`).
  4. Updated `orders/{orderId}` mit `{ invoiceId, invoiceNumber }`.
- `createCorrectionInvoice()`:
  - `type === 'storno'`: POST `/Invoice/{sevdeskId}/cancelInvoice` (SevDesk erzeugt SR auto).
  - `type === 'gutschrift'`: POST `/Invoice/Factory/saveInvoice` mit `invoiceType: 'SR'`.

## Hinweis zur Feld-Duplikation

`amountNetto`/`amountNet` und `amountBrutto`/`amountGross` werden parallel gespeichert. UI liest aus beiden — additive only, keine Feld-Entfernung (CLAUDE.md §2).
