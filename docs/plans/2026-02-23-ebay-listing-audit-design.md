---
title: "eBay Listing Audit (holistic) + Fast Listed Indicator"
date: "2026-02-23"
status: draft
owners:
  - avycloud
---

## Problem

AvyClouds aktuelle eBay-Seite (`/ebay`) ist primär als **Gegendarstellung AvyCloud ↔ eBay** aufgebaut (Gaps + Vergleichstabellen). Das erfüllt nicht das gewünschte Ziel:

- Das Modul soll **jedes eBay-Listing ganzheitlich** prüfen (Titel/Keywords, Parameter/Aspekte, Bilder, Beschreibung, Preis, Versand, weitere Daten) – mit Fokus: **maximale Sichtbarkeit + Attraktivität für Käufer**.
- Die Seite soll **Qualitätsmängel aufzeigen und Verbesserungen vorschlagen** (nicht “Avy vs eBay” ausspielen).
- Optional sollen Vorschläge **direkt übernommen** werden können („Vorschlag übernehmen → eBay Listing aktualisieren“).

Zusätzlich ist der Indikator „Produkt ist auf eBay gelistet“ im Products-Grid aktuell nicht zuverlässig/aktuell, weil er indirekt von einem teuren “Live Sync + Audit” Lauf abhängt.

## Ziele (Goals)

- **Holistic Audit UX**: Pro Listing ein Audit mit klaren Findings + konkreten Vorschlägen.
- **Actionability**: Vorschläge sollen (wo sicher) direkt auf eBay angewendet werden können.
- **Performance**: „Gelistet“-Indikator im Products-Grid wird durch einen schnellen Light‑Sync aktuell gehalten, ohne dass der Full‑Audit laufen muss.
- **Dokumentierte eBay‑Kompatibilität**: Trading API / Inventory API Restriktionen berücksichtigen (z. B. Revise‑Limit/Restriktionen).

## Nicht-Ziele (Non-Goals)

- Keine automatische “always-on” Voll-Audit Pipeline für alle Listings im Hintergrund.
- Keine “magischen” Hersteller-Daten: Hersteller‑Vergleiche werden nur mit konkreter Evidence (Web‑Excerpts/IDs) gemacht.
- Kein vollständiger Feature‑Parity für **alle** eBay‑Felder beim „Übernehmen“ im ersten Schritt (wir starten mit sicheren Feldern).

## Ausgangslage (Current State)

Backend:

- `POST /api/ebay/listings/sync` → `syncLiveListingsAndAudit()`:
  - Trading API `GetMyeBaySelling` (ActiveList) + **pro Listing** `GetItem` (teuer)
  - upsert nach `ebayListingsLive`
  - Link‑Build nach `ebayListingLinks`
  - Gap‑Audit nach `ebayListingGaps`
- `GET /api/ebay/sku-index` wird im Products‑Grid genutzt, basiert auf:
  - `ebayListingsLive.active == true` + `ebayListingLinks.status == matched`

Frontend:

- `frontend-v2/components/views/EbayListingsView.tsx` zeigt aktuell:
  - Listings + Gaps + ItemSpecifics‑Vergleich (Avy vs Listing)

## Zielbild (Proposed UX / Data Flow)

### A) Products-Grid: schneller „gelistet? + Link“ Indikator

1. Products‑Grid lädt initial `/api/ebay/sku-index` (schnell, cached).
2. Im Hintergrund triggert UI einen **Light‑Sync** (schnell, ohne `GetItem`).
3. Nach Light‑Sync lädt UI erneut `/api/ebay/sku-index` → Indikator ist “frisch”.
4. Wiederholung **alle 2 Minuten**, nur wenn Tab sichtbar ist.
5. Nach „Publish“ oder „Apply Vorschlag“ wird immer sofort refresh ausgelöst.

### B) eBay-Seite: Listing Audit statt Vergleich

Die eBay‑Seite zeigt:

- Listing‑Liste (aktive Listings, Such/Filter)
- Pro Listing:
  - **Audit‑Summary** (Score/Severities, “needs attention”)
  - **Findings** nach Bereichen:
    - Titel & SEO (eBay search‑native, 70–80 Zeichen preferred, max 80, Keyword‑Coverage vs Konkurrenz)
    - Parameter/Aspekte (Pflicht‑Aspekte je Kategorie, Plausibilität)
    - Bilder (Anzahl/Qualität/Passung/Neutralität)
    - Beschreibung (Struktur, wichtige Infos, spam/fehlende Infos)
    - Preis & Versand (Vergleich zu ähnlichen Angeboten, offensichtliche Ausreißer)
  - **Vorschläge** mit:
    - Erklärung (warum)
    - Evidence (z. B. Konkurrenz‑Tokens, Pflicht‑Aspekte)
    - “Übernehmen” Button (wenn automatisch sicher)

