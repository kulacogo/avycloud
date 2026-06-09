---
title: AvyCloud für Coding-Agents — Pflichtlektüre
for: [agent]
lastReviewed: 2026-05-18
---

# AvyCloud für Coding-Agents

> **MUSS gelesen werden bei jeder neuen Session, bevor du Code anfasst.**
> Wenn du diese Datei nicht gelesen hast, brichst du mit hoher Wahrscheinlichkeit eine Invariante und verursachst Datenkorruption, Oversell oder Downtime.

## Was AvyCloud ist (in 3 Sätzen)

AvyCloud ist eine **Multi-Channel-E-Commerce-Plattform für KMU** (50–5000 SKUs) im DACH-Raum. Sie automatisiert KI-gestützte Produktanlage (Identify), Listings auf eBay/Kaufland, Lagerverwaltung mit BINs, Order-Lifecycle, Versand über SendCloud und Rechnungen über SevDesk. **Goldene Regel: Production darf NIEMALS negativ beeinflusst werden.**

## Tech-Stack (Snapshot)

- **Frontend**: React 18 + TypeScript + Vite + Tailwind → Firebase Hosting
- **Backend**: Node.js 20 + Express (CommonJS) → Cloud Run (`europe-west3`)
- **DB**: Firestore (Collection: `products_v2`, `USE_PRODUCTS_V2=true`)
- **KI**: Google Gemini API (V3.1 Pro für Chat, V3 Flash für Intent)
- **Auth**: Firebase Authentication + RBAC (`backend/lib/rbac.js`)
- **Deployment**: Push auf `main` → GitHub Actions (Frontend) + Cloud Build (Backend)

## Die 13 Nicht-Verhandelbaren (PFLICHT)

Vollständig in [CLAUDE.md](../../../CLAUDE.md). Kurz:

1. Keine bestehende Route ändern ohne explizite Anweisung.
2. Keine Firestore-Felder umbenennen oder löschen — **additive only**.
3. Keine Dependencies entfernen.
4. Keine ENV-Vars umbenennen die in CI/CD referenziert werden.
5. Keine Änderung an `Dockerfile`, `firebase.json`, `cloudbuild.yaml` ohne Anweisung.
6. Keine Änderung an [backend/lib/auth.js](../../../backend/lib/auth.js), [backend/lib/rbac.js](../../../backend/lib/rbac.js) ohne Anweisung.
7. Alle Produkt-Schreibpfade über `saveProductV2()` in [backend/lib/product-store.js](../../../backend/lib/product-store.js).
8. Alle neuen Queries und Collections mit `tenantId`.
9. **retired middleware ist TABU** — keine neuen Referenzen, Imports oder ENV-Vars.
10. **Oversell-Verbot**: keine `products_v2.inventory.quantity`-Mutation ohne `saveProductV2()` UND `emitSyncEvent('stock:changed', …)`.
11. **Kein `omsStatus`-Direct-Write** — Order-State-Übergänge AUSSCHLIESSLICH über `transitionOrder()` in [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js).
12. **Kein In-Memory-Stock-Lock** in Produktion — `withStockLock()` mit Firestore-Backend.
13. **Stock Single Writer Invariant** — jede physische Einheit darf während des Order-Lifecycle GENAU EINMAL dekrementiert werden (Pfad A: pick-with-order; Pfad B: ship-decrement; mutually exclusive via `stockDecrementedAt`-Marker).

## Protected Zones (nie ändern ohne explizite Anweisung)

| Pfad | Warum geschützt |
|------|-----------------|
| `backend/lib/auth.js` | JWT-Verifikation, Tenant-Resolution |
| `backend/lib/rbac.js` | Permission-Modell |
| `backend/Dockerfile` | Container-Image, Cloud-Run-Bindings |
| `firebase.json` | Hosting-Routes, Firestore-Rules |
| `backend/cloudbuild.yaml` | Build-Pipeline + Cloud-Run-Deploy |
| `.github/workflows/firebase-hosting.yml` | Frontend-Deploy-Trigger |
| `firestore.indexes.json` | Composite-Indexes (Loeschung kostet Re-Build-Zeit) |

## Code-Stil (kurz)

- **Backend**: CommonJS (`require`/`module.exports`), 2 Spaces, Single Quotes, async/await, strukturierter Error in try/catch.
- **Frontend**: TypeScript ESM, 2 Spaces, Double Quotes, Functional Components + Hooks.
- **UI-Farben**: Nur Design-Tokens (`bg-accent`, nicht `bg-blue-500`). Siehe [styles/main.css](../../../styles/main.css).
- **Tests**: Vitest. Jede neue Funktion braucht min. 1 Test.
- **Git**: Conventional Commits (`feat:`, `fix:`, `refactor:`).

