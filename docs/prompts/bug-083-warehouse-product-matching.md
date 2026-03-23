# BUG-083: Warehouse Product-Matching Inkonsistenz (P0)

## Problem

Warehouse-Funktionen nutzen **6 verschiedene Matching-Strategien** für dasselbe Ziel: "Finde Produkt X in BIN Y". Ergebnis: Inkonsistenzen zwischen Tabelle, Produktdatenblatt und Warehouse-Verwaltung.

**Symptome:**
- Inventar-Tabelle zeigt BIN-Zuordnung korrekt (z.B. XSGA0103A)
- Produktdatenblatt zeigt "Aktuell keinem BIN zugeordnet"
- Warehouse zeigt BIN korrekt
- "Entfernen"-Button in Warehouse findet Produkt nicht → kann nicht aus BIN entfernt werden

## Root Cause

`backend/lib/warehouse.js` hat 5+ Funktionen die Produkte in BINs suchen — jede mit eigenem Matching:

### 1. `refreshProductInventory()` (Zeile 36-184) — ✅ KORREKT
Baut umfassendes `keySet` aus: docId + data.id + identification.sku + details.identifiers.sku + SKU-Prefix-Varianten.

### 2. `listBinsForProduct()` (Zeile 973-1037) — ✅ BEREITS GEFIXT
War: nur Input-Parameter + SKU-Strip.
Fix: Lädt jetzt Produkt-Dokument und baut vollständiges keySet.

### 3. `removeProductFromBin()` (Zeile 496-554) — ❌ BROKEN
```js
// Zeile 511-514: Nur exaktes String-Matching
const matches = (p) =>
  p &&
  (String(p.productId).trim() === String(productId).trim() ||
    String(p.sku || '').trim() === String(productId).trim());
```
Kein SKU-Prefix-Stripping, kein EAN-Matching, keine Varianten.

### 4. `assignProductToBin()` (Zeile 657-722) — ❌ BROKEN
```js
// Zeile 678: Nur exaktes productId-Matching
let entry = products.find((p) => p.productId === productId);
```
Kein SKU/EAN-Matching.

### 5. `bookStockIn()` (Zeile 732-826) — ⚠️ TEILWEISE OK
```js
// Zeile 755: Nur exaktes productId-Matching für Duplikat-Check
let entry = products.find((p) => p.productId === resolvedProductId);
```
Findet existierenden Eintrag nicht wenn productId abweicht → erstellt Duplikat statt zu addieren.

### 6. `getProductBinSummaryMap()` (Zeile 1053-1110) — ✅ KORREKT
Nutzt skuToProductIdMap mit SKU-Varianten.

## Lösung: Zentrale Match-Funktion

### Fix A: Extrahiere `buildProductKeySet(productIdOrData)` (NEU)

Erstelle eine zentrale Funktion die ein normalisiertes KeySet baut:

```js
/**
 * Baut ein umfassendes Set von normalisierten Keys für Product-Matching.
 * Wird von ALLEN Warehouse-Funktionen genutzt.
 * @param {string|object} productIdOrData - Firestore docId oder Produkt-Daten
 * @returns {Set<string>} Normalisierte Keys (lowercase, SKU-Varianten)
 */
function buildProductKeySet(productIdOrData) {
  const keySet = new Set();
  const addKey = (value) => {
    const normalized = normalizeKey(value);
    if (normalized) keySet.add(normalized);
  };
  const addSkuVariants = (value) => {
    if (!value) return;
    const raw = String(value).trim();
    addKey(raw);
    const stripped = raw.replace(/^sku[-_\s]*/i, '');
    addKey(stripped);
    if (stripped) addKey(`sku-${stripped}`);
  };

  if (typeof productIdOrData === 'string') {
    addKey(productIdOrData);
    addSkuVariants(productIdOrData);
  }

  if (typeof productIdOrData === 'object' && productIdOrData) {
    addKey(productIdOrData.id);
    addSkuVariants(productIdOrData?.identification?.sku);
    addSkuVariants(productIdOrData?.details?.identifiers?.sku);
    addKey(productIdOrData?.details?.identifiers?.ean);
    addKey(productIdOrData?.details?.identifiers?.gtin);
    addKey(productIdOrData?.details?.identifiers?.upc);
    const barcodes = Array.isArray(productIdOrData?.identification?.barcodes)
      ? productIdOrData.identification.barcodes : [];
    barcodes.forEach((b) => addKey(b));
  }

  return keySet;
}
```

