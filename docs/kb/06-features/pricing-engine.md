---
title: Pricing Engine
for: [dev, agent, admin, manager]
lastReviewed: 2026-10-06
---

# Pricing Engine

## Was es macht

Berechnet pro Produkt einen optimalen Verkaufspreis aus Wettbewerber-Daten (eBay Browse, Kaufland, Amazon, Idealo) plus optionalen Konfigurations-Regeln (Min-Marge, Min-/Max-Preis, Strategie). Drei-Tier-Algorithmus, plus reine `sweet-spot-pricer.js`-Library für die V4-Identify-Pipeline (fee-aware, trend-gewichtet).

## Wie es funktioniert

```mermaid
flowchart TD
  P[POST /api/v1/pricing/suggest/:productId] --> T1{EAN/GTIN-Match?}
  T1 -- ja, Median Neuware --> S1[Tier 1 conf 0.9]
  T1 -- nein --> T2{Kategorie-Similarity?}
  T2 -- ja --> S2[Tier 2 conf 0.6]
  T2 -- nein --> T3[Tier 3 cost-plus + LLM stub conf 0.4]
  S1 --> SUG[Suggested Price + Margin + matchBasis]
  S2 --> SUG
  T3 --> SUG

  B[POST /api/v1/pricing/reprice-batch] --> RUN[Pricing-Runner]
  RUN --> LR[loop pricingRules where active=true]
  LR --> SUG

  V4[Identify-V4 pricing-worker] --> SSP[sweet-spot-pricer.computeSweetSpot]
  SSP --> WT[SOLD 0.6 + Active 0.25 + Amazon 0.15]
  WT --> RND[Psychological Rounding .99/.95]
  RND --> NR[Net-Revenue per Marketplace fee-aware]
```

### 3-Tier-Algorithmus (`backend/services/pricing-engine.js`)

- **Tier 1 — EAN/GTIN-Match**: Median über `details.pricing.competitorPrices` mit Neuware-Filter; `medianBased = median * 0.97`, geclamp gegen `buyPrice * 1.10`. Confidence 0.9.
- **Tier 2 — Kategorie-Similarity**: Median ähnlicher Produkte im eigenen Bestand (gleiche `categoryId`). Confidence 0.6.
- **Tier 3 — Cost-Plus**: `buyPrice * targetMargin` Fallback, optional LLM-Stub. Confidence 0.4.

### Sweet-Spot-Pricer (`backend/lib/sweet-spot-pricer.js`)

Pure Function (kein I/O, kein Gemini). Inputs: SOLD-Listings, Active-Listings, Amazon-Preis, Kaufland-Preis. Output: einzelner "sweet-spot"-Preis mit:

- Source-Weights: `sold=0.6`, `active=0.25`, `amazon=0.15`
- Marketplace-Fees: `EBAY_DE=12.5%`, `KAUFLAND_DE=16.66%` (14% Provision + 19% USt), `AMAZON_DE=15%`
- Psychological Rounding: `<10€` → `.99`, `<50€` → `.99`, `<100€` → `.95`, `≥100€` → nearest 5 + `.99`
- Sanity-Bounds: `MIN_VIABLE_PRICE=0.5€`, `MAX_VIABLE_PRICE=100000€`
- Net-Revenue-Projection pro Marktplatz (deterministisch, auditable)

Wird von `lib/identify-workers/pricing-worker.js` (V4) genutzt.

### Price-Enrichment (`backend/lib/price-enrichment.js`)

Multi-Source-Lookup:
1. SerpAPI via `ensurePriceCoverage`
2. eBay Browse API via `ebay-browse-title-insights` (`fetchBrowsePriceSamples`)
3. BrightData-backed Web-Search + HTML-Scraping (`fetchWithUnlocker`)

Pflicht-Marketplaces: `ebay.de, kaufland.de, hood.de, amazon.de, idealo.de, zalando.de`. Used-Hint-Regex filtert Refurbed/B-Ware automatisch raus.

### Preis bei V3-Erfassung

