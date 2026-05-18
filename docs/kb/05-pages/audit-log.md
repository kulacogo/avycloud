---
title: Audit Log
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Operativer Audit-Trail: zeigt alle relevanten System-Events (Produkt-Mutationen, Stock-Bewegungen, Order-Transitions, Auth-Events, Admin-Aktionen) in chronologischer Reihenfolge. Mit Sub-Tab für **User-Sessions** (aktive/historische Logins für Tenant-Admin-Aufsicht).

## Komponente(n)

- [components/AuditLogView.tsx](../../../components/AuditLogView.tsx) — Main-View mit `Tabs` (Audit-Log + User-Sessions).
- [components/UserSessionsTab.tsx](../../../components/UserSessionsTab.tsx) — Sub-Tab User-Sessions.

## API-Calls

AuditLogView:
- `fetchAuditLog(params)` — `/api/audit-log` (oder Äquivalent). Liefert `AuditLogEntry[]`.

UserSessionsTab:
- `fetchSessions(params)` — Historische Sessions.
- `fetchActiveSessions()` — Aktuelle Live-Sessions.

Pro-Endpunkt-Doku: `docs/kb/09-api/audit.md`, `docs/kb/09-api/auth.md` (TBD).

## Datenquellen

- Lokaler `useState` für `entries`/`sessions`.
- `useToast` für UX.
- Lokale Helpers: `formatDuration`, `formatTimestamp`, `timeAgo` (in UserSessionsTab).

## Wichtige Edge-Cases

- **Empty-State**: keine Einträge → leerer State mit Hinweis (z. B. „Audit-Log noch leer").
- **Loading**: lokaler Spinner pro Tab.
- **Error**: Toast bei API-Fehler.
- **Large Volume**: bei vielen Events kann die Tabelle lang sein — Pagination/Filter Backend-seitig empfohlen (Stand 2026-05-18: client-seitige Limit-Filter im View).
- **Sensitive Daten**: User-Sessions können IP-Adressen + User-Agent enthalten — GDPR-relevant, nur Admin-Rolle sieht Vollansicht.
- **Mobile**: kein dedizierter Mobile-View.

## Bekannte Issues

Keine offenen Bugs in [TASKS.md](../../../TASKS.md) speziell für Audit-Log (Stand 2026-05-18).
