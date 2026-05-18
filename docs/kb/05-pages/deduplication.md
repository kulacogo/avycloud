---
title: Deduplication (Dubletten-Erkennung)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Findet und mergt Produkt-Dubletten in `products_v2`. Drei Erkennungstypen: **EAN/Barcode**, **MPN**, **Marke + Name**. Listet Dubletten-Gruppen, zeigt einen Merge-Vorschlag pro Paar (`fetchMergeSuggestion`) und führt das Merge nach Bestätigung aus (`executeMerge` — non-canonical IDs werden ge-soft-deleted, History via `inventory_ledger`).

## Komponente(n)

- [components/DeduplicationView.tsx](../../../components/DeduplicationView.tsx) — Single-File-View mit `Card`/`Modal`-UI für Gruppen und Merge-Wizard.

## API-Calls

- `fetchDuplicates()` — `/api/products/duplicates` (oder Äquivalent). Liefert `DuplicateGroup[]` mit `totalProducts`-Count.
- `fetchMergeSuggestion(idA, idB)` — Field-by-Field-Merge-Vorschlag (`MergeSuggestion`).
- `executeMerge(payload)` — Merge ausführen (Cononical-ID gewinnt, Rest wird referenziert).

Pro-Endpunkt-Doku: `docs/kb/09-api/dedup.md` (TBD).

## Datenquellen

- Lokaler `useState` (`groups`, `loading`, `totalProducts`).
- `useToast` für UX-Feedback.
- Type-Mapping lokal: `TYPE_LABELS` (`ean: "EAN / Barcode"`, `mpn: "MPN"`, `brand_name: "Marke + Name"`), `TYPE_VARIANTS` für Badge-Farben.

## Wichtige Edge-Cases

- **Empty-State**: keine Dubletten → Positive Empty-State ("Alles sauber").
- **Loading**: lokaler Spinner.
- **Error**: Toast.
- **Multi-Gruppen-Merge**: Sequentiell durchgeführt — bei Fehler bricht der Merge an dieser Stelle ab, vorherige Merges bleiben persistent.
- **Mobile**: kein dedizierter Mobile-View.
- **CLAUDE.md §13 + §2**: Merges sind **additive** (keine Field-Löschung), und Stock-Daten werden via `lib/warehouse.js` migriert, nicht direkt mutiert.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-082** ~1084 Ghost-Produkte in `products_v2` (P0, offen). Dedup-View hilft sie zu finden, aber der eigentliche Root-Cause liegt im Identify-Save-Pfad (BUG-085 Dual-Write-Duplikate).
- **BUG-085** Dual-Write erzeugt Duplikate durch `_pickCanonicalId` (P0; Code-Fix A+B+C implementiert, Deploy ausstehend).
