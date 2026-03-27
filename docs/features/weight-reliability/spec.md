# Feature: Zuverlassiges Produktgewicht fur Fulfillment

**ID:** weight-reliability
**Status:** Draft
**Datum:** 2026-03-26
**Impact:** HIGH — Kein korrektes Gewicht = kein Fulfillment

## Ziel

Jedes Produkt in einer Bestellung hat ein realistisches Gewicht. Kein Fallback, kein Raten — lieber kein Gewicht als ein falsches. Fehlendes Gewicht wird in den Bestelldetails sichtbar und manuell nachgetragen.

## Kontext & Problem

### Ist-Zustand

1. **Key-Chaos bei Produktgewicht:** `details.weight`, `details.attributes.weight`, `details.attributes['Gewicht (kg)']`, `details.attributes['Gewicht']` — 4 verschiedene Keys, inkonsistent geschrieben und gelesen.
2. **Stammdaten zeigt "—":** `ProductSheet.tsx` liest `details.attributes['Gewicht']`, aber `enforceEbayAspects()` schreibt `'Gewicht (kg)'`. Ergebnis: Gewicht existiert, wird aber nicht angezeigt.
3. **Bestellungen haben kein Gewicht:** Weder eBay- noch Kaufland-Import schlaegt Produktgewichte nach. `order.weight` und `item.weight` bleiben leer.
4. **Shipping-Engine faellt auf 0.5kg zurueck:** Hardcoded Fallback in `calculateOrderWeight()` — fuehrt zu falschen Versandlabels.
5. **Backfill-Script nutzt keine Bilder:** `backfill-weight-enrichment.js` schaetzt Gewicht nur aus Text, nicht aus Produktbildern.

### Risiko

- Falsches Versandlabel (zu leicht/schwer) → Nachberechnung durch Carrier
- Falsche Versandkostenberechnung → Marge sinkt
- Paket wird nicht abgeholt / zurueckgewiesen

## Design

### Bereich 1: Produktgewicht zuverlaessig machen

#### 1a) Key-Normalisierung im Frontend fixen

**Datei:** `components/ProductSheet.tsx` (Stammdaten-Tab, ~Zeile 1442)

Aktuell:
```tsx
value={localProduct.details?.attributes?.['Gewicht'] ?? ''}
```

Neu — Fallback-Kette:
```tsx
const weightValue =
  localProduct.details?.weight
  ?? localProduct.details?.attributes?.weight
  ?? localProduct.details?.attributes?.['Gewicht (kg)']
  ?? localProduct.details?.attributes?.['Gewicht']
  ?? '';
```

Schreibpfad bleibt: Aenderungen gehen ueber `handleFieldChange` → `saveProductV2()` → `enforceEbayAspects()` normalisiert automatisch.

#### 1b) Backfill-Script mit Bildunterstuetzung

**Datei:** `backend/scripts/backfill-weight-enrichment.js`

Upgrade des bestehenden Scripts:
- Produktbilder aus Firestore (`details.images[]`) laden
- Erstes Bild als `inlineData` (base64) an Gemini senden
- Gemini sieht Bild + Produktdaten (Titel, Marke, Kategorie, Material, Groesse) → realistischeres Gewicht
- Weil structured output + Bilder nicht gleichzeitig geht: Freitext-Prompt mit klarem Format → JSON-Parsing aus Antwort
- Nur fuer Produkte mit `inventory.quantity > 0` und ohne `details.weight`

Gemini-Prompt (Kern):
```
Du bist ein erfahrener Lagerarbeiter. Schaetze das Gewicht dieses Produkts in kg.
Sei realistisch — ein Handy wiegt ~0.2kg, ein Wechselrichter ~3-5kg, ein Grill ~20-40kg.
Antworte NUR mit JSON: { "weightKg": number, "confidence": "high|medium|low", "reasoning": "..." }
```

Plausibilitaetspruefung nach Schaetzung:
- Handy/Elektronik > 5kg → Ablehnen
- Moebel < 1kg → Ablehnen
- Grundregel: Wenn Schaetzung absurd → kein Gewicht setzen (lieber leer)

#### 1c) Enrichment-Pipeline: Gewicht bei Neuanlage

**Datei:** `backend/services/enrichment.js` (`applyReviewResult()`)

Bereits teilweise implementiert. Sicherstellen:
- Wenn `weight_grams` von Gemini kommt → `details.weight = weight_grams / 1000`
- Wenn Gewicht aus Attributen extrahiert → `details.weight` setzen
- `saveProductV2()` spiegelt automatisch in `details.attributes.weight`

Keine Aenderung noetig wenn `applyReviewResult()` korrekt `details.weight` setzt — was es bereits tut (Zeile 1931-1960).

