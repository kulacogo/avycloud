# Warehouse Zone P + Erweiterte Ranges + Offene Bugs

> Großes Update: Warehouse-Erweiterung UND verbleibende P0/P1 Bugs in einer Session.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann arbeite folgende Punkte ab — alle in Branch `fix/warehouse-and-bugs`:

---

## TEIL 1: Warehouse Erweiterung (Zone P + Ranges)

### 1A: Backend — warehouse.js anpassen

Datei: backend/lib/warehouse.js

1. ZONES Array erweitern:
   ```js
   const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ', 'P'];
   ```

2. Ranges erweitern:
   ```js
   const MAX_GANG = 10;   // war 6
   const MAX_REGAL = 15;  // war 6
   const MAX_EBENE = 'G'.charCodeAt(0);  // war 'E' (69 → 71)
   ```

3. Zone P Sonderlogik — Palette mit fortlaufender Nummer:
   Zone P hat KEINE Gänge/Regale/Ebenen. Stattdessen fortlaufende Nummern: P-001, P-002, P-003, ...

   Neue Funktion `createPaletteBins(etage, count)`:
   - Ermittelt die höchste existierende Paletten-Nummer für diese Etage aus Firestore
   - Generiert `count` neue Bins mit fortlaufender Nummer
   - BIN-Code Format: `P{ETAGE}{NNN}` z.B. `PGA001`, `PGA002`, ...
   - Speichert in warehouseBins mit: zone='P', etage, paletteNumber=N, gang=0, regal=0, ebene='-'
   - Erstellt/Updated warehouseZones Dokument `P_{ETAGE}` mit binCount

   In `createWarehouseLayout()` Sonderbehandlung:
   ```js
   if (zone === 'P') {
     // gangRange wird als Anzahl interpretiert (z.B. "10" = 10 neue Paletten)
     const count = parseInt(gangRange, 10);
     if (isNaN(count) || count < 1 || count > 100) {
       throw new Error('Bitte eine Anzahl zwischen 1 und 100 für neue Paletten angeben.');
     }
     return createPaletteBins(etage, count);
   }
   ```

4. parseLetterSelection() — MAX_EBENE dynamisch nutzen:
   Die Funktion nutzt aktuell die globale MIN_EBENE/MAX_EBENE Konstante direkt in der Validation (Zeile 247).
   Stelle sicher dass nach der Änderung auf 'G' die Validierung korrekt funktioniert.

### 1B: Frontend — WarehouseView.tsx anpassen

Datei: components/WarehouseView.tsx

1. ZONE_OPTIONS erweitern (Zeile 23):
   ```ts
   const ZONE_OPTIONS: Array<'X' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XQ' | 'P'> = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ', 'P'];
   ```

2. Formular-Logik für Zone P:
   Wenn Zone P ausgewählt → ändere die Labels:
   - Gang-Feld: Label wird "Anzahl Paletten (z.B. 10)", Platzhalter "10"
   - Regal-Feld + Ebenen-Feld: ausblenden (display: none oder conditional render)

   Beim Absenden: gangRange = Anzahl, regalRange und ebeneRange werden ignoriert (Backend handelt Zone P Sonderlogik).

3. Zonenübersicht: Zone P Cards sollen "Paletten: {binCount}" statt "Gänge X, Regale Y, Ebenen Z" zeigen.

### 1C: Backend Route — Keine Änderung nötig

POST /api/warehouse/layouts akzeptiert bereits { zone, etage, gangs, regale, ebenen }.
Für Zone P wird gangs als Anzahl genutzt, regale/ebenen werden vom Backend ignoriert.

### 1D: QR-Code Labels

Datei: backend/services/label-printer.js

Prüfe ob buildBinLabelsHtml() und buildBinLabelsPdf() mit dem Format `PGA001` klarkommen.
Der BIN-Code ist kürzer als z.B. `XGA010201A` — die Font-Metrics Funktion `getBinFontMetrics()` skaliert bereits nach Länge, sollte also funktionieren. Nur kurz verifizieren.