Stand 06.10.2026: `enrichPriceParallel(product, { capture: true })` nutzt die begrenzte Capture-Recherche. Refresh und Chat verwenden weiterhin ihren bestehenden Pfad.

1. Browse und Kennungssuche starten parallel. Bevorzugt EAN/GTIN/UPC, sonst Marke + MPN; bei fehlendem Webpreis folgt eine getrennte Modell-/Varianten-/Produkttyp-Suche. Kein `site:.de`, damit deutsche Shops auf `.com` erreichbar bleiben. Höchstens zwei Suchanfragen à acht Sekunden pro Lauf, sechs Treffer je Anfrage.
2. Der Händlerleser akzeptiert das eigene EUR-`Offer` eines passenden JSON-LD-`Product`, einschließlich `mainEntity`, Preis-Spezifikationen und eindeutig identifizierten `ProductGroup`-Varianten. Deutsche Shopregion, Neuware, Verfügbarkeit, Packungsgröße und Identität werden geprüft. MPN braucht die passende Marke; ein exklusiv im strukturierten Produkt belegtes Modell kann bei fehlenden veröffentlichten Kennungen mit übereinstimmender Farbe/Größe genügen. Abweichende Kennungen verhindern diesen Modell-Rückfall.
3. Ein strukturiertes Suchindex-Angebot darf bei HTTP 403/429 oder anderen Infrastrukturfehlern helfen, wenn Artikel, Packung, vollständiger EUR-Preis und Lagerverfügbarkeit übereinstimmen. Es bleibt ausdrücklich `verified: false`, `evidence_type: search_index`, Confidence 0,65. 404/410, Fremdregionen und ein widersprechendes erfolgreich geladenes Angebot bleiben ausgeschlossen.
4. eBay Capture fordert Neuware (`conditionId=1000`) und Festpreis; ein exakt passendes Angebot genügt. Der normale Refresh behält mindestens drei Treffer. Auktionen, Gebrauchtware und abweichende Packungen werden ausgeschlossen.
5. Liegt nach höchstens acht Sekunden kein Preis vor, entdeckt ein begrenzter Gemini-Aufruf weitere URLs. Deren tatsächliches Angebot liest derselbe deterministische Leser; Modellbetrag oder Preisvorkommen irgendwo auf einer Seite reichen nicht aus. Fünf Sekunden werden für die Prüfung reserviert. Weiterleitungen werden als tatsächliche Händler-URL gespeichert und Quellen dedupliziert.
6. Jeder Lauf hat höchstens 45 Sekunden. Ein erfolgloser erster Lauf kann vor der Speicherung mit dem fertigen Datenblatt einmal wiederholt werden, sofern Stage 3 regulär erfolgreich war und vom V3-Gesamtbudget (300 Sekunden) mindestens fünf Sekunden bleiben. Eine zwischen Erkennung und Datenblatt geänderte Packungsgröße verwirft den frühen Preis. Es gibt keinen nachträglichen Capture-Preiswrite.
7. Der recherchierte Median landet in `details.pricing.lowest_price`; neue V3-Produkte erhalten denselben Betrag zusätzlich als editierbaren `sellPrice` und `suggestedPrice`. Der Vorschlag enthält keinen pauschalen Zustandsrabatt und keine Margengarantie. Vorhandene Produkte im Wiederverwendungspfad behalten ihre Preise. Ohne Angebot wird kein Preis erfunden.

`ops.data_quality.identify_v3.price_research` enthält zusätzlich `initial_sell_price` und Recherchediagnostik (`version: 3`, Such-/Seitenzahlen, HTTP-Fehler, Laufzeit, Quelle, Budgetende; beim zweiten Lauf getrennt nach `initial`/`final_datasheet`). Damit lassen sich ursprünglicher Verkaufspreis und spätere Bearbeitung unterscheiden. Ein heutiger Preis oder `snapshot.price_ok` allein beweist keinen initialen Verkaufspreis.

Externe Recherche kann kostenpflichtig sein. Netzwerkrequests können über das äußere Budget hinaus auslaufen, aber anschließend keine Produktänderung auslösen. Eine lückenlose Abdeckung ist nicht belegt. [Audit, Proben und Abnahmegrenzen](../../reports/capture-price-2026-10-06.md).