Audit wird **on-demand** gerechnet:

- Benutzer klickt „Audit erstellen/aktualisieren“ oder öffnet Listing‑Detail
- Backend holt bei Bedarf frische Details (Trading `GetItem`) und berechnet Audit
- Ergebnis wird gespeichert und in der UI wiederverwendet

## Datenmodell (Firestore)

Bestehende Collections bleiben:

- `ebayListingsLive` (Snapshots der Listings, active, viewItemUrl, skuIndex, …)
- `ebayListingLinks` (itemId → productId match, optional)

Neu:

- `ebayListingAudits` (docId = itemId)
  - `itemId`
  - `status`: `fresh | stale | failed`
  - `updatedAt`, `updatedAtIso`, `actor`, `runId`
  - `listingSnapshot` (subset für UI: title, categoryId, price, shipping summary, picture URLs count, …)
  - `findings[]`: strukturierte Findings
  - `suggestions[]`: actionable Vorschläge inkl. `patch` (wenn auto‑apply möglich)
  - `evidence`: { browseTitleInsights?, requiredAspects?, webEvidence? }

## Backend API Änderungen

Neu (oder erweitert):

- `POST /api/ebay/listings/light-sync`
  - Trading `GetMyeBaySelling` ActiveList (ohne `GetItem`)
  - Upsert minimaler Felder in `ebayListingsLive` (merge, keine Null‑Overwrites)
  - Deactivation nur wenn ingest vollständig
  - Server‑Side “cooldown” (z. B. skip wenn <60s seit last run)

- `POST /api/ebay/listings/:itemId/audit`
  - Holt frische Details via Trading `GetItem` (on‑demand)
  - Berechnet Audit (deterministisch + optional LLM für Text‑Verbesserungen)
  - Persistiert `ebayListingAudits/{itemId}`

- `GET /api/ebay/listings/:itemId/audit`
  - Liefert cached Audit (für UI)

- `POST /api/ebay/listings/:itemId/apply`
  - nimmt `suggestionIds[]` oder `patch`
  - wendet Änderungen an:
    - Primär Trading: `ReviseFixedPriceItem` / `ReviseItem` (Title/Description/ItemSpecifics)
    - Wenn Trading‑Revise nicht erlaubt (Inventory‑Model Listing): Rückgabe mit klarer Fehlermeldung + optional Inventory‑API Pfad (später, abhängig von Scopes)
  - Nach Erfolg: markiert Audit als stale + triggert Light‑Sync/Refresh

## Audit-Logik (High Level)

Deterministische Checks:

- **Titel**
  - Länge: 70–80 bevorzugt, niemals >80
  - Pflicht-Token-Checks: Brand/Produkttyp/Modell/MPN (nur wenn im Listing/Specifics/Evidence vorhanden)
  - Konkurrenz‑Vergleich: Browse API `item_summary/search` → Top‑Tokens + Beispiel‑Titel → Coverage/Missing‑Tokens

- **Aspekte/Parameter**
  - Pflicht‑Aspekte je Kategorie (Taxonomy/Aspect Catalog) → missing/invalid
  - Value‑MaxLength constraints (wo eBay maxLength bekannt ist)

- **Bilder**
  - Anzahl (z. B. <5 als Warnung)
  - Auflösung/Format checks (falls URLs verfügbar)

- **Preis/Versand**
  - Vergleich zu ähnlichen Listings (Browse Search) → Ausreißerwarnungen

Optionale LLM‑Unterstützung (später/guarded):

- Beschreibung verbessern, aber nur basierend auf Listing‑Text + Evidence (keine Halluzinationen)

## Sicherheit / Permissions

- Alle Endpunkte bleiben hinter `requirePermission('products', ...)` wie bestehende eBay‑APIs.
- Apply‑Aktionen nur für Nutzer mit write‑Permission.

## Rollout / Migration

- `EbayListingsView` UI wird schrittweise umgestellt:
  - Erst Audit‑Panel + Suggestions (read-only)
  - Danach Apply‑Buttons (title/description/itemSpecifics)
  - Legacy Vergleichstabelle optional entfernen

## Testplan (High Level)

- Unit: Audit‑Regeln (Title token coverage, required aspects missing)
- Integration: Light‑Sync → sku-index wird aktualisiert, Products‑Indikator reagiert
- Integration: Apply (Trading revise) mit Mock/staging Credentials

