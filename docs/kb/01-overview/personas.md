---
title: Personas
for: [user, dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Personas

> Konsolidierte Persona-Sicht aus [13-personas/](../13-personas/). Jede Persona hat ihren eigenen Einstiegspunkt in der KB — diese Datei fasst Goals, Pain-Points und Daily-Tasks zusammen, damit Architektur-Entscheidungen die richtige Zielgruppe vor Augen haben.

## User — Endanwender im Händler-Team

Quelle: [13-personas/for-users.md](../13-personas/for-users.md).

| Aspekt | Inhalt |
|--------|--------|
| **Goal** | Schnell ein Produkt erfassen, sauber listen, Bestellungen abarbeiten, Versand erledigen, Retouren bearbeiten. |
| **Pain-Points** | Tool-Wechsel zwischen PIM / Marktplatz / Versand kosten Zeit. Manuelle Datenpflege ist fehleranfällig (Aspect-Pflicht, GPSR). |
| **Daily-Tasks** | „Erfassen" mit Bildern, „Inventar" durchsehen, „Bestellungen" abarbeiten (Pick → Pack → Ship), „Retouren" bearbeiten, „Rechnungen" prüfen. |
| **UI-Bereiche** | Erfassen, Inventar, Stammdaten / Datenblatt, Bestellungen, Versand, Retouren, Rechnungen, Lager, Marketplace, Chat. |
| **Hilfe-Pfad** | Hilfe-Button in der App öffnet diese KB im Drawer; Detail-Pages unter [05-pages/](../05-pages/). |

## Developer — Code-Beitragende

Quelle: [13-personas/for-developers.md](../13-personas/for-developers.md).

| Aspekt | Inhalt |
|--------|--------|
| **Goal** | Features sicher liefern, ohne Production zu brechen, ohne Invarianten zu verletzen. |
| **Pain-Points** | Komplexes Datenmodell, viele in-process Cron-Loops, Multi-Tenant noch nicht voll durchgezogen, Test-Suite muss vor PR grün sein. |
| **Daily-Tasks** | Branch erstellen, Tests schreiben, `cd backend && npm test`, `npm run build`, Commit, PR. |
| **Wichtige Referenzen** | [02-architecture/system-overview.md](../02-architecture/system-overview.md), [03-development/code-style.md](../03-development/code-style.md), [11-rules-and-invariants/README.md](../11-rules-and-invariants/README.md). |

## Coding-Agent — AI Pair-Programmer

Quelle: [13-personas/for-coding-agents.md](../13-personas/for-coding-agents.md) (Pflichtlektüre).

| Aspekt | Inhalt |
|--------|--------|
| **Goal** | Sauberes, dokumentiertes Coding, das die 13 Nicht-Verhandelbaren respektiert. |
| **Pain-Points** | Versteckte Protected Zones (Auth, Dockerfile, cloudbuild.yaml), implizite Invarianten (Stock Single Writer, OMS-Transition). |
| **Daily-Tasks** | KB lesen → Pre-Flight-Checklist → Code + Test → Post-Flight → Commit (nur bei expliziter User-Anweisung). |
| **Verboten** | Force-Push auf `main`, BaseLinker-Referenzen, Direct-Writes auf `inventory.quantity` oder `omsStatus`, Raten ohne Doku. |

## Admin / Operator

Quelle: [13-personas/for-admins.md](../13-personas/for-admins.md).

| Aspekt | Inhalt |
|--------|--------|
| **Goal** | System gesund halten, Drift reparieren, Bulk-Aktionen sicher ausführen, Incidents managen. |
| **Pain-Points** | Manuelle Reparatur-Skripte (Ghost-Produkte, Double-Decrement), Drift zwischen Marktplatz und lokalem Bestand, Multi-Tenant-Fan-Out per ENV-Var. |
| **Daily-Tasks** | Cloud-Run-Logs prüfen, `audit-*.js`-Skripte im Dry-Run laufen, Integrations-Credentials in Settings pflegen, Audit-Log einsehen, Bulk-Recategorize. |
| **Tools** | `backend/scripts/audit-ghost-products.js`, `backend/scripts/dedupe-products-v2.js`, `backend/scripts/repair-double-decrement.js`, [09-api/admin.md](../09-api/admin.md). |

## Manager / Stakeholder

Quelle: [13-personas/for-managers.md](../13-personas/for-managers.md).

| Aspekt | Inhalt |
|--------|--------|
| **Goal** | Roadmap-Fortschritt sehen, Kosten/Qualität überblicken, Architektur-Entscheidungen nachvollziehen. |
| **Pain-Points** | Roadmap und tatsächlicher Status weichen manchmal voneinander ab — Gap-Analyse hilft. |
| **Daily-Tasks** | Status aus [TASKS.md](../../../TASKS.md) lesen, [15-gap-analysis.md](../15-gap-analysis.md) checken, LLM-Kosten via Cloud-Billing prüfen. |
| **Wichtige Referenzen** | [archivierte Roadmap](../../archive/product-strategy/roadmaps/roadmap.md), [02-architecture/adr/](../02-architecture/adr/). |

## Persona-Matrix (was wer wo liest)

| Bereich | User | Developer | Agent | Admin | Manager |
|---------|------|-----------|-------|-------|---------|
| `01-overview` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `02-architecture` | – | ✅ | ✅ | ✅ | ✅ (ADRs) |
| `03-development` | – | ✅ | ✅ | – | – |
| `04-deployment` | – | ✅ | ✅ | ✅ | – |
| `05-pages` | ✅ | ✅ | ✅ | ✅ | – |
| `09-api` | – | ✅ | ✅ | ✅ | – |
| `11-rules-and-invariants` | – | ✅ | ✅ (Pflicht) | ✅ | – |
| `12-runbooks` | – | – | – | ✅ | – |
