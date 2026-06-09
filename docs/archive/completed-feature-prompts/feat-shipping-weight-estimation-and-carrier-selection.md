# FEAT: Gewichtsschätzung verbessern + automatische Carrier-Selektion im Pack-Modul

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

## Problem

Das LLM (Gemini) schätzt Produktgewichte unrealistisch. Beispiel: "Costway Elektro-Quad 12V 35kg Kinder Kinderfahrzeug" → 0.5 kg. Der Titel enthält "35kg" und das LLM ignoriert es.

Die Versandregeln-Matrix existiert bereits (order_settings/{tenantId}.carrierRules):
  - 0,60–1,00 kg → DHL Kleinpaket (Method ID 2830)
  - 1,01–5,00 kg → DPD Classic 0-5 kg (Method ID 111)
  - 5,01–10,00 kg → DPD Classic 5-10 kg (Method ID 112)
  - 10,01–20,00 kg → DPD Classic 10-20 kg (Method ID 113)

Die shipping-engine.js hat `matchCarrierRule()` + `shipOrder()` mit Auto-Selektion. Aber: wenn das Gewicht falsch ist, greift die falsche Regel.

## Ist-Zustand

### Gewichtsschätzung
- `backend/services/enrichment.js` Zeile ~1637: Gemini-Prompt sagt "Gewicht (weight_grams): Pflichtfeld. Realistisch schätzen basierend auf Produkttyp, Material und Kategorie."
- `enrichment.js` Zeile ~1813–1854: `applyReviewResult()` extrahiert weight_grams aus Review, konvertiert zu kg, speichert in `product.details.weight`
- JSON Schema (Zeile ~1518): `weight_grams: { type: 'integer', nullable: true }`
- Problem: Die Anweisung ist zu vage. Es fehlt ein expliziter Hinweis dass Gewichtsangaben im Titel/Attributen Vorrang haben.

### Carrier-Selektion
- `backend/services/shipping-engine.js`: `matchCarrierRule()` (Zeile ~422) matcht Gewicht gegen Regeln
- `shipOrder()` (Zeile ~466) lädt carrierRules aus Firestore, matcht, erstellt SendCloud-Parcel
- `calculateOrderWeight()` (Zeile ~391) summiert Item-Gewichte, Fallback 0.5 kg
- DEFAULT_CARRIER_RULES (Zeile ~18) als Fallback wenn keine Firestore-Regeln

### Pack-Modul (Frontend)
- `components/MobileOperationsView.tsx` hat Pack-Modus (mode === 'operations-pack')
- Pack-Flow: SKU scannen → Order zuordnen → "Packen & Versenden" Button
- Aktuell: KEIN Gewichts-/Carrier-Hinweis beim Packen. Der Mitarbeiter sieht nicht welches Label erstellt wird.

## Aufgabe

### 1. Gemini-Prompt verbessern (enrichment.js)

In der Prompt-Zusammensetzung für `runDatasheetReview()` (Zeile ~1637) die Gewichtsanweisung verschärfen:

**Vorher:**
```
- Gewicht (weight_grams): Pflichtfeld. Als Zahl in GRAMM. Aus WEB-EVIDENZ/Verpackung/Produktdaten extrahieren. Falls nicht belegbar: realistisch schätzen basierend auf Produkttyp, Material und Kategorie. Nur null wenn Schätzung unmöglich.
```

**Nachher:**
```
- Gewicht (weight_grams): KRITISCHES PFLICHTFELD für Versandkosten-Berechnung. Als Zahl in GRAMM (z.B. 500 für 500g, 2500 für 2,5 kg).
  PRIORITÄT 1: Explizite Gewichtsangabe im Titel oder in Attributen (z.B. "35kg" im Titel → 35000).
  PRIORITÄT 2: Gewicht aus WEB-EVIDENZ/Verpackung/Produktdaten.
  PRIORITÄT 3: Realistische Schätzung basierend auf Produkttyp, Material, Größe und Kategorie.
  WICHTIG: Ein Kinder-Elektrofahrzeug wiegt 15-35 kg, ein Smartphone 150-250g, ein Buch 200-800g. Niemals pauschal 500g annehmen. Inkl. Verpackung schätzen (Versandgewicht).
```

### 2. Gewichts-Plausibilitätscheck nach Identify (enrichment.js)

In `applyReviewResult()` (Zeile ~1850) NACH der Gewichtsextraktion einen Plausibilitäts-Check einbauen:

