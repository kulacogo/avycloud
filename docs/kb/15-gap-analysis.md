---
title: Gap Analysis — Was AvyCloud HAT vs FEHLT
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Gap Analysis

> **Letzter Audit-Lauf:** 2026-05-18
> **Quelle:** [audit-kb-coverage-2026-05-18.md](../archive/audit-runs/2026-05-18/audit-kb-coverage-2026-05-18.md), [audit-flags-extended-2026-05-18.md](../archive/audit-runs/2026-05-18/audit-flags-extended-2026-05-18.md)
> **Komplementär zu:** [17-cleanup-report.md](17-cleanup-report.md) (was zu VIEL ist)

## Methode

`audit-kb-coverage.js` cross-checked:
- Backend-Routen (`backend/routes/*.js`) → KB-Datei in `09-api/`
- Frontend-Views (`components/**/*View.tsx`) → Erwähnung in `05-pages/README.md`
- Feature-Specs (`docs/features/<ID>/spec.md`) → KB-Datei in `06-features/`
- ENV-Vars (aus CLAUDE.md) → Eintrag in `03-development/feature-flags.md`
- Integrationen (aus `backend/lib/integration-registry.js`) → KB-Datei in `08-integrations/`

`audit-flags-extended.js` cross-checked alle ENV-Variablen die im Code via `process.env.X` gelesen werden gegen CLAUDE.md und `cloudbuild.yaml`.

---

## Was AvyCloud HAT (implementiert + dokumentiert)

### Vollständig dokumentiert
- **17 KB-Sektionen** mit 100+ Markdown-Files unter `docs/kb/`
- **Coding-Agent-Mandate** via [AGENTS.md](../../AGENTS.md) + [13-personas/for-coding-agents.md](13-personas/for-coding-agents.md)
- **15 API-Route-Dateien** dokumentiert in [09-api/](09-api/)
- **18 UI-Views** in [05-pages/](05-pages/) mit Komponenten-zu-API-Map
- **17 Features** in [06-features/](06-features/) (Identify V3/V4, Chat V3/V2/Legacy, Pricing, Rules, Bulk, Stock, Orders, Shipping, Returns, Invoices, Warehouse, Audit-Log, Errors, Validation, Recategorize)
- **9 LLM-Bereiche** in [07-llm/](07-llm/) (Models, Pipelines, Tools, Caching, Telemetrie, Cost, Flags)
- **10 Integrationen** in [08-integrations/](08-integrations/)
- **6 ADRs** in [02-architecture/adr/](02-architecture/adr/)
- **Firestore-Schemas** in [10-data/schemas/](10-data/schemas/)
- **6 Rules-and-Invariants-Files** Spiegel von CLAUDE.md
- **7 Audit-Skripte** unter `backend/scripts/audit-*.js`
- **UI Help-Drawer** live in App
- **CI Drift-Protection-Workflow** aktiv

### Implementiert aber nicht (oder unvollständig) dokumentiert

| Item | Typ | Empfehlung |
|------|-----|------------|
| 53 ENV-Flags ohne Eintrag in `feature-flags.md` | env-flag | Komplettieren (Subagent füllte 39 von 53) |
| 15 Feature-Specs ohne KB-Wrapper | feature | KB-Wrapper Datei pro Spec (Auto-Generator?) |
| 12 von 15 Routen brauchen KB-Doku-Update | api | API-Doku-Subagent erledigt — Re-Run zeigt verbesserte Coverage |
| 5 von 7 Integrationen brauchen KB-Doku | integration | Integrations-Subagent erledigt — Re-Run zeigt Verbesserung |
| 14 Firestore-Collections nicht in `10-data/firestore-collections.md` | data | Data-Subagent erledigt; Cross-Check nach Re-Run |

### Im Code aber undokumentiert (Operator-Tuning-Knobs)

`audit-flags-extended.js` fand 424 ENV-Var-Patterns im Backend-Code. Davon sind viele:
- Secrets / Credentials (z.B. API-Keys) — sollten NICHT in KB
- Tuning-Knobs (z.B. `IDENTIFY_GROUNDING_PEAK_RETRY`)
- Test-Hooks (z.B. `NODE_ENV`, `VITE_*`)

**Empfehlung**: KB-Coverage-Check nur auf "Production-Behavior-Flags" aus CLAUDE.md beschränken (53 Stück) — alles andere ist Implementation-Detail.

---

## Was FEHLT (geplant aber nicht implementiert)

### Aus TASKS.md Backlog

| ID | Feature | Prio | Status |
|----|---------|------|--------|
| MP-001 | Amazon SP-API Integration | P1 | Waiting on SP-API Registrierung (2-4 Wochen) |
| MP-002 | OTTO Market Integration | P2 | OPC Portal-Antrag |
| VAR-001 | Variant Model (Parent-Child) | P1 | Spec vorhanden, nicht implementiert |
| IMG-001 | Image Enhancement | P2 | Spec vorhanden, nicht implementiert |
| DASH-001 | Analytics Dashboard | P2 | Spec vorhanden, nicht implementiert |
| UX-001 | Onboarding Wizard | P2 | Spec vorhanden, nicht implementiert |
| WH-002 | Child-BINs / Container | P1 | Prompt ready |
| ADDR-001 | Empfänger-Adresslabel 62×29mm | P1 | Prompt ready |
| PERF-002 | eBay API Rate-Limiting & Call-Optimierung | P0 | Prompt ready |

