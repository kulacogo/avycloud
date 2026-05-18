---
title: "Integration: SevDesk"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# SevDesk

> Online-Buchhaltung. AvyCloud nutzt SevDesk für **Rechnungs-Pull/Push**, **Stornos / Gutschriften**, **Bank-Kontostände** und **Versandkosten-Vouchers** (Ausgabe-Tracking).
> Registry-Eintrag: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) (`sevdesk`, authType `api_key`).
> Hinweis: Es existiert **kein dediziertes `sevdesk-push.js`-Modul** — SevDesk-Calls sind inline in [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js) (Push) und [backend/lib/sevdesk.js](../../../backend/lib/sevdesk.js) (Read-Helpers).

## Was integriert ist

- **Read: Bank-Kontostände** — `getCheckAccountBalances()` ([backend/lib/sevdesk.js](../../../backend/lib/sevdesk.js))
- **Read: Versandkosten-Tracking** — `getShippingCostsFromSevDesk(fromDate, toDate)` filtert `CheckAccountTransaction` nach DHL/DPD/SendCloud/Deutsche Post/GLS.
- **Push: Invoice Create** — `generateInvoice()` in [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js):
  - `POST /Invoice/Factory/saveInvoice` (Draft anlegen) → `PUT /Invoice/{id}/sendBy` (Finalisieren, offizielle Nummer holen)
- **Push: Storno / Vollstornierung** — `createCorrectionInvoice({ type: 'storno' })`:
  - `POST /Invoice/{id}/cancelInvoice` (SevDesk legt automatisch Stornorechnung SR an)
- **Push: Gutschrift / Teilerstattung** — `createCorrectionInvoice({ type: 'gutschrift' })`:
  - `POST /Invoice/Factory/saveInvoice` mit `invoiceType: 'SR'`
- **Pull: Invoice-Import + Matching** — `importFromSevDesk()` syncht SevDesk-Belege gegen lokale `invoices` Collection.
- **Refund-Push (Marketplace, NICHT SevDesk):** `runRefundPush()` in [backend/services/returns-engine.js](../../../backend/services/returns-engine.js) pusht Refunds an eBay/Kaufland, nicht an SevDesk. SevDesk-Storno läuft separat via `createCorrectionInvoice()`.

## Auth + Credentials

- **API-Token im `Authorization`-Header**, **kein** `Bearer`-Prefix (SevDesk v1 Convention).
  ```js
  headers: { Authorization: apiKey, 'Content-Type': 'application/json' }
  ```
- Token aus Secret-Manager: `SEVDESK_API_TOKEN` (lazy-cached via `getSevDeskApiKey()` in [backend/lib/sevdesk.js](../../../backend/lib/sevdesk.js) und identische Wiederholung in [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js)).
- Settings-UI: `apiToken` (Password-Feld, min. 10 Zeichen).
- Base-URL hardcoded: `https://my.sevdesk.de/api/v1` (kein Sandbox, SevDesk hat keine Sandbox-API).

## Hauptendpoints (call sites im Code)

### Read ([backend/lib/sevdesk.js](../../../backend/lib/sevdesk.js))

| Endpoint | Methode | Funktion | TTL |
|----------|---------|----------|-----|
| `/CheckAccount?limit=100&embed=all` | GET | `getCheckAccountBalances()` | 5 min Cache |
| `/CheckAccountTransaction?startDate=&endDate=&limit=500` | GET | `getShippingCostsFromSevDesk(from,to)` | 15 min Cache pro Date-Range |

Filter-Heuristik für Bank-Konten (`getCheckAccountBalances`): Whitelist `sichteinlagen`, `businesscard`; Blacklist `basiskonto`, `stamm`.
Filter-Heuristik für Versandkosten (`getShippingCostsFromSevDesk`): `payeePayerName` enthält `dhl|dpd|sendcloud|deutsche post|gls`, nur negative Beträge.

### Push: Invoice ([backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js))

| Endpoint | Methode | Funktion |
|----------|---------|----------|
| `/Invoice/Factory/saveInvoice` | POST | `generateInvoice()` — Draft (`status: '100'`) |
| `/Invoice/{id}/sendBy` mit `{ sendType: 'VPDF' }` | PUT | finalisiert + vergibt offizielle Nummer |
| `/Invoice/{id}/cancelInvoice` | POST | Storno → SR-Beleg |
| `/Invoice/Factory/saveInvoice` mit `invoiceType: 'SR'` | POST | Gutschrift (partial) |
| `/SevUser?limit=1` | GET | `getSevdeskUserId(token)` — Contact-Person für Invoice |
| `/Invoice/{sevdeskId}` | DELETE | Cleanup-Script [scripts/cleanup-local-invoices.js](../../../backend/scripts/cleanup-local-invoices.js) |