### Pricing-Rules (`pricingRules` Collection)

Schema (Firestore Doc-ID = `productId`):

```
{
  productId, ruleType: 'competitor_median'|'category_match'|'manual'|'cost_plus',
  params: { minMargin, maxPrice, minPrice, targetMargin, competitorFilter },
  active, lastApplied, updatedAt
}
```

Pricing-Runner (`services/pricing-runner.js`) ist disabled-by-default; Trigger erfolgt manuell via `POST /api/v1/pricing/reprice-batch`.

## Code-Pfade

**Backend:**
- `backend/lib/capture-indexed-offer.js` — strukturierte Suchindex-Angebote mit Beleggrenze
- `backend/lib/capture-offer-quantity.js` — Packungsgrößenprüfung für Händler und Browse
- `backend/services/pricing-engine.js` — 3-Tier-Algorithmus + Rules-CRUD
- `backend/services/pricing-runner.js` — Scheduled Runner (default disabled)
- `backend/services/competitor-refresh-runner.js` — 72 h-Background-Fetcher (default disabled)
- `backend/lib/sweet-spot-pricer.js` — Pure Library für V4 + Auto-Fix
- `backend/lib/price-enrichment.js` — Multi-Source-Lookup
- `backend/lib/competitor-prices.js` — eBay Browse + Kaufland Lookup mit 2 h-Cache
- `backend/lib/ebay-browse-title-insights.js` — `fetchBrowsePriceSamples`
- `backend/lib/identify-workers/pricing-worker.js` — V4-Worker
- `backend/routes/products.js` (L2334+) — REST-Endpoints

**Frontend:**
- `components/PricingDashboard.tsx` — Hauptseite (Rules + Suggestions + Batch-Trigger)
- `components/pricing/PricingRuleList.tsx`
- `components/pricing/PricingRuleForm.tsx`
- `components/pricing/PricingSuggestions.tsx`
- `components/pricing/ProductPricingDetail.tsx`
- `components/CompetitorPrices.tsx`, `components/CompetitorPriceChart.tsx`

## Feature-Flags

| Flag | Default | Wirkung |
|---|---|---|
| `IDENTIFY_V4_PRICING_SOLD` | `true` | V4-pricing-worker zieht eBay SOLD-Listings |
| `PRICE_REFRESH_TIMEOUT_MS` | `20000` | Total-Timeout für Price-Refresh-Run |

`pricing-runner.js` und `competitor-refresh-runner.js` werden durch separate Trigger aktiviert (kein einzelnes ENV-Flag dokumentiert — siehe Code).

## API-Endpoints

Verweis auf `docs/kb/09-api/` (TBD). Aktuell in `backend/routes/products.js`:

- `POST /api/v1/pricing/suggest/:productId` — Suggestion mit `tier`, `confidence`, `matchBasis`
- `POST /api/v1/pricing/rules` — Rule create/update
- `GET  /api/v1/pricing/rules` — Liste aller Rules
- `POST /api/v1/pricing/reprice-batch` — Batch-Run
- `DELETE /api/v1/pricing/rules/:ruleId`
- `PATCH /api/v1/pricing/rules/:ruleId/toggle`
- `GET /api/competitor-prices?ean=` — Live-Lookup
- `GET /api/competitor-history?productId=` — 30-Tage-Trend

Auth: `products.write` (write), `products.read` (read), `admin.jobs.run` (batch).

## UI-Pages

Verweis auf `docs/kb/05-pages/` (TBD).

- `/pricing` → `PricingDashboard` (Tabs: Regeln, Vorschläge)
- ProductSheet → "Preise"-Tab via `ProductPricingDetail`

## Spec

- [archivierte PRICE-001-Spec](../../archive/features/completed/PRICE-001-pricing-engine-ui-spec.md) — UI-Spec (Layer 1: Backend + Modal, Layer 2: Inline, Layer 3: CSV)

## Bekannte Issues

TBD — laufende Bugs siehe `TASKS.md`.