## Pre-Flight Checklist (vor jedem Edit-Tool-Call)

- [ ] Habe ich [CLAUDE.md](../../../CLAUDE.md) und relevante KB-Seiten in dieser Session gelesen?
- [ ] Berühre ich eine Protected Zone? Wenn ja → STOP, frage den User.
- [ ] Mutiere ich Stock, OMS-Status, oder einen Webhook-Handler? Lese [11-rules-and-invariants/README.md](../11-rules-and-invariants/README.md).
- [ ] Schreibe ich neuen Code? Dann brauchst du auch einen neuen Test.
- [ ] Neue Route/Page/Feature? Dann auch KB-Eintrag in `09-api/`, `05-pages/`, `06-features/`.

## Post-Flight Checklist (vor Commit)

- [ ] `cd backend && npm test` grün.
- [ ] `npm run build` grün (Frontend-Änderungen).
- [ ] Kein direktes `tx.update(productRef, { 'inventory.quantity': X })` außerhalb [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) / [backend/lib/product-store.js](../../../backend/lib/product-store.js).
- [ ] Kein direktes `orderRef.update({ omsStatus: ... })` außerhalb [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js).
- [ ] Jede neue ENV-Var in [03-development/feature-flags.md](../03-development/feature-flags.md) dokumentiert.
- [ ] Conventional Commit Message.

## Wie man entwickelt (Standard-Workflow)

```bash
# 1. Branch erstellen
git checkout -b feat/<name> main

# 2. Code + Test schreiben
# 3. Backend-Tests
cd backend && npm test

# 4. Frontend-Build prüfen
cd .. && npm run build

# 5. Commit (Conventional Commits)
git add . && git commit -m "feat: add foo"

# 6. Push + PR
git push -u origin HEAD
gh pr create --title "feat: ..." --body "..."
```

**Wer merged**: nur der User oder ein expliziter Operator. Coding-Agents erstellen Commits/PRs, mergen NIE eigenständig auf `main`.

## Wie deployt wird

- **Frontend**: Push auf `main` → GitHub Actions führt `npm run build` aus → deployt auf Firebase Hosting.
- **Backend**: Push auf `main` → Cloud Build baut Docker-Image → deployt auf Cloud Run (`europe-west3`).
- **Rollback**: siehe [04-deployment/rollback.md](../04-deployment/rollback.md).

## Was du tun SOLLST

- **Lies vor Code**. Erst die Doku zur betroffenen Datei/Feature, dann implementiere.
- **Stelle Rückfragen** wenn etwas unklar ist. Lieber 1 Minute fragen als 1 Stunde reparieren.
- **Schreibe Tests** für jede neue Funktion (mindestens 1).
- **Dokumentiere** in der KB, wenn du etwas Neues baust.

## Was du NICHT tun darfst

- **Nicht raten**. Wenn die offizielle Doku fehlt, frage den User oder hol sie via Context7.
- **Keine erfundenen Endpunkte, Pfade, Parameter, Header.**
- **Keine "wird schon so ähnlich sein"-Lösungen.**
- **Keine stillen Annahmen** wenn Informationen fehlen.
- **Keine Force-Pushes**, keine `git rebase -i`, keine destruktiven Git-Operationen.

## Wenn du gegen eine Invariante verstößt — was passiert?

- **Punkt 7 (saveProductV2 umgangen)**: Produktdaten inkonsistent → Sync zu Marketplaces broken.
- **Punkt 10 (Stock ohne Event)**: Oversell auf eBay/Kaufland → Käufer beschwert sich → finanzieller Schaden.
- **Punkt 11 (omsStatus direkt)**: Side-Effects fehlen (Invoice, Tracking, Stock-Decrement) → Operationaler Chaos.
- **Punkt 13 (Double-Decrement)**: Bestand fällt unter 0 oder Listings werden fälschlich beendet → Incident.

Echte Incidents aus der Vergangenheit: SKU-9871561937 (2026-04-23), SKU-0000108900 + SKU-0000041030 (2026-04-29). Siehe [12-runbooks/](../12-runbooks/).

## Wo du dich vertieft

- Tieferes Architektur-Verständnis: [02-architecture/system-overview.md](../02-architecture/system-overview.md).
- Order-Lifecycle Sequenz: [02-architecture/eventing.md](../02-architecture/eventing.md).
- Stock-Single-Writer Detail: [11-rules-and-invariants/stock-single-writer.md](../11-rules-and-invariants/stock-single-writer.md).
- LLM-Pipelines: [07-llm/pipelines.md](../07-llm/pipelines.md).

---

**Wenn du diese Datei gelesen hast, bist du bereit. Halte dich an die Regeln. Wenn du unsicher bist: frage.**
