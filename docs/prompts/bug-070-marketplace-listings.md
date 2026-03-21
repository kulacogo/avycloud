# BUG-070: Marketplace Listing-Tabellen — Falsche Daten + Inkonsistente UI

> P1 Bug. Betrifft components/MarketplaceListingsView.tsx + Backend-Endpoints.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe BUG-070 in Branch `fix/bug-070-marketplace-listings`.

## Kontext

MarketplaceListingsView.tsx (1174 Lines) ist eine einheitliche Komponente für eBay + Kaufland.
Daten werden über normalizeEbayRow() und normalizeKauflandRow() in ein NormalizedListing Interface normalisiert.

Backend-Endpoints:
- eBay: GET /api/ebay/listings → backend/routes/marketplace.js (Zeile ~466), nutzt ebay-direct.js listLiveListings()
- Kaufland: GET /api/kaufland/listings → backend/routes/marketplace.js (Zeile ~983)

Stock-Quelle: products_v2 via storageBins[].quantity oder inventory.quantity
Matching: ebayLinks (itemId→productId) bzw. SKU/EAN-Matching für Kaufland

## Problem 1: eBay Lager-Spalte zeigt "—" für die meisten Artikel

Ursache untersuchen in ebay-direct.js listLiveListings() (Zeile ~1626):
```js
const whStock = bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
  || (typeof prod?.inventory?.availableQuantity === 'number' ? prod.inventory.availableQuantity : null);
```
Das `||` nach reduce ist das Problem: reduce gibt 0 zurück wenn bins leer ist ODER alle Mengen 0 sind.
`0 || null` → null → wird als "—" angezeigt.

Fix: Trenne die Logik:
```js
const binsTotal = bins.length > 0 ? bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0) : null;
const whStock = binsTotal !== null ? binsTotal : (typeof prod?.inventory?.availableQuantity === 'number' ? prod.inventory.availableQuantity : null);
```
So wird 0 korrekt als 0 angezeigt wenn Bins vorhanden sind, und nur null wenn gar keine Daten existieren.

Zusätzlich prüfen: Werden die eBay Listings korrekt mit products_v2 verlinkt?
- Wenn der ebayLinks Eintrag fehlt → prod ist null → whStock ist null → "—"
- Prüfe wie viele Listings einen ebayLinks-Match haben vs. nicht

## Problem 2: Inaktive eBay-Artikel zeigen Lagerbestand

Screenshot zeigt: Engelbert Strauss Shirt ist "Inaktiv" aber Lager=3.
Das ist wahrscheinlich KORREKT — der Artikel hat physischen Lagerbestand, ist aber auf eBay nicht mehr gelistet.
Das ist kein Bug, sondern eine Feature-Anforderung: Bestandsabweichungen sichtbar machen.

Prüfe: Ist das tatsächlich der Fall (Produkt hat wirklich quantity=3 in products_v2)?
Falls ja → kein Fix nötig, aber füge einen visuellen Hinweis hinzu:
- Bei inaktiven Artikeln MIT Lagerbestand > 0: gelbes Warning-Icon neben dem Bestand
- Tooltip: "Lagerbestand vorhanden, aber Listing inaktiv"

## Problem 3: Kaufland aktive Angebote mit Marktplatz=0 und Lager=0

Angebote wie Hermès, Wera, KNIPEx zeigen Status="Aktiv" aber 0/0 Bestand.
Untersuche in marketplace.js Kaufland-Endpoint (Zeile ~983):
1. Kommt der Status direkt von Kaufland API oder wird er berechnet?
2. Ist quantity=0 korrekt aus der API oder fehlt das Feld?
3. Werden Kaufland-Listings korrekt mit products_v2 gematched? (SKU/EAN Matching, Zeile 1002-1020)

Mögliche Ursachen:
a) Kaufland meldet den Artikel noch als aktiv obwohl Bestand 0 (Kaufland-seitig)
b) Das SKU-Matching schlägt fehl → whStock bleibt null → wird als 0 angezeigt (prüfe: wird null als 0 gerendert?)
c) Die Kaufland API gibt quantity nicht zurück → Frontend zeigt 0 statt "—"

