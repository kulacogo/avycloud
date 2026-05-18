---
title: Identify Queue (Identifizierungs-Warteschlange)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Listet alle laufenden, fehlgeschlagenen und abgeschlossenen Identifikations-Jobs (Capture-Uploads). Erlaubt Retry fehlgeschlagener Jobs und zeigt einen Health-Status-Tile mit Aggregat-Metriken für die Identify-Pipeline (V3/V4) der letzten X Stunden.

## Komponente(n)

- [components/IdentifyQueueView.tsx](../../../components/IdentifyQueueView.tsx) — Job-Liste mit Status-Filtern (`pending | processing | failed | done`).
- [components/IdentifyHealthTile.tsx](../../../components/IdentifyHealthTile.tsx) — Aggregat-Health-Tile (Success-Rate, p50/p95-Latenz, Error-Categories).

## API-Calls

Indirekt:
- `useIdentificationQueue()` ([hooks/useIdentificationQueue.ts](../../../hooks/useIdentificationQueue.ts)) — wrapped:
  - `fetchIdentificationJobs(params)` — Job-Liste mit Statuses + Pagination.
  - `retryIdentificationJob(jobId)` — Re-Queue eines Failed-Jobs.
- `fetchIdentifyHealth({ hours, signal })` — Aggregat-Metriken aus `external_api_calls` und Identify-Telemetrie.

Pro-Endpunkt-Doku: `docs/kb/09-api/identify.md` (TBD).

## Datenquellen

- `useIdentificationQueue` ist die Single-Source: liefert `jobs`, `isLoading`, `error`, `statuses` (Filter-Set), `toggleStatus`, `resetStatuses`, `refresh`, `loadMore`, `hasMore`, `autoRefresh`, `setAutoRefresh`.
- I18n via `useI18n()`.
- Status-Mapping lokal: `STATUS_META` mit Tailwind-Klassen pro Status.
- Helpers: `formatRelative` (für `<60m` → `Xm`, `<24h` → `Xh Ym`, sonst `Xd`), `formatDateTime` (de-DE-Format).
- `getPayloadSummary(job)` / `getResultSummary(job)` lokal — extrahiert Barcode/File-Count und Result-Produktnamen.

## Wichtige Edge-Cases

- **Empty-State**: keine Jobs → leerer State.
- **Loading**: `Spinner` von [components/Spinner.tsx](../../../components/Spinner.tsx).
- **Error**: Inline-Banner; Retry-Button per Job.
- **Auto-Refresh**: Default aus, User kann aktivieren — Polling-Intervall im Hook konfiguriert.
- **Pagination**: `loadMore` / `hasMore`-Pattern; kein Infinite-Scroll, manueller Button.
- **Failed-Jobs**: Retry triggert `retryIdentificationJob`, der intern den Job erneut in die Queue stellt.
- **Health-Tile-Window**: `hours`-Parameter (Default in Component) bestimmt das Aggregations-Fenster.
- **Mobile**: kein dedizierter Mobile-View — Listen-Layout auf Mobile vertikal stapelbar.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-091** Multi-Identify hängt bei vielen Produkten — kein Timeout, kein Progress (P0, Code-Fix implementiert mit Concurrency 3 + Phase-Progress + Cloud-Run-Timeout 600s, Deploy ausstehend). Symptom in der Queue: lang laufende `processing`-Jobs ohne Update.
- **BUG-079** Multi-Identify liefert nur letztes Produkt (✅ gefixt).
