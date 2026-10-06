---
title: API — Druckstation Protokoll 2
for: [dev, agent, admin]
lastReviewed: 2026-10-07
---

# Druckstation

Quelle: `backend/routes/print.js`, Mount `/api`, bestehende Auth/RBAC. Tenant ausschließlich aus `req.user` mit Bestandsfallback `default`.

| Endpunkt | Recht | Vertrag |
|---|---|---|
| GET `/print/status` | orders:read | `enabled`, `online`, `agents`, `protocolVersion:2`; nur frische Heartbeats mit Protokoll 2 zählen online. |
| POST `/print/jobs` | orders:ship | `{orderId, shipmentId?, copies?, reprintId?}`; tenantgeprüfte gültige Sendung, initial idempotent je Tenant/Shipment. |
| GET `/print/jobs/:jobId` | orders:read | Tenantgeprüfter Jobstatus. `done` bedeutet an CUPS übergeben. |
| POST `/print/agent/heartbeat` | orders:ship | `{agentId, printers, protocolVersion:2}`; Agent-ID tenantgehasht gespeichert. |
| POST `/print/agent/claim` | orders:ship | `{agentId, protocolVersion:2}`; atomarer Claim mit UID und `claimToken`; alte Agenten HTTP 426. |
| GET `/print/jobs/:jobId/document` | orders:read | Tenantgeprüftes bestehendes Label, vorhandene Rollenformatlogik. Stornierte/unbrauchbare Sendungen werden abgelehnt. |
| POST `/print/jobs/:jobId/result` | orders:ship | `{agentId, claimToken, action:'begin'}` vor CUPS; anschließend `{agentId, claimToken, ok:true, spoolId}` oder `{..., ok:false, error}`. Falsche Zuordnung HTTP 409. |

Fehler vor der Übergabe dürfen gemäß bestehendem Backoff erneut versucht werden. Fehler nach `dispatching` werden `uncertain`. Es gibt keinen automatischen Stationswechsel nach möglicher physischer Ausgabe. Erfolgsquittungen sind wiederholbar. Neue Felder sind additiv; es gibt keine Datenmigration.

[Druckvertrag und Wiederanlauf](../06-features/handheld-pick-pack.md#druckvertrag).