---

## TEIL 2: BUG-070 — Marketplace Listings BIN-Code + Kategorie

### 2A: BIN-Code Anzeige in Listings

Das Problem: eBay/Kaufland Listings zeigen den BIN-Code (Lagerplatz) nicht an.
Die Daten liegen in products_v2 in verschiedenen Pfaden:
- `inventory.storageBins` (Array von Objekten mit binCode)
- `warehouseLocation` oder `inventory.binLocation` (ältere Felder)

In backend/lib/ebay-direct.js → `listLiveListings()` (ca. Zeile 1626+):
Prüfe ob `binLocation` korrekt aus dem Produkt extrahiert wird. Suche in products_v2 nach dem eBay ItemID Match und extrahiere:
```js
const bins = product.inventory?.storageBins;
const binLocation = Array.isArray(bins) && bins.length > 0
  ? bins.map(b => b.binCode || b.code).filter(Boolean).join(', ')
  : product.warehouseLocation || product.inventory?.binLocation || '—';
```

Gleiches für backend/routes/marketplace.js → Kaufland Endpoint.

### 2B: Kategorie + Letztes Update

eBay Listing zeigt "Kategorie: —":
- Im Backend die eBay Category-ID aus der Listing-Response lesen
- ODER aus products_v2: `identification.category` oder `details.category`
- Als Fallback: eBay `primaryCategory.categoryName` aus dem API Response

"Letztes Update" bei eBay fehlt:
- `listingDetails.endTime` oder `item.timeLeft` aus eBay API → als Letztes Update nutzen
- ODER: `updatedAt` aus dem products_v2 Dokument

---

## TEIL 3: BUG-072 — Versand BaseLinker + Kosten + Zustellquote

### 3A: BaseLinker Badge entfernen (P0!)

Datei: components/ShippingView.tsx (oder wo Badges gerendert werden)
Suche nach "baselinker" (case-insensitive) in ALLEN Frontend-Dateien.
Wenn source === "baselinker" → Badge-Anzeige als "Sonstige" oder komplett ausblenden.

Auch im Backend: Suche in routes/ und services/ nach "baselinker" Referenzen.
TABU-Regel: Keine neuen Referenzen. Bestehende Firestore-Daten mit source:"baselinker" sollen:
- Im UI als "Legacy" oder gar nicht angezeigt werden
- NICHT gelöscht werden (additive only Regel)

### 3B: Versandkosten korrekt berechnen

Versandkosten zeigen alle 0,00 EUR. Die Infrastruktur existiert bereits:
- backend/lib/sendcloud.js hat `lookupCsvPrice(methodId, weightKg)` (Zeile 67-90)
- CSV Dateien im Projekt-Root: sendcloud_upload_DHL.csv, sendcloud_upload_DPD.csv
- DHL Paket (method_id 89): 4.35€ - 15.65€ je nach Gewicht
- DPD Classic (method_id 111): 3.20€ - 5.30€ je nach Gewicht

Fix: Im Shipping-Endpoint wo Versandkosten berechnet/angezeigt werden:
1. Finde wo `shippingCost` für die ShippingView gesetzt wird
2. Wenn shippingCost === 0 oder fehlt → rufe lookupCsvPrice() auf
3. Nutze das Produktgewicht (details.weight) + Carrier-Mapping zu method_id
4. Carrier → method_id Mapping: "DHL" → 89, "DPD" → 111
5. Fallback Gewicht: 1kg wenn kein Gewicht hinterlegt

### 3C: Zustellquote Berechnung

Zustellquote zeigt 1.1% statt ~80%.
Finde die KPI-Berechnung in ShippingView.tsx.
Vermutliches Problem: Zähler/Nenner vertauscht oder falscher Status-Filter.
Korrekte Formel: `delivered / totalShipments * 100` wobei `delivered` = Status "delivered" oder "zugestellt".

### 3D: Geisterdaten ohne Tracking/Kunden

