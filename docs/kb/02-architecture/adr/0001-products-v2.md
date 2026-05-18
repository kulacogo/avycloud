---
title: ADR-0001 — products_v2 als aktive Produkt-Collection
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# ADR-0001 — `products_v2` als aktive Produkt-Collection

## Status

**Accepted** (umgesetzt). MIG-001 in [TASKS.md](../../../../TASKS.md) ist als ✅ `done` markiert.

## Kontext

Die ursprüngliche Collection `products` wuchs über Jahre organisch und enthielt:
- Inkonsistente Dokument-IDs (UUIDs, EANs, frei vergebene Strings).
- Mehrfach-Schreiber ohne gemeinsamen Sanitizer.
- Geister-Dokumente (UUID als Titel, EAN als Titel, „Unbekanntes Produkt" — Bug **BUG-082** in [TASKS.md](../../../../TASKS.md), ~1.084 Datensätze).
- Inkonsistente Felder zwischen Marketplace-Sync, Identify-Output und manuellen UI-Edits.

Aus dem Schreibpfad heraus ließ sich kein konsistentes Datenmodell mehr erzwingen, ohne den heutigen Lese-Pfad zu brechen.

## Entscheidung

1. **Neue Collection `products_v2`** als alleiniger zukünftiger Schreib- und Lese-Pfad.
2. **Single Writer**: `saveProductV2()` in [backend/lib/product-store.js](../../../../backend/lib/product-store.js) — Punkt 7 [CLAUDE.md](../../../../CLAUDE.md).
3. **Feature-Flag** `USE_PRODUCTS_V2=true`, gehärtet im Cloud-Build durch `--update-env-vars USE_PRODUCTS_V2=true` ([backend/cloudbuild.yaml](../../../../backend/cloudbuild.yaml)).
4. **Lesepfad-Migration** (MIG-001): alle Reads inkl. Warehouse, Sync, Dashboards greifen auf `products_v2`. Warehouse läuft im Dual-Write während der Transition (`products_v2` Primary, `products` als Schatten).
5. **Canonical-ID-Logik** im Schreibpfad: `pickProductId()` + `_pickCanonicalId()` in [backend/lib/product-canonical.js](../../../../backend/lib/product-canonical.js) hieven u. a. EAN-basierte IDs. Bekannter Folge-Bug **BUG-085** (Dual-Write-Duplikate) bereits gefixt durch:
   - Dual-Write Guard in `product-store.js` (Skip wenn Source-Collection = Ziel-Collection).
   - Cleanup-Script [backend/scripts/dedupe-products-v2.js](../../../../backend/scripts/dedupe-products-v2.js).
   - `_pickCanonicalId` speichert Ergebnis nur als `ops._canonicalId`, ändert nicht die Dokument-ID.

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Saubere Single-Writer-Disziplin. | `products`-Collection bleibt parallel — Cleanup pending. |
| Quality-Gate kann konsistent erzwungen werden. | Indexes mussten neu angelegt werden (siehe [firestore.indexes.json](../../../../firestore.indexes.json) `products_v2`-Indizes). |
| `tenantId`-Feld konsequent additiv hinzugefügt. | Migration-Skripte (z. B. Audit-Ghost-Produkte) müssen pro Tenant + pro Collection-Variante laufen. |

## Verwandte Bugs / Tasks

- **BUG-081** „products noch Primary Read" → ✅ gefixt durch MIG-001.
- **BUG-082** ~1.084 Geister-Produkte → Audit-Script [backend/scripts/audit-ghost-products.js](../../../../backend/scripts/audit-ghost-products.js), Cleanup pending.
- **BUG-084** Dual-Write las falsche Collection (`PRODUCTS_COLLECTION` statt `COLLECTION`) → ✅ gefixt.
- **BUG-085** Dual-Write-Duplikate via `_pickCanonicalId` → ✅ Code-Fix, Deploy + `dedupe-products-v2.js --apply` pending.

## Code-Anker

- Single Writer: [backend/lib/product-store.js](../../../../backend/lib/product-store.js).
- Collection-Resolver: [backend/lib/firestore.js](../../../../backend/lib/firestore.js) Z. 98–100.
- Canonical-ID: [backend/lib/product-canonical.js](../../../../backend/lib/product-canonical.js).
- Audit / Cleanup: [backend/scripts/audit-ghost-products.js](../../../../backend/scripts/audit-ghost-products.js), [backend/scripts/dedupe-products-v2.js](../../../../backend/scripts/dedupe-products-v2.js).

## Querverweise

- Data-Layer-Überblick: [../data-layer.md](../data-layer.md).
- Rules-Anker: [../../11-rules-and-invariants/README.md](../../11-rules-and-invariants/README.md) Punkt 7.
