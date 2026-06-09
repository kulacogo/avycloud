---
title: Rules and Invariants — Die 13 Nicht-Verhandelbaren
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Rules and Invariants

> **Mirror der 13 nicht-verhandelbaren Regeln aus [CLAUDE.md](../../../CLAUDE.md).** Bei Konflikt gewinnt [CLAUDE.md](../../../CLAUDE.md).

## Goldene Regel

**Production darf NIEMALS negativ beeinflusst werden.** Kein Breaking Change. Kein Datenverlust. Kein Downtime.

## Die 13 Nicht-Verhandelbaren

### 1. Keine bestehende Route ändern ohne explizite Anweisung

API-Routen unter `/api/*` sind Vertragsfläche zum Frontend (und potenziell externen Konsumenten). Pfad-, Method-, Payload-Änderungen brechen Caller. Erweiterungen sind erlaubt; Modifikationen brauchen Operator-Freigabe.

### 2. Keine Firestore-Felder umbenennen oder löschen — additive only

Firestore ist schemafrei und replicated; Renames sind faktisch nicht-atomar. Neue Felder additiv hinzufügen, alte Felder behalten bis die Konsumenten migriert sind. Detail: [02-architecture/data-layer.md](../02-architecture/data-layer.md).

### 3. Keine Dependencies entfernen

Dependencies in [package.json](../../../package.json) und [backend/package.json](../../../backend/package.json) sind Build-Reproduzierbarkeits-Garantie. Entfernung kann lazy-loaded oder über Re-exports erreicht werden.

### 4. Keine ENV-Vars umbenennen die in CI/CD referenziert werden

ENV-Vars in [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml), [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) und Cloud-Run-Service-Config sind operativ verdrahtet. Umbenennen = Outage. Vollständiger Katalog: [03-development/feature-flags.md](../03-development/feature-flags.md).

### 5. Keine Änderung an Dockerfile, firebase.json, cloudbuild.yaml ohne Anweisung

Protected Zone:

- [backend/Dockerfile](../../../backend/Dockerfile)
- [firebase.json](../../../firebase.json)
- [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml)

Diese Files sind die Deploy-Topologie. Operator-Freigabe Pflicht.

### 6. Keine Änderung an Auth ohne Anweisung

Protected Zone:

- [backend/lib/auth.js](../../../backend/lib/auth.js)
- [backend/lib/rbac.js](../../../backend/lib/rbac.js)

Detail + Schwachstellen: [auth-rules.md](auth-rules.md).

### 7. Alle Produkt-Schreibpfade über `saveProductV2()`

[backend/lib/product-store.js](../../../backend/lib/product-store.js) `saveProductV2()` ist der einzige zugelassene Schreibpfad in `products_v2`. Macht u. a. Dual-Write-Guard, Canonical-ID-Logik, Sanitization. ADR: [02-architecture/adr/0001-products-v2.md](../02-architecture/adr/0001-products-v2.md).

### 8. Alle neuen Queries und Collections mit `tenantId`

Tenant-Propagation ist Pflicht. Detail + Bekannte Drift-Stellen: [tenant-propagation.md](tenant-propagation.md).

### 9. retired middleware ist TABU

Keine neuen Referenzen, Imports, ENV-Vars oder Routen die retired middleware betreffen. Historisch entfernt, soll endgültig weg.

### 10. Oversell-Verbot

Kein Code-Pfad darf `products_v2.inventory.quantity` mutieren ohne `saveProductV2()` UND `emitSyncEvent('stock:changed', …)`. Jede Stock-Mutation MUSS innerhalb < 60 s einen Marketplace-Sync-Versuch triggern. Fehlgeschlagene Syncs MÜSSEN in `stock_operation_failures` landen UND vom Drain-Worker ([backend/services/stock-failure-drain.js](../../../backend/services/stock-failure-drain.js)) automatisch aufgegriffen werden. Incident: SKU-9871561937 (2026-04-23).