Fallback wenn `SEVDESK_API_TOKEN` nicht gesetzt oder Push fehlschlägt: **lokale Sequenz-Nummer** über `getNextNumber({tenantId, type:'invoice'})`. Wird beim nächsten `importFromSevDesk()` korrigiert.

## Webhooks

**Keine Webhooks.** SevDesk bietet (Stand 2026) keine Webhook-Plattform. Sync ist Pull-Only über `invoice-sync`-Cron (`runImportSevdesk` in [backend/scripts/run-import-sevdesk.js](../../../backend/scripts/run-import-sevdesk.js); im Backend-Index als Cron-Job).

## Rate-Limits + Quotas

- SevDesk publiziert kein hartes Rate-Limit. In der Praxis:
  - Read-Calls werden via Cache aggressiv gedrosselt (5 min Account-Cache, 15 min Voucher-Cache).
  - Push-Calls (Invoice-Create / Cancel) sind low-volume (1 pro Order-Status-Change).
- Token ist **per User**, nicht per App — Rotation ist manuell.

## Bekannte Schwächen

- **Kein dediziertes `sevdesk-push.js`-Modul.** Push-Logik ist **inline** in `invoice-engine.js` (300+ Zeilen Mix aus PDF-Generierung, GCS-Upload, SevDesk-Calls). Erschwert Tests + Mocking.
- **Fail-soft auf SevDesk-Push.** `try { create… } catch { console.warn }` — Lokale Invoice wird trotzdem gespeichert mit Platzhalter-Nummer (`getNextNumber('invoice')`). Korrigiert wird sie erst beim nächsten `importFromSevDesk()`. Folgewirkung: vorübergehende Nummern-Drift zwischen Firestore und SevDesk.
- **Authorization-Header ohne `Bearer`.** SevDesk-spezifisch und non-standard; jeder neue Helper muss das wissen, sonst kommt 401.
- **Cache-Invalidation per TTL only.** Wenn ein User in SevDesk manuell Geld bewegt, dauert es bis zu 5 min bis das Dashboard das spiegelt.
- **Voucher-Filter ist Keyword-basiert.** Neue Carrier (z. B. UPS, FedEx) tauchen nicht automatisch in `getShippingCostsFromSevDesk` auf — `SHIPPING_SUPPLIER_KEYWORDS` muss manuell erweitert werden.
- **Storno-Idempotenz** (`createCorrectionInvoice`): Skip-Logik prüft `invoice.correctionId && invoice.correctionType === type`. Wenn der SevDesk-Cancel teilweise gelaufen ist (`cancelSevdeskId` gesetzt, lokales Doc-Update geschlagen), liegt ein „ghost storno" vor — Recovery via [scripts/retry-storno-sevdesk.js](../../../backend/scripts/retry-storno-sevdesk.js).
- **`/Invoice/Factory/saveInvoice` mit `invoiceType: 'SR'`** für Gutschrift verlangt eine manuell zusammengebaute `invoiceNumber` (`SR-${original}`). SevDesk weist sonst keine eigene SR-Nummer zu.
- **PDF wird lokal mit `pdfkit` gerendert** — die SevDesk-`/Invoice/{id}/getPdf`-Response wird nicht genutzt. Konsequenz: Layout-Drift zwischen Firestore-PDF und SevDesk-PDF, wenn beide Quellen verglichen werden.

## TBD

- **Dediziertes `sevdesk-push.js`-Modul** mit Tests existiert **nicht**. Ein Refactor wäre additiv möglich, ist aber kein offener Task.
- **Webhook-Integration**: SevDesk bietet aktuell keine Webhooks → TBD aufseiten des Anbieters, nicht aufseiten AvyCloud.

## Owner / Docs

- **Code-Owner:** Backend-Team / Finance-Ops.
- **Externe Doku:**
  - API v1: [api.sevdesk.de](https://api.sevdesk.de/) bzw. [my.sevdesk.de/apiOverview](https://my.sevdesk.de/apiOverview)
  - Invoice-Factory: [https://api.sevdesk.de/#tag/Invoice](https://api.sevdesk.de/#tag/Invoice)
- **Verwandte KB-Seiten:**
  - [services/invoice-engine.js](../../../backend/services/invoice-engine.js) — Push-Implementierung
  - [services/returns-engine.js](../../../backend/services/returns-engine.js) — Trigger für `createCorrectionInvoice`