Und eine Hilfsfunktion die gegen ein Bin-Entry matcht:

```js
/**
 * Prüft ob ein Bin-Entry (p) zu einem keySet passt.
 * @param {object} p - Bin products[] Entry mit .productId und .sku
 * @param {Set<string>} keySet - Von buildProductKeySet() erzeugt
 * @returns {boolean}
 */
function binEntryMatchesKeySet(p, keySet) {
  if (!p) return false;
  const pid = normalizeKey(p.productId);
  const sku = normalizeKey(p.sku);
  const pidStripped = pid ? pid.replace(/^sku[-_\s]*/i, '') : null;
  const skuStripped = sku ? sku.replace(/^sku[-_\s]*/i, '') : null;
  return (
    (pid && keySet.has(pid)) ||
    (sku && keySet.has(sku)) ||
    (pidStripped && keySet.has(pidStripped)) ||
    (skuStripped && keySet.has(skuStripped))
  );
}
```

### Fix B: `removeProductFromBin()` refactoren (Zeile 496-554)

1. Lade Produkt-Daten: `const productSnap = await tx.get(productRef);` (ist bereits da, Zeile 500)
2. Baue keySet: `const keySet = buildProductKeySet(productSnap.data());` + `addKey(productId);`
3. Ersetze Zeile 511-514:
```js
const matches = (p) => binEntryMatchesKeySet(p, keySet);
```

### Fix C: `assignProductToBin()` refactoren (Zeile 657-722)

1. Produkt-Daten sind bereits geladen (Zeile 661: `const product = await getProduct(productId);`)
2. Baue keySet: `const keySet = buildProductKeySet(product); addKey(productId);`
3. Ersetze Zeile 678:
```js
let entry = products.find((p) => binEntryMatchesKeySet(p, keySet));
```

### Fix D: `bookStockIn()` refactoren (Zeile 732-826)

1. Produkt-Daten sind geladen in der Transaction (Zeile 749)
2. Baue keySet: `const keySet = buildProductKeySet(productData); addKey(resolvedProductId);`
3. Ersetze Zeile 755:
```js
let entry = products.find((p) => binEntryMatchesKeySet(p, keySet));
```

### Fix E: `refreshProductInventory()` refactoren (Zeile 36-184)

Ersetze das manuell gebaute keySet (Zeile 56-72) und die Match-Logik (Zeile 79-92) mit:
```js
const keySet = buildProductKeySet(productData);
keySet.add(normalizeKey(resolvedId)); // docId immer dabei
// ...
const matches = products.filter((p) => binEntryMatchesKeySet(p, keySet));
```

### Fix F: `listBinsForProduct()` refactoren (Zeile 973-1037)

Bereits gefixt, aber die Logik auf `buildProductKeySet()` + `binEntryMatchesKeySet()` umstellen für Konsistenz.

## Dateien die geändert werden

| Datei | Änderung |
|---|---|
| `backend/lib/warehouse.js` | Neue Funktionen `buildProductKeySet()` + `binEntryMatchesKeySet()`, alle 5 Funktionen refactored |

## Tests

1. `cd backend && npm test` — alle bestehenden Tests müssen grün bleiben
2. Schreibe mindestens 3 Tests in `backend/__tests__/warehouse-matching.test.js`:
   - `buildProductKeySet()` mit productId, SKU, EAN → keySet enthält alle Varianten
   - `binEntryMatchesKeySet()` matcht SKU-7926913408 gegen Entry mit sku "SKU-7926913408"
   - `binEntryMatchesKeySet()` matcht EAN 0313030022097 gegen Entry mit productId "0313030022097"
   - `binEntryMatchesKeySet()` matcht NICHT gegen völlig unrelated Entry

## Nicht ändern

- Keine neuen Dependencies
- Keine Route-Änderungen
- Keine Firestore-Schema-Änderungen
- Keine Frontend-Änderungen (Fix ist komplett im Backend)