Detail: [stock-single-writer.md](stock-single-writer.md), [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md).

### 11. Kein `omsStatus`-Direct-Write

Order-State-Übergänge AUSSCHLIESSLICH über `transitionOrder()` ([backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js)). Direkter `orderRef.update({ omsStatus: ... })` ist verboten — sonst fehlt `order:status_changed`-Event, `_onOrderShipped` läuft nicht, Oversell-Risiko.

Detail: [oms-transitions.md](oms-transitions.md), ADR: [02-architecture/adr/0003-oms-state-machine.md](../02-architecture/adr/0003-oms-state-machine.md).

### 12. Kein In-Memory-Stock-Lock in Produktion

Kritische Stock-Mutationen MÜSSEN durch `withStockLock()` mit Firestore-Backend laufen (`STOCK_LOCK_BACKEND=firestore`). In-Memory-Lock ist nur als Test-Helper erlaubt. **Heutiger Zustand:** [backend/lib/stock-lock.js](../../../backend/lib/stock-lock.js) ist noch 100 % in-memory — Gap E in [TASKS.md](../../../TASKS.md). Mitigation: Cloud Run mit `--min-instances 1` und kein Auto-Scale > 1 betreiben bis Firestore-Lock vorhanden.

### 13. Stock Single Writer Invariant

Für jede physische Einheit `(sku × order)` darf `products_v2.inventory.quantity` während des Order-Lifecycle **GENAU EINMAL** dekrementiert werden. Zwei zugelassene, mutually-exclusive Pfade via `stockDecrementedAt`-Marker:

- **Pfad A — Pick-with-Order**: [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) `bookStockOut` mit `meta.orderId`. MUSS `claimOrderStockDecrementInTx({ by: 'pick' })` in derselben Tx.
- **Pfad B — Ship-Decrement**: [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js) `_onOrderShipped` → `decrementProductByIdOrSku`. NUR wenn Pfad A nicht gelaufen ist.

Detail: [stock-single-writer.md](stock-single-writer.md), ADR: [02-architecture/adr/0002-stock-single-writer.md](../02-architecture/adr/0002-stock-single-writer.md), Sequence-Diagram: [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md). Incident: SKU-0000108900 + SKU-0000041030 (2026-04-29).

## Sub-Dokumente

| Datei | Inhalt |
|-------|--------|
| [stock-single-writer.md](stock-single-writer.md) | Punkte 10, 12, 13 im Detail + Test-Anker. |
| [tenant-propagation.md](tenant-propagation.md) | Punkt 8 + Drift-Stellen. |
| [oms-transitions.md](oms-transitions.md) | Punkt 11 + Bypass-Stellen. |
| [webhook-policies.md](webhook-policies.md) | Signatur-Verifikation + SendCloud Always-200-Policy. |
| [auth-rules.md](auth-rules.md) | Punkt 6 + Schwachstellen-Liste. |

## Wenn du eine Regel brichst

Aus [13-personas/for-coding-agents.md](../13-personas/for-coding-agents.md):

| Regel | Folge bei Verstoß |
|-------|-------------------|
| 7 (saveProductV2 umgangen) | Produktdaten inkonsistent → Sync zu Marketplaces broken. |
| 10 (Stock ohne Event) | Oversell auf eBay/Kaufland → Käufer beschwert sich → finanzieller Schaden. |
| 11 (omsStatus direkt) | Side-Effects fehlen (Invoice, Tracking, Stock-Decrement) → Operations-Chaos. |
| 13 (Double-Decrement) | Bestand fällt unter 0 oder Listings werden fälschlich beendet → Incident. |

## Verweise

- Single-Source-of-Truth: [CLAUDE.md](../../../CLAUDE.md).
- Aktive Tasks und Bugs: [TASKS.md](../../../TASKS.md).
- Agent-Manifest: [AGENTS.md](../../../AGENTS.md).