```js
// Plausibilitätscheck: Wenn Titel Gewichtsangabe enthält, prüfen ob LLM-Schätzung realistisch ist
const titleWeight = extractWeightFromTitle(product.identification?.name || '');
if (titleWeight && weightKg && Math.abs(titleWeight - weightKg) / titleWeight > 0.5) {
  // LLM-Schätzung weicht >50% von Titel-Gewicht ab → Titel-Gewicht bevorzugen
  console.warn(`[weight-check] LLM estimated ${weightKg}kg but title suggests ${titleWeight}kg for "${product.identification?.name}"`);
  weightKg = titleWeight;
}
```

Hilfsfunktion `extractWeightFromTitle(title)`:
- Regex-Match für "(\d+[\.,]?\d*)\s*(kg|g|gramm|kilogramm)" im Titel
- Konvertierung zu kg
- Return null wenn kein Match

### 3. Pack-Modul: Carrier-Vorschau beim SKU-Scan (Frontend)

In `MobileOperationsView.tsx` im Pack-Modus: Wenn ein Auftrag ausgewählt wird, das geschätzte Gewicht + den vorgeschlagenen Carrier anzeigen:

```
📦 Geschätztes Gewicht: 35,0 kg
🚚 Versand: DPD Classic 10-20 kg (Method 113)
```

Dafür:
- Order-Items haben `weight` aus den Produktdaten. `calculateOrderWeight()` in shipping-engine.js summiert diese.
- Neuer API-Endpunkt oder bestehenden erweitern: GET `/api/orders/:id/shipping-preview` → gibt `{ weight, carrier, methodId, label }` zurück
- Oder: Client-seitig berechnen wenn Produkt-Gewichte verfügbar sind

### 4. Pack-Modul: Carrier im "Packen & Versenden" Button anzeigen

Statt nur "Packen & Versenden" → "Packen & Versenden (DPD Classic 10-20 kg)" damit der Mitarbeiter sofort sieht welches Label erstellt wird.

### 5. Backfill bestehender Produkte

Das Script `backend/scripts/backfill-weights.js` existiert aber wurde nie ausgeführt (FIX-11 in TASKS.md). Prüfe ob es die verbesserte Logik (Titel-Extraktion) nutzt. Wenn nicht, erweitere es.

### 6. Tests

- Test: `extractWeightFromTitle('Costway Elektro-Quad 12V 35kg Kinder')` → 35
- Test: `extractWeightFromTitle('Smartphone Hülle 50g Silikon')` → 0.05
- Test: `extractWeightFromTitle('Werkzeugset 3-teilig')` → null
- Test: `matchCarrierRule({ weight: 35, rules })` → DPD Classic 10-20 kg (oder Fallback-Regel)
- Test: `matchCarrierRule({ weight: 0.8, rules })` → DHL Kleinpaket
- Test: Plausibilitätscheck greift wenn LLM 0.5 schätzt aber Titel "35kg" sagt

### 7. cd backend && npm test — alle Tests müssen grün sein.

### 8. TASKS.md aktualisieren.
```

## Kontext für Mensch

### Existierende Infrastruktur
- **Versandregeln UI**: `components/orders/OrderSettingsView.tsx` — "Versandregeln" Sektion existiert mit Min/Max kg, Carrier, Method ID, Bezeichnung
- **Versandregeln Firestore**: `order_settings/{tenantId}.carrierRules[]` — Array von `{ minWeight, maxWeight, shippingMethodId, carrier, label }`
- **Carrier-Matching**: `shipping-engine.js` → `matchCarrierRule()` — fertig implementiert
- **Auto-Ship**: `shipOrder()` lädt Regeln, matcht, erstellt SendCloud-Parcel — fertig
- **Gewichtsberechnung**: `calculateOrderWeight()` summiert Item-Gewichte, Fallback 0.5 kg
- **SendCloud-Preise**: CSV-Tabellen in `backend/data/sendcloud_upload_DHL.csv` + `sendcloud_upload_DPD.csv`, Lookup via `sendcloud.js` → `lookupCsvPrice()`
- **Backfill-Script**: `backend/scripts/backfill-weights.js` existiert, nie ausgeführt (FIX-11)

### Kernproblem
Das Gewicht wird im LLM-Prompt (enrichment.js Zeile 1637) als "realistisch schätzen" formuliert — zu vage. Gemini ignoriert explizite Gewichtsangaben im Titel. Fix: Prompt verschärfen + Plausibilitätscheck als Sicherheitsnetz.

### Versand-Flow
Identify → Gewicht geschätzt → Stow → Pick → **Pack: SKU scannen → Gewicht + Carrier anzeigen → Label erstellen** → Ship

### Spätere Erweiterung (nicht Teil dieses Prompts)
- Waage am Packtisch: Echtes Gewicht überschreibt LLM-Schätzung
- Maße-Schätzung für Kleinpaket-Entscheidung (passt es in 35.3×25×8 cm?)
- Manuelle Carrier-Überschreibung im Pack-Modul
