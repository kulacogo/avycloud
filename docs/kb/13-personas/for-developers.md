---
title: AvyCloud für Developer
for: [dev]
lastReviewed: 2026-05-18
---

# AvyCloud für Developer

## Day 1 — Setup

1. **Repo klonen**: `git clone <repo> && cd avycloud`
2. **Frontend-Deps**: `npm install`
3. **Backend-Deps**: `cd backend && npm install`
4. **Env**: kopiere `.env.example` zu `.env.local`, fülle Werte (Firebase, Gemini, GCP-Project)
5. **Dev-Server**: `npm run dev` (Frontend) und `cd backend && npm start` (Backend)
6. **Tests laufen**: `cd backend && npm test`

Detail: [03-development/getting-started.md](../03-development/getting-started.md).

## Day 2 — Architektur verstehen

- [02-architecture/system-overview.md](../02-architecture/system-overview.md) — Big Picture
- [02-architecture/data-layer.md](../02-architecture/data-layer.md) — Firestore-Collections
- [02-architecture/eventing.md](../02-architecture/eventing.md) — Sync-Event-Bus
- [10-data/firestore-collections.md](../10-data/firestore-collections.md) — Alle Collections mit Writer/Reader

## Day 3 — Code-Style + Tests

- [03-development/code-style.md](../03-development/code-style.md)
- [03-development/testing.md](../03-development/testing.md)
- [03-development/commit-workflow.md](../03-development/commit-workflow.md)

## Tägliche Referenz

- **API-Endpoints**: [09-api/](../09-api/)
- **Pages-zu-Komponenten-Map**: [05-pages/README.md](../05-pages/README.md)
- **Feature-Flags**: [03-development/feature-flags.md](../03-development/feature-flags.md)
- **Nicht-verhandelbar**: [11-rules-and-invariants/README.md](../11-rules-and-invariants/README.md)

## Debugging

- Cloud-Run-Logs: `gcloud logging tail` (siehe [03-development/debugging.md](../03-development/debugging.md))
- Frontend-Errors: Browser-Console + ErrorBoundary
- Test-Failures: `cd backend && npm test -- --reporter=verbose`

## Deploy

Siehe [04-deployment/](../04-deployment/). Kurz: Push auf `main` triggert beide Deploys.
