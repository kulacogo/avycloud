---
title: System-Overview
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# System-Overview

> Das Big-Picture: welche Komponente wohin spricht. Detail-Verweise in den jeweiligen Sub-Dokumenten ([frontend.md](frontend.md), [backend.md](backend.md), [data-layer.md](data-layer.md), [eventing.md](eventing.md)).

## Komponenten-Diagramm

```mermaid
flowchart LR
    Browser["Browser / SPA"]
    CDN["Firebase Hosting CDN"]
    Hosting["Firebase Hosting<br/>(static dist/)"]
    Cloud["Cloud Run<br/>europe-west3<br/>product-hub-backend"]
    FS["Firestore"]
    GCS["Google Cloud Storage<br/>(Images, Reports, Logos)"]
    Sec["Secret Manager"]
    Gemini["Google Gemini API"]
    eBay["eBay APIs<br/>(Trading, Sell, Browse)"]
    Kaufland["Kaufland Seller API"]
    SendCloud["SendCloud REST API"]
    SevDesk["SevDesk API"]
    Auth["Firebase Authentication"]

    Browser -->|HTTPS| CDN
    CDN --> Hosting
    Browser -->|XHR / Fetch / SSE| Cloud
    Browser -->|JWT Sign-in| Auth
    Cloud -->|verifyIdToken| Auth
    Cloud --> FS
    Cloud --> GCS
    Cloud --> Sec
    Cloud --> Gemini
    Cloud --> eBay
    Cloud --> Kaufland
    Cloud --> SendCloud
    Cloud --> SevDesk
    eBay -->|Webhook| Cloud
    Kaufland -->|Webhook| Cloud
    SendCloud -->|Webhook| Cloud
```

## Verantwortlichkeiten pro Komponente

| Komponente | Verantwortung | Quelle |
|------------|---------------|--------|
| **Browser / SPA** | UI-Rendering, Auth-Sign-in, Optimistic Updates via React-Query, SSE-Streams für Identify/Improve. | [App.tsx](../../../App.tsx) (Annahme — Repo-Root SPA-Entry) |
| **Firebase Hosting** | Statisches Hosting der Vite-Build-Artefakte (`dist/`), CDN-Distribution, SPA-Rewrites. | [firebase.json](../../../firebase.json) |
| **Cloud Run** | Express-API, 3 GiB / 2 vCPU, `--min-instances 1`, `--timeout 600`, Region `europe-west3`. | [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) |
| **Firestore** | Primärdatenbank für Produkte (`products_v2`), Orders, Returns, Shipments, Invoices, Audit, Ledger. | [backend/lib/firestore.js](../../../backend/lib/firestore.js) |
| **Google Cloud Storage** | Bilder, Reports (`recategorize_v2`), Logos, Cassini-Reports. | [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) (impliziert via `@google-cloud/storage` Dependency) |
| **Secret Manager** | API-Keys für eBay, Kaufland, SendCloud, SevDesk, Gemini. | [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) (Feld `secretKeys`) |
| **Gemini API** | Identify-Pipelines (V3/V4), Chat (V3/V2/Legacy), Quality-Gate, Stage-3-Content, Image-Enhance, Critic. | [docs/standards/llm-callers-inventory.md](../../standards/llm-callers-inventory.md) |
| **eBay** | Listings, Orders-Intake, Order-Updates, Tracking-Push, Required-Aspects-Lookup. | [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) §`ebay` |
| **Kaufland** | Listings, Orders-Intake, Stock-Push, Tracking-Push. | [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) §`kaufland` |
| **SendCloud** | Versandlabels (DHL, DPD, GLS, …), Tracking-Updates, Delivery-Polling. | [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js) |
| **SevDesk** | Rechnungs-Generierung + Import existierender Rechnungen. | [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js) |
| **Firebase Authentication** | E-Mail/Passwort, Token-Issue, `verifyIdToken` im Backend. | [backend/lib/auth.js](../../../backend/lib/auth.js) |

## Datenfluss: Identify

```mermaid
sequenceDiagram
    autonumber
    participant SPA
    participant CR as Cloud Run
    participant Job as job-runner
    participant V4 as identify-v4
    participant V3 as identify-v3
    participant GEM as Gemini
    participant EBAY as eBay Catalog
    participant FS as Firestore

    SPA->>CR: POST /api/identify (images)
    CR->>Job: enqueue job
    CR-->>SPA: jobId
    SPA->>CR: SSE /api/identify/stream/:jobId
    Job->>V4: run if IDENTIFY_V4 || canary
    V4->>GEM: Wave 1 (identity + category)
    V4->>EBAY: get_required_aspects + GTIN lookup
    V4->>GEM: Wave 2 (attributes/seo/pricing/image/gpsr)
    V4->>GEM: Critic
    V4->>FS: saveProductV2 if ebay_ready_score >= 0.6
    V4-->>Job: result
    Job-->>SPA: SSE progress + final
    Note over V4,V3: Auf V4-Fehler fällt Job-Runner auf V3 zurück
```

## Datenfluss: Order

```mermaid
sequenceDiagram
    autonumber
    participant MP as Marktplatz (eBay/Kaufland)
    participant CR as Cloud Run
    participant Intake as order-intake-*
    participant Bus as sync-event-bus
    participant Res as stock-reservation
    participant SM as order-state-machine
    participant Wh as warehouse
    participant SC as SendCloud
    participant SD as SevDesk

    MP->>CR: Webhook neue Bestellung
    CR->>Intake: handleNewOrder
    Intake->>Res: reserveStock(orderId, sku, qty)
    Intake->>Bus: emitSyncEvent('order:created')
    Bus->>CR: syncStockForOrderItems (Safety-Net)

    Note over CR,SM: Pick-UI: bookStockOut Pfad A oder<br/>State-Machine: transitionOrder('shipped') Pfad B
    SM->>Wh: decrementProductByIdOrSku (wenn nicht bereits)
    SM->>Bus: emitSyncEvent('order:status_changed')
    SM->>SC: createParcel
    SC-->>CR: Webhook shipment:updated
    Bus->>MP: pushCancellation / pushTracking
    SM->>SD: bulkGenerateForShippedOrders
```

## Querverweise

- Komponenten im Detail: [frontend.md](frontend.md), [backend.md](backend.md), [data-layer.md](data-layer.md), [eventing.md](eventing.md).
- Stock-Mutations-Architektur: [11-rules-and-invariants/stock-single-writer.md](../11-rules-and-invariants/stock-single-writer.md).
- Auth + Tenant: [auth-and-rbac.md](auth-and-rbac.md), [multi-tenancy.md](multi-tenancy.md).
- ADRs: [adr/](adr/).
