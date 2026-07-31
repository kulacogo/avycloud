---
title: API — Identify (AI Pipelines + Chat + Jobs)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Identify

Mount: `app.use('/api', identifyRouter)` ([backend/index.js#L245](../../../backend/index.js#L245)). Globale `requireAuth` greift.

Quelle: [backend/routes/identify.js](../../../backend/routes/identify.js). Pipeline-Services:
- `services/identify-v4.js` (feature-flagged, Orchestrator-Worker-Swarm)
- `services/identify-v3.js` (Multi-Stage, default-on)
- Grounding pipeline (inline in `identify.js`)
- `services/enrichment-v2.js` (`runSerpapiFreePipeline`)
- Chat: `services/product-chat-v3.js` / `product-chat-v2.js` / `product-chat.js`

Tenant-Source: `req.tenantId || req.user?.tenantId || 'default'`.

Rate-Limit: alle Identify/Chat-Endpoints unter zusätzlichem `identifyLimiter` (30 req / 15 min).

Multipart-Uploads: `multer.memoryStorage()`, max **30 Bilder à 10 MB** per Request für `images[]`. Chat-Attachments: max 6 Files à 6 MB (`MAX_CHAT_ATTACHMENTS`, `MAX_CHAT_ATTACHMENT_SIZE`).

---

## Identify-Pipelines

### `POST /api/jobs` — Tombstone

- **Auth**: requireAuth + multer
- **Response**: `410 Gone` — `Legacy Identify-Jobs werden nicht mehr unterstützt. Bitte /api/v2/enrich verwenden.`
- **Source**: [backend/routes/identify.js#L170-L178](../../../backend/routes/identify.js#L170-L178)

### `POST /api/identify` — Tombstone

- **Auth**: requireAuth + multer
- **Response**: `410 Gone`
- **Source**: [backend/routes/identify.js#L1256-L1264](../../../backend/routes/identify.js#L1256-L1264)

---

### `POST /api/v2/enrich`

SerpAPI-free pipeline, **kein DB-Write**. Liefert reines V2-Record.

- **Auth**: `requirePermission('identify', 'run')` + `identifyLimiter`
- **Tenant Source**: none (kein Persist)
- **Request**: `multipart/form-data`
  - `images[]` (max 30, je 10 MB)
  - `barcodes` (text, optional)
  - `locale` (default `de-DE`)
- **Response**: `{ "ok": true, "data": {...V2Record}, "meta": { "locale": "de-DE", "barcodes": "...", "ocr": {...}, "llm": {...}, "barcodeInsights": {...}, "quality": {...} } }`
- **Side-Effects**: keine Persistierung. Externe Calls: Gemini, BrightData (Vision OCR).
- **Idempotency**: stateless (jeder Call lädt frisch).
- **Failure Modes**: `400` ohne Bilder UND ohne Barcodes; `500 { code: 500 }` mit kurzer Detail-Message.
- **Source**: [backend/routes/identify.js#L181-L225](../../../backend/routes/identify.js#L181-L225)

---

### `POST /api/v2/identify`

V2-Pipeline + Datasheet-Review + **persistent save als SYSTEM mode** (saveProductV2). Pipeline-Kaskade: V4 (opt-in) → V3 (default) → V2-Grounding → SerpAPI-free.

- **Auth**: `requirePermission('identify', 'run')` + `identifyLimiter`
- **Tenant Source**: JWT
- **Request**: `multipart/form-data`
  - `images[]`, `barcodes`, `locale`
  - `inventoryId` (optional)
  - `lotCode` — **Pflicht** für Neue-Ware-Path (Los-Code `L-MMYYNN` oder `NL-MMYY`, validiert gegen `warehouse_lots`; Altfeld `paletteCode` wird übergangsweise als Wert akzeptiert)
  - `hint` (optional, max 400 chars)
- **Response**:
  ```json
  {
    "ok": true,
    "data": { /* gespeichertes Product-Objekt */ },
    "meta": { "reused_existing": false, "lotCode": "L-072612", "locale": "de-DE", "barcodes": [...], "pipeline": "v4|v3|grounding|legacy", "v3": {...}, "v4": {...} }
  }
  ```
  Bei Duplicate-Match (über explicit barcodes oder V3-resolved identifiers): `{ "ok": true, "data": <existing>, "meta": { "reused_existing": true, ... } }`.
- **Side-Effects**:
  - OCR + Image-Upload nach GCS parallel.
  - Stock-Protection: `findProductByStrictIdentifier` zuerst (Duplicate-Reuse statt Re-Identify).
  - Bei neuem Produkt: `saveProductV2(product, { mode: 'system', ... })` + `adjustPendingIntakeQuantity` + Los-Marker (`ops.sourceLot`/`ops.sourceLotAt`).
  - Metric-Write nach `external_api_calls`-ähnlichem Channel (`recordIdentifyMetric`).
- **Idempotency**: durch Duplicate-Reuse-Pfad implicit idempotent für identische Identifier.
- **Failure Modes**:
  - `400` ohne Bilder/Barcodes.
  - `400 { code: 'LOT_REQUIRED' | 'LOT_NOT_FOUND' }`.
  - `500` mit gekappter Details-Message; Pipeline-Failures fallen automatisch durch (V4→V3→V2→Legacy).
- **Source**: [backend/routes/identify.js#L230-L1018](../../../backend/routes/identify.js#L230-L1018)

#### Feature-Flags (siehe CLAUDE.md für Details)

- `IDENTIFY_V4=true|false` (default false; dark-deployed)
- `IDENTIFY_V4_CANARY_RATE` (0..1)
- `IDENTIFY_V4_CANARY_TENANTS` (CSV)
- `IDENTIFY_V3=true|false` (default true)
- `IDENTIFY_GROUNDING=true|false` (default true)
- `IDENTIFY_TOTAL_TIMEOUT_MS=360000` (6 min, aligned mit Cloud Run `--timeout 600`)

---

### `POST /api/v2/group-images`

Auto-Separation für Multi-Produkt-Uploads.

- **Auth**: `requirePermission('identify', 'run')` + multer
- **Tenant Source**: none
- **Request**: `multipart/form-data` mit `images[]`, optional `barcodes`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "groups": [{ "id": "group_0", "label": "Produkt 1", "image_indices": [0,1,2], "confidence": 0.85, "reason": "...", "detected_barcode": "..." }],
      "imageCount": 5
    }
  }
  ```
- **Side-Effects**: keine Persistierung. Gemini-Call(s).
- **Tier-Fallbacks**: Single-Image → `detectMultipleProducts`; Multi → `groupImagesStructured`; bei Failure aHash-Cluster ([backend/lib/image-grouping-fallback.js](../../../backend/lib/image-grouping-fallback.js)); Last-Resort 1-Group-pro-Bild mit confidence=0.3.
- **Failure Modes**: `400 { code: 'NO_IMAGES' }` wenn leer. `500 { code: 'GROUPING_FAILED' }` nur bei Top-Level-Throw.
- **Source**: [backend/routes/identify.js#L1654-L1795](../../../backend/routes/identify.js#L1654-L1795)

---

## Jobs

### `GET /api/jobs`

Listet Identification-Jobs.

- **Auth**: `requirePermission('jobs', 'read')`
- **Tenant Source**: none (TBD - verify in code, ob global oder Tenant-gefiltert)
- **Request**: Query `?status=pending,processing,failed,done&limit=50&cursor=<base64>&order=asc|desc`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "jobs": [{ "id": "...", "status": "...", "attempts": 1, "model": "...", "payload": { "locale": "...", "barcodes": "...", "fileCount": <int>, "files": [...] }, "result": { "productCount": <int>, "products": [{ "id": "...", "name": "...", "sku": "..." }] }, "error": null, "reuseEvents": [...] }],
      "nextCursor": "...",
      "hasMore": true,
      "stats": { "total": 100, "pending": 5, "processing": 2, "done": 90, "failed": 3 },
      "filters": { "statuses": [...], "limit": 50, "order": "desc" }
    }
  }
  ```
- **Side-Effects**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/identify.js#L1075-L1124](../../../backend/routes/identify.js#L1075-L1124)

### `GET /api/jobs/:id`

- **Auth**: `requirePermission('jobs', 'read')`
- **Tenant Source**: implicit
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "...", "status": "done|failed|...", "result": <bei done>, "serpTrace": <bei done>, "error": <bei failed>, ... } }`
- **Failure Modes**: `404`, `500`.
- **Source**: [backend/routes/identify.js#L1127-L1174](../../../backend/routes/identify.js#L1127-L1174)

### `GET /api/jobs/:id/stream`

- **Auth**: `requirePermission('jobs', 'read')`
- **Tenant Source**: implicit
- **Request**: `(empty)`
- **Response**: `(stream)` — Firestore `onSnapshot` über `identificationJobs/{id}`.
- **Side-Effects**: read.
- **Failure Modes**: SSE-Error-Event bei Snapshot-Failure.
- **Source**: [backend/routes/identify.js#L1177-L1200](../../../backend/routes/identify.js#L1177-L1200)

### `POST /api/jobs/:id/retry`

⚠️ **Kein `requirePermission`** — Diskrepanz zu anderen Job-Routen.

- **Auth**: requireAuth
- **Tenant Source**: implicit
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "..." } }`
- **Side-Effects**: setzt Job-Status auf `pending` (clears `startedAt`, `finishedAt`, `error`, `result`, `serpTrace`, `reuseEvents`) und `enqueueJob(id, true)`.
- **Idempotency**: idempotent (mehrfaches Retry resettet immer).
- **Failure Modes**: `400` ohne ID, `404`.
- **Source**: [backend/routes/identify.js#L1203-L1253](../../../backend/routes/identify.js#L1203-L1253)

---

## Chat (Gemini)

### `POST /api/chat`

Pipeline-Kaskade: V3 → V2 → Legacy. Stream- oder Sync-Mode.

- **Auth**: `requirePermission('ai', 'chat')` + `identifyLimiter` + `chatUploadMiddleware`
- **Tenant Source**: JWT
- **Request** (JSON oder multipart):
  ```json
  {
    "productId": "...",
    "message": "Bitte ergänze GPSR-Daten",
    "model": "gemini-3.1-pro-preview-customtools",
    "scope": "<optional, z.B. 'sourcing' | 'pricing'>",
    "pipeline": "v3" | "v2" | "legacy" | "auto"
  }
  ```
  Multipart: zusätzlich `attachments[]` (PDF/JPG/PNG/WEBP/CSV/JSON/XLS/XLSX). Query: `?stream=true` für SSE.
- **Response (sync)**:
  ```json
  {
    "ok": true,
    "model": "gemini-...",
    "pipeline": "v3" | "v2" | "legacy",
    "data": { "message": "...", "datasheetChanges": [...], "evidenceUrls": [...], "confidence": { "readyForPublish": true|false, "missingCritical": [...] }, "needsHumanReview": false }
  }
  ```
- **Response (stream)**: `text/event-stream` mit `data: <json>` Events: `{ type: 'tool_start' }`, `{ type: 'tool_end' }`, `{ type: 'token', text: '...' }`, `{ type: 'result', data: {...}, model, pipeline }`, `{ type: 'done' }`, `{ type: 'error', message: '...', details: {...} }`.
- **Side-Effects**:
  - Lädt Chat-Session aus `chatSessions/{userId}__{productId}` (via `buildSessionId`).
  - Schreibt User-Message + AI-Response zurück (`appendMessages`, fire-and-forget).
  - `tagSessionPipeline(sessionId, pipeline)` — schreibt `pipeline` und `pipelineUpdatedAt` auf das Session-Doc.
  - Externe Calls: Gemini API mit Google-Search-Grounding (V2), urlContext-Tool (V2/V3), atomic-tools (V3) — siehe CLAUDE.md.
- **Idempotency**: stateless pro Call; Session-Append macht Chat-Verlauf stateful.
- **Failure Modes**:
  - `400` ohne `productId` oder ohne Message+Attachments.
  - `404` wenn `productId` nicht existiert.
  - `500 { code: 'CHAT_ALL_PIPELINES_FAILED', details: { v3: '...', v2: '...', legacy: '...' } }` wenn alle Pipelines fehlschlagen.
  - `400` für Unsupported Attachment Types (`Allowed: JPG, PNG, WEBP, PDF, TXT, CSV, JSON.`).
- **Source**: [backend/routes/identify.js#L1326-L1651](../../../backend/routes/identify.js#L1326-L1651)

#### Pipeline-Override

`req.body.pipeline` (oder `?pipeline=`): `v3`, `v2`, `legacy`, `auto` (default). Invalid → `auto`. Override unterdrückt automatische Fallback-Kette.

### `GET /api/chat/session/:productId`

- **Auth**: `requirePermission('ai', 'chat')`
- **Tenant Source**: JWT (via `uid`)
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "session": { "messages": [...], "pipeline": "v3", "pipelineUpdatedAt": "...", ... } }`
- **Source**: [backend/routes/identify.js#L1267-L1280](../../../backend/routes/identify.js#L1267-L1280)

### `DELETE /api/chat/session/:productId`

- **Auth**: `requirePermission('ai', 'chat')`
- **Tenant Source**: JWT (via `uid`)
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: löscht `chatSessions/{userId}__{productId}`.
- **Idempotency**: idempotent.
- **Source**: [backend/routes/identify.js#L1283-L1296](../../../backend/routes/identify.js#L1283-L1296)

---

## Health-Endpoints

### `GET /api/health/external-apis`

- **Auth**: requireAuth (kein `requirePermission` — Daten als operativ klassifiziert)
- **Tenant Source**: none
- **Request**: Query `?hours=24&service=<name>`. `hours` 1–168.
- **Response**: `{ "ok": true, "data": { "totalCalls": <int>, "perService": { "serpapi": { "count": ..., "successRate": ..., "p50LatencyMs": ..., "p95LatencyMs": ..., "errorCodes": {...} } }, "windowMs": ... } }`
- **Side-Effects**: read aus `external_api_calls` collection.
- **Source**: [backend/routes/identify.js#L1024-L1045](../../../backend/routes/identify.js#L1024-L1045)

### `GET /api/health/identify`

- **Auth**: requireAuth (kein `requirePermission` — operative Daten)
- **Tenant Source**: optional Query `?tenantId=...`
- **Request**: Query `?hours=24&tenantId=...`. `hours` 1–168.
- **Response**: `{ "ok": true, "data": { "totalRuns": ..., "successRate": ..., "byPipeline": { "v4": ..., "v3": ..., "grounding": ..., "legacy": ... }, "errorCounts": {...}, "latencyMs": { "avg": ..., "p50": ..., "p95": ... }, "lastFailure": {...} } }`
- **Side-Effects**: read auf `identifyMetrics` (TBD - verify in code).
- **Source**: [backend/routes/identify.js#L1051-L1072](../../../backend/routes/identify.js#L1051-L1072)
