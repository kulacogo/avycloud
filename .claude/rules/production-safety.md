---
paths:
  - "backend/routes/**"
  - "backend/index.js"
  - "backend/lib/auth.js"
  - "backend/lib/rbac.js"
  - "backend/lib/firestore.js"
  - "backend/lib/product-store.js"
  - "backend/lib/product-canonical.js"
  - "Dockerfile"
  - "cloudbuild.yaml"
  - "firebase.json"
  - ".firebaserc"
  - ".github/workflows/**"
---

# Production Safety — STOP und fragen

Diese Dateien sind Production-kritisch. Änderungen nur mit expliziter Anweisung.

## Red Zone (NIEMALS ohne Approval)
- Dockerfile, cloudbuild.yaml, firebase.json, .firebaserc, .github/workflows/*
- backend/lib/auth.js, backend/lib/rbac.js
- backend/index.js (require-Pfade)
- .env*

## Yellow Zone (Vorsicht, Review nötig)
- backend/routes/*.js (live Endpoints)
- backend/lib/product-store.js, product-canonical.js, firestore.js
- backend/lib/ebay-*.js, kaufland-*.js, sendcloud.js, sevdesk.js, gemini*.js
- backend/services/order-state-machine.js, sync-event-bus.js, marketplace-tracking.js
- App.tsx (Routing), context/*.tsx, api/client.ts

## Regeln
- Keine Firestore-Felder umbenennen oder löschen
- Keine Dependencies entfernen
- Keine ENV-Vars umbenennen die in CI/CD stehen
- Bei Unsicherheit: STOPPEN und fragen