### Aus dem Hardening-Plan (`/Users/oguz/.cursor/plans/avycloud-deep-dive-hardening_3e075f5e.plan.md`)

| Wave | Was fehlt | Risiko |
|------|-----------|--------|
| Wave 1 | Tenant-Hardcodes raus, eBay-Webhook-Signatur, Kaufland-HMAC-Fix, SSRF-Guard image-proxy, restockItem echter bookStockIn | HIGH |
| Wave 2 | Sync-Bus tenant-keyed, pollDeliveryStatus via transitionOrder, partial-decrement-recovery | MEDIUM |
| Wave 3 | Fehlende Composite-Indexes, TTL-Policies, Bin-Denormalisierung, Pagination | MEDIUM |
| Wave 4 | LLM-Telemetrie aktivieren, prompt-cache wirken lassen, Schema-Strict in Identify-Paths | MEDIUM |
| Wave 5 | Frontend-Datenquellen konsolidieren, OMS-Labels zentral, Code-Splitting | MEDIUM |
| Wave 6 | RBAC-Decorators auf settings/rules/returns, isAdmin-Bypass kontextualisieren | HIGH |
| Wave 7 | Duplikate konsolidieren, Legacy-Scripts archivieren | LOW |
| Wave 8 | Outbox-Pattern als Single Writer | HIGH (strategisch) |

### Aus dem Cleanup-Plan (`/Users/oguz/.cursor/plans/avycloud-cleanup-and-inventory_8c2f887a.plan.md`)

| Wave | Was fehlt | Status |
|------|-----------|--------|
| Wave 7 | BaseLinker-Skripte archivieren | Operator-Approval offen |
| Wave 7 | Binary-Docs aus Repo-Root nach `docs/archive/` | Operator-Approval offen |
| Wave 8 | Firestore-Tote-Collections löschen | Operator-Approval offen |
| Wave 8 | GCS-Lifecycle-Policies | Operator (GCP-Console) |
| Wave 8 | Cloud-Run-Revisions-Prune | Operator |
| Wave 9 | Quarterly-Refresh-Reminder in CI | Erweitern |

---

## Was komplett fehlt (nicht in TASKS, nicht in Hardening, nicht in Cleanup)

Diese Lücken sind erst durch das Multi-Agent-Audit zutage gekommen:

1. **eBay-Kategorie-Cache** (BUG-094): LLM rät Kategorien aus Training-Daten weil kein lokaler Cache existiert. Aktion: `sync-ebay-categories.js`-Skript + `ebay_categories`-Collection + 30-Tage-Refresh-Cron.
2. **Evidence-URL-Validation** (BUG-093): Preis-Links zeigen nicht das Produkt. Aktion: HTTP-Status + Produkt-Matching vor Speicherung.
3. **Returns-Restock-Pfad** verifizieren ob er nach Hardening-Wave-1 tatsächlich Inventory mutiert (heute No-Op).
4. **Multi-Tenant-Activation-Runbook** fehlt (`docs/runbooks/multi-tenant-activation.md` ist in `backend/index.js` referenziert aber nicht vorhanden).
5. **Performance-Profiling Hot-Paths** wie `GET /api/products` mit Full-Bin- und Full-Order-Scan — keine SLO definiert.
6. **Cloud-Run-Service-Status-Monitor** — `audit-cloud-run.js` zeigt 50 Revisionen; kein Alert wenn Service dormant wird.
7. **Mobile-App** (im Backlog "Someday").
8. **GDPR-Tooling** (im Backlog "Someday").
9. **OpenAPI-Spec** für Frontend-Codegen / SDK-Generation (manuell hand-written-API-Doku ist OK, OpenAPI wäre Auto-Sync-Goldilocks-Layer).
10. **E2E-Tests via Playwright** — Dependency ist da aber nicht genutzt.

---

## Vorschlag: nächste 3 Prioritäten

Aus dem Gap zwischen "implementiert" und "geplant + nicht-trivial":

1. **Wave 1 des Hardening-Plans** (P0-Sicherheit + Datenintegrität): das schließt Cross-Tenant-Refund, Webhook-Signaturen, SSRF, Restock-No-Op, Tenant-Hardcodes.
2. **PERF-002 eBay-Rate-Limiting** (TASKS.md P0): Prompt liegt vor.
3. **MP-001 Amazon-SP-API**: Registrierung läuft, parallel Code vorbereiten.

---

## Update-Prozess

Diese Datei wird durch `audit-kb-coverage.js` automatisch aktualisiert (Wave 9). Bei nächstem Lauf:

```bash
node backend/scripts/audit-kb-coverage.js > docs/kb/_audit-runs/audit-kb-coverage-$(date +%Y-%m-%d).md
```

Manuell aktualisiert: 2026-05-18 nach erstem KB-Build-Lauf.