### Bereich 2: Order-Import mit Produktgewicht

#### 2a) Produkt-Lookup bei Order-Import

**Dateien:**
- `backend/services/order-intake-ebay.js` (`saveOrderIfNew()`)
- `backend/services/order-intake-kaufland.js` (`saveOrderIfNew()`)

Neuer Schritt nach Mapping, vor Firestore-Write:

```
fuer jedes item in order.items:
  produkt = lookup by SKU in products_v2 (tenantId + identification.sku)
  falls nicht gefunden: lookup by EAN (tenantId + identification.ean)
  falls produkt.details.weight > 0:
    item.weight = produkt.details.weight
```

Lookup-Funktion als shared Helper in `backend/lib/product-store.js`:
```javascript
async function getProductWeightBySku(tenantId, sku, ean) {
  // 1. SKU-Lookup in products_v2
  // 2. Fallback: EAN-Lookup
  // Returns: number (kg) oder null
}
```

#### 2b) Order-Gewicht berechnen

Nach Item-Enrichment:
```
falls ALLE items ein weight haben:
  order.weight = Summe(item.weight * item.quantity)
falls mindestens 1 item KEIN weight hat:
  order.weight = null (nicht setzen)
```

Regel: **Kein Teilgewicht.** Entweder vollstaendig oder gar nicht. Fehlende Gewichte werden manuell nachgetragen.

#### 2c) Kein 0.5kg Fallback

**Datei:** `backend/services/shipping-engine.js` (`calculateOrderWeight()`, Zeile 423)

Aktuell:
```javascript
return 0.5; // 500g fallback
```

Neu:
```javascript
return null; // Kein Fallback — Gewicht muss explizit gesetzt sein
```

`shipOrder()` muss pruefen ob Gewicht `null` ist und mit klarer Fehlermeldung abbrechen:
```
"Versand nicht moeglich: Bestellgewicht fehlt. Bitte Gewicht in den Bestelldetails eintragen."
```

### Bereich 3: Sichtbarkeit in Bestelldetails

#### 3a) Gewicht pro Position

**Datei:** `components/OrderDetail.tsx` (Positionen-Tab)

Jedes Item in der Positionsliste zeigt sein Gewicht:
- Gewicht vorhanden: `3.6 kg`
- Gewicht fehlt: rot markiert `Gewicht fehlt` (wie "nicht angegeben" fuer Order-Gewicht)

#### 3b) Gesamtgewicht im Details-Tab

Bereits implementiert (`order.weight` Anzeige mit inline-Edit). Keine Aenderung noetig — funktioniert mit dem bestehenden manuellen Edit-Flow.

## Nicht-Ziele (Out of Scope)

- Keine Aenderung an bestehenden Routes/Endpoints
- Keine Umbenennung von Firestore-Feldern (nur additiv: `item.weight`)
- Kein automatisches Re-Enrichment bestehender Bestellungen (nur neue)
- Keine Aenderung an Auth/RBAC
- Kein Bulk-Update UI fuer Gewichte (spaeteres Feature)

## Betroffene Dateien

| Datei | Aenderung |
|-------|-----------|
| `components/ProductSheet.tsx` | Gewicht-Lese-Fallback-Kette |
| `backend/scripts/backfill-weight-enrichment.js` | Bildunterstuetzung fuer Gemini |
| `backend/services/order-intake-ebay.js` | Produkt-Lookup + item.weight |
| `backend/services/order-intake-kaufland.js` | Produkt-Lookup + item.weight |
| `backend/lib/product-store.js` | Neuer Helper: `getProductWeightBySku()` |
| `backend/services/shipping-engine.js` | Fallback entfernen, null zurueckgeben |
| `components/OrderDetail.tsx` | Gewicht pro Position anzeigen |

## Test-Strategie

1. **Unit-Test:** `getProductWeightBySku()` — SKU-Treffer, EAN-Fallback, kein Treffer
2. **Unit-Test:** `calculateOrderWeight()` — alle Items mit Gewicht, ein Item ohne, kein Item mit Gewicht
3. **Integration-Test:** eBay-Order-Import mit gemocktem Produkt → pruefe item.weight + order.weight
4. **Integration-Test:** Kaufland-Order-Import analog
5. **Manueller Test:** Backfill-Script mit `--debug --limit 5` auf realen Produkten

## Abhaengigkeiten

- Gemini API (Bildanalyse) — bereits im Einsatz fuer Identify
- Firebase Storage (Produktbilder) — bereits vorhanden
- `products_v2` Collection — muss aktuelle Gewichte haben bevor Order-Import enriched