Fix je nach Ursache:
- Falls Matching-Problem: verbessere SKU/EAN-Matching (Logging einbauen!)
- Falls Rendering-Problem: null sollte als "—" angezeigt werden, 0 als 0
- Falls API korrekt und Status wirklich "aktiv" bei 0 Bestand → visuellen Hinweis hinzufügen

## Problem 4: Kaufland Preis-Spalte zeigt "—"

Preis-Quelle bei Kaufland (normalizeKauflandRow, Zeile ~120-145):
1. matched product's details.pricing.sellPrice
2. Fallback: listing_price / 100
3. Fallback: price / 100

Prüfe: Haben die betroffenen Kaufland-Listings ein listing_price oder price Feld?
- Falls ja: ist die Division durch 100 korrekt? (Kaufland speichert in Cents)
- Falls nein: fehlt das Feld in der API-Response?
- Log die raw API-Response für ein paar Listings um zu sehen was zurückkommt

## Problem 5: Kaufland Kategorie-Spalte leer

Kategorie-Quelle bei Kaufland: matched product's details.category
- Wenn kein Produkt-Match → keine Kategorie
- Kaufland API liefert category_name nicht direkt mit den Units

Fix: Kaufland API liefert evtl. category in einem anderen Feld. Prüfe die raw API-Response.
Alternativ: Falls Kaufland keine Kategorie liefert aber eine categoryId → speichere und zeige die ID als Fallback.
Falls gar keine Kategorie verfügbar: zeige "—" (das ist dann korrekt, kein Bug)

## Problem 6: Inkonsistente Spalten-Header

Screenshot zeigt: eBay hat "Item-ID", Kaufland hat "Unit-ID".
Das ist tatsächlich KORREKT (eBay nutzt Item-IDs, Kaufland nutzt Unit-IDs).
ABER: Die Spalte könnte einheitlich "Marketplace-ID" heißen oder "Listing-ID".

Fix: Benenne die Spalte einheitlich als "Listing-ID" oder belasse marketplace-spezifische Namen mit einer Erklärung.
Prüfe auch: sind andere Spalten unterschiedlich benannt oder nur diese eine?

## Problem 7: "Letztes Update" fehlt bei eBay

eBay normalizeEbayRow() → lastSync Feld.
Prüfe: Gibt es ein lastModifiedDate, endTime, oder ähnliches Feld in ebayListingsLive?
Falls ja: Mappe es auf lastSync in der Normalisierung.
Falls nein: Das ist ein Sync-Feature-Gap. Die eBay API liefert evtl. kein Update-Timestamp pro Listing.

## Zusammenfassung der Prioritäten

1. **KRITISCH**: eBay Lager "—" Bug (Problem 1) — der `0 || null` Logikfehler
2. **KRITISCH**: Kaufland null vs 0 Rendering (Problem 3) — sicherstellen dass null = "—" und 0 = 0
3. **HOCH**: Kaufland Preis fehlt (Problem 4) — Normalisierung/API prüfen
4. **MITTEL**: Kaufland Kategorie (Problem 5) — prüfen ob Daten verfügbar
5. **MITTEL**: eBay Letztes Update (Problem 7) — Feld mappen falls vorhanden
6. **NIEDRIG**: Spalten-Header (Problem 6) — kosmetisch
7. **NIEDRIG**: Inaktive mit Bestand (Problem 2) — ist korrekt, nur UX verbessern

## Vorgehen

1. Füge als ERSTES Logging hinzu um die tatsächlichen Daten zu verstehen:
   - eBay: Wie viele Listings haben einen ebayLinks-Match? Wie viele haben whStock !== null?
   - Kaufland: Wie viele Units werden per SKU/EAN gematched? Was liefert die raw API für price/category?
2. Fixe den `0 || null` Bug in ebay-direct.js (Problem 1 — sicherer Fix)
3. Fixe null vs 0 Rendering in MarketplaceListingsView.tsx
4. Arbeite die restlichen Probleme durch

cd backend && npm test + npm run build nach jedem Fix.
Commit: `fix(bug-070): marketplace listings — stock display, price normalization, data consistency`
```
