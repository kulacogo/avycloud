---
title: Operations (Identifizieren / Einlagern / Kommissionieren / Verpacken)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Operatives Workflow-Hub für das Lager-Personal mit Barcode-Scanner (ZXing) und vier Sub-Modi:
- **operations-identify** — Produkt einscannen, AI-Identify triggern, Daten erfassen
- **operations-stow** — Einlagerungs-Workflow (`bookStockIn`), Produkt in BIN buchen
- **operations-pick** — Kommissionierungs-Workflow für offene Orders, Pick-Routen-sortiert
- **operations-pack** — Verpackungs-Workflow, Carrier-/Gewicht-Eingabe, `packAndShip`-Übergang

Desktop nutzt `OperationsView`, Mobile rendert `MobileOperationsView` (touch-optimiert, große Buttons, Numpad).

## Komponente(n)

- [components/OperationsView.tsx](../../../components/OperationsView.tsx) — Desktop-Workflows.
- [components/MobileOperationsView.tsx](../../../components/MobileOperationsView.tsx) — Mobile-Workflows mit `CarrierPickModal` + `WeightPromptModal` aus `orders/ShippingDecisionDialog.tsx`.
- [components/operations/QuantityNumpad.tsx](../../../components/operations/QuantityNumpad.tsx) — Touch-Numpad für Mengen-Eingabe (Mobile).
- [components/ScannerOverlay.tsx](../../../components/ScannerOverlay.tsx) — Kamera-Overlay mit ZXing-Decoder (`@zxing/browser` `BrowserMultiFormatReader`).

## API-Calls

OperationsView:
- `fetchWarehouseBinDetail(binCode)` — BIN-Inhalt nach Scan.
- `stockInProduct(payload)` — Einlagerung (Stow).
- `stockOutProduct(payload)` — Auslagerung / Korrektur.
- `fetchOrders(limit)` — Pick-Backlog.
- `syncOrders()` — Refresh.
- `completeOrder(orderId)` — Order auf `picked`/`packed`/`shipped` transitionen (server-side).
- `buildImageProxyUrl(url)` — Bild-Proxy.

MobileOperationsView (zusätzlich):
- `packOrder(orderId)` — Pack-Transition.
- `packAndShip(orderId, payload)` — Pack + Ship in einem Schritt (Carrier + Gewicht).
- `fetchShippingPreview(orderId)` — Carrier-Vorschau, liefert `ShippingPreview` + `ShippingPreviewMatch`.
- `updateOrderWeight(orderId, weightGrams)` — Manuelle Gewichts-Eingabe.
- `fetchProfile()` — User-Defaults (Default-Carrier, etc.).
- `useIdentification()` → `UploadGroupPayload` für Identify-Trigger aus dem Stow-Flow.

Pro-Endpunkt-Doku: `docs/kb/09-api/orders.md`, `docs/kb/09-api/warehouse.md`, `docs/kb/09-api/sendcloud.md` (TBD).

## Datenquellen

- **ZXing-Scanner**: `BrowserMultiFormatReader` für Code128/EAN-13/Code39/QR.
- Lokaler `useState` für Modus, gescannte Codes, Order-Queue. **Kein** React-Query.
- Pick-Route-Sortierung über `compareBinCodesForPickRoute` ([utils/warehouseRoute.ts](../../../utils/warehouseRoute.ts)).
- I18n via `useI18n()`.
- `addMediaQueryListener` aus [utils/mediaQuery.ts](../../../utils/mediaQuery.ts) für Desktop-/Mobile-Switch.

## Wichtige Edge-Cases

- **Scanner-Permissions**: Browser muss Kamera-Zugriff erlauben. Bei verweigertem Zugriff → manueller Code-Eingabe-Fallback.
- **Unknown SKU**: Scan eines unbekannten Codes → Modal mit Option "Neues Produkt anlegen" (führt zu Capture-Flow).
- **Loading**: lokaler Spinner während Server-Action.
- **Error**: Inline-Banner unter dem Scanner; Toasts für Bulk-Aktionen.
- **Empty Pick-Queue**: keine Orders im Status `picking` → leerer State mit Hinweis.
- **Mehrfach-BINs**: ein Produkt kann in mehreren BINs liegen — Pick zeigt alle BINs in Pick-Route-Order an.
- **Gewicht fehlt**: `WeightPromptModal` wird vor `packAndShip` getriggert wenn Order/Produkt keine `weightGrams` hat.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-077** Mobile UI: Kommissionieren + Operationen (✅ gefixt, P2).
- **CLAUDE.md §13** Stock-Single-Writer-Invariant: `bookStockOut` mit `meta.orderId` MUSS `claimOrderStockDecrementInTx()` aufrufen, sonst Doppel-Decrement-Risiko (siehe Incident SKU-0000108900). Frontend ruft nur die High-Level-Endpoints, die das serverseitig schon korrekt sequencen.
- **CLAUDE.md §11** Order-State-Übergänge AUSSCHLIESSLICH über `transitionOrder()`. Frontend-Calls `completeOrder`, `packOrder`, `packAndShip` triggern das im Backend; nie `omsStatus` direkt schreiben.
