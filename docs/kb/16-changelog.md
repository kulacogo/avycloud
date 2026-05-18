---
title: KB Changelog
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Knowledge Base Changelog

## 2026-05-18 — Initial KB-Setup (Big Bang)

### Foundation
- `AGENTS.md` im Repo-Root als Coding-Agent-Pflichtlektüre
- `CLAUDE.md` Session-Start additiv erweitert (Punkte 1+2 zeigen auf AGENTS + KB)
- `docs/kb/00-INDEX.md` Master-Navigation für alle Personas

### Personas (13)
- `for-coding-agents.md` — pflichtgelesen, Pre/Post-Flight-Checks
- `for-users.md` — Endanwender-Map
- `for-developers.md` — Day-1 bis Day-30
- `for-admins.md` — Operator-Aktionen, RBAC, Skripte
- `for-managers.md` — Roadmap, Strategie, Metriken

### KB-Sektionen (alle 17 angelegt, 135 Markdown-Dateien)
- `01-overview/` (3 Dateien) — Was AvyCloud ist, Glossar, Personas
- `02-architecture/` (8 Dateien + 6 ADRs) — System, Frontend, Backend, Daten, Auth, Multi-Tenancy, Eventing
- `03-development/` (7 Dateien) — Setup, Code-Style, Tests, Commit-Workflow, Feature-Flags (39 ENV-Vars katalogisiert), Debugging
- `04-deployment/` (5 Dateien) — Frontend-Deploy, Backend-Deploy, CI/CD, Rollback, ENV-Vars
- `05-pages/` (19 Dateien) — eine MD pro UI-View
- `06-features/` (17 Dateien) — eine MD pro Feature
- `07-llm/` (9 Dateien) — Models, Pipelines, Tools, Caching, Telemetrie, Cost, Flags
- `08-integrations/` (10 Dateien) — eBay, Kaufland, SendCloud, SevDesk, Firebase, Gemini, SerpAPI, BrightData, Webhook-Signing
- `09-api/` (17 Dateien) — eine MD pro Route-File mit allen Endpoints
- `10-data/` (10 Dateien) — Collection-Inventar, Indexes, 7 Schema-Files
- `11-rules-and-invariants/` (6 Dateien) — Mirror der CLAUDE.md-Regeln
- `12-runbooks/` (2 Dateien) — Index + Incident-Template
- `13-personas/` (5 Dateien) — Persona-Entry-Points
- `14-faq.md`, `15-gap-analysis.md`, `16-changelog.md`, `17-cleanup-report.md`

### Audit-Skripte (7 read-only)
- `backend/scripts/audit-repo-cruft.js` — 3592 Findings (24 BaseLinker-Skripte, 2 enrichment_backup.js, 634 Binary-Docs)
- `backend/scripts/audit-firestore-cruft.js` — 19 von 55 Collections POTENTIALLY_DEAD
- `backend/scripts/audit-gcs-cruft.js` — 8 Buckets, 7 STALE-Prefixes
- `backend/scripts/audit-cloud-run.js` — `product-hub-backend` mit 50 Revisionen
- `backend/scripts/audit-deps.js` — framer-motion DEAD, node-fetch + p-limit ERROR
- `backend/scripts/audit-kb-coverage.js` — Cross-Check für Drift-Protection
- `backend/scripts/audit-flags-extended.js` — 424 ENV-Vars im Code, 53 Production-Flags in KB dokumentiert

Reports unter `docs/kb/_audit-runs/<script>-2026-05-18.md`.

### UI Help-Drawer (live)
- `backend/routes/help.js` — `/api/help/index`, `/api/help/articles`, `/api/help/articles/:slug(*)` mit 60s-Cache + Path-Traversal-Guard
- `backend/__tests__/api/help.test.js` — 12 Tests, 12 passing
- `api/help.ts` — Frontend-Client mit Persona-aware Loader
- `components/help/HelpDrawer.tsx` — Side-Drawer mit Suche, Persona-Filter, react-markdown + remark-gfm
- `components/help/HelpProvider.tsx` — Event-Listener für `#help=<slug>`-Permalinks
- `components/help/HelpButton.tsx` — Floating Bottom-Right `?`-Button
- `index.tsx` additive: 2 Imports + 2 JSX-Tags

### CI Drift-Protection
- `.github/workflows/kb-drift-and-tests.yml` — drei Jobs: backend-tests (vitest), frontend-build-and-typecheck (`tsc --noEmit` + vite build), kb-coverage (audit-Skripte als Pre-Merge-Gate für NEUE Routen/Views)

### KB-Coverage-Verbesserung (vorher → nachher)
- Documented Items: **21 → 87** (+66)
- Missing Items: **85 → 20** (-65)
- ENV-Flag Coverage: **0 / 53 → 53 / 53** (alle dokumentiert!)
- Feature-Coverage: hat sich verbessert nach Anlage von `docs/kb/06-features/*` (17 neue Files)
- API-Coverage: hat sich verbessert nach Anlage von `docs/kb/09-api/*` (16 neue Files)

### Baseline-Garantien
- Backend Tests: **1970 / 1970 passing** (1953 vor KB-Setup, +17 neue)
- Frontend Build: **green** (4.47s)
- Keine Source-Files modifiziert außer dokumentierten additiven Mounts (backend/index.js, index.tsx, package.json deps)
- Keine Protected Zones berührt (auth, Dockerfile, cloudbuild.yaml, firebase.json unverändert)