Einträge ohne Tracking-Nr UND Kundenname → stammen wahrscheinlich aus alten BaseLinker Imports.
Fix: Im Backend-Endpoint der Shipping-Daten liefert → filtere Einträge heraus die:
- source === "baselinker" ODER
- KEIN trackingNumber UND KEIN customer.name haben
ODER: Zeige sie in einer separaten "Unvollständig" Kategorie am Ende.

---

## TEIL 4: BUG-071 — Pipeline-Zahlen Konsistenz

Bestellungen Pipeline zeigt andere Zahlen als die Tabs.
Finde in OrdersView.tsx:
1. Wie Pipeline-Zahlen berechnet werden (vermutlich aus einer separaten Aggregation)
2. Wie Tab-Zahlen berechnet werden (vermutlich clientseitig aus den geladenen Orders)

Fix: Beide müssen dieselbe Datenquelle und dieselben Filter nutzen.
Vermutlich: Pipeline zählt nur einen Teil der Status, Tabs zählen anders.
Stelle sicher: Summe aller Tabs = "Alle" Tab Zahl.

---

## TEIL 5: BUG-073 + BUG-074 — Rechnungen

### 5A: BUG-073 Mark as Paid Error

Datei: InvoicesView.tsx + Backend Route für "als bezahlt markieren"
Finde den Click-Handler für den grünen Haken.
Prüfe: Wird die richtige API aufgerufen? Gibt es einen Typo im Endpoint? Fehlt ein Parameter?
Fix: Error analysieren und beheben.

### 5B: BUG-074 Invoice PDF Redesign

Das Invoice PDF soll dem SevDesk/TrendOcean Design entsprechen (Referenz: RE-1574.pdf wurde bereits analysiert):
- Header: TrendOcean Logo links, QR-Code rechts oben
- Absenderzeile: "Trendocean • In den Telgen 4 • 44536 Lünen"
- Empfänger-Adresse
- Rechnungsdetails: Rechnungs-Nr, Datum, Leistungszeitraum, Kunden-Nr
- Tabelle: Pos. | Beschreibung | Menge | Einzelpreis | Gesamtpreis
- Summenblock: Nettobetrag, USt 19%, Bruttobetrag
- 4-Spalten Footer: Adresse | Kontakt | Steuer-IDs | Banking
- Firma: Trendocean, In den Telgen 4, 44536 Lünen
- USt-ID: DE351808960
- IBAN: DE59 4435 0060 1000 9382 64

Finde die PDF-Generierung (wahrscheinlich mit PDFKit) und passe das Layout komplett an.

---

## TEIL 6: BUG-077 — Mobile UI Quick Fixes

### 6A: BIN Scanner Label
Das Label "Scannen BIN" bricht um weil das Feld zu schmal ist.
Fix: Finde das Input-Label im Scanner-Bereich. Kürze den Text zu "BIN scannen" oder "Scan BIN" und stelle min-width sicher.

### 6B: Safe Area (iPhone)
Bottom-Navigation überlappt mit iPhone Home Indicator.
Fix: Füge `pb-[env(safe-area-inset-bottom)]` oder `padding-bottom: env(safe-area-inset-bottom)` zur Bottom-Nav hinzu.
In index.html: Prüfe ob `<meta name="viewport" content="... viewport-fit=cover">` gesetzt ist.

---

## QUALITÄTSSICHERUNG

Nach allen Änderungen:
1. `cd backend && npm test` — alle Tests grün
2. `npm run build` — Frontend baut fehlerfrei
3. Grep nach "baselinker" (case-insensitive) in allen NEUEN/geänderten Dateien → muss 0 sein
4. Grep nach bg-blue, bg-red, bg-green in neuen Dateien → muss 0 sein (Design Tokens!)
5. Prüfe dass alle neuen Firestore Queries tenantId haben
6. Prüfe dass Zone P korrekt in beiden Backend-Validierungen akzeptiert wird

Commit: `feat: warehouse zone P + expanded ranges + fix bugs 070-074, 077`
Merge nach main und push.
```
