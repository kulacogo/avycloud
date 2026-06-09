# BUG-084: Dual-Write liest aus falscher Collection — manuelle Änderungen werden überschrieben

## Priorität: P0 (Datenverlust — User-Edits gehen verloren)

## Problem

Wenn ein User im ProductSheet den Titel (oder andere Felder) manuell ändert und speichert,
wird die Änderung korrekt in `products_v2` persistiert. Aber **sofort danach** überschreibt
der Dual-Write in `saveProductV2()` die Daten mit veralteten Werten aus der alten `products`
Collection. Nach dem nächsten Frontend-Polling (60s) springt der Titel zurück.

## Root Cause

`backend/lib/product-store.js` Zeile 43 (VOR dem Fix):

```js
const freshSnap = await firestore.collection(COLLECTION).doc(productId).get();
```

`COLLECTION` = `process.env.PRODUCT_COLLECTION || 'products'` → liest aus **alter** `products` Collection.

Aber `saveProduct()` in `firestore.js` schreibt mit `USE_PRODUCTS_V2=true` nach `products_v2`
(via `PRODUCTS_COLLECTION = _useV2 ? 'products_v2' : 'products'`).

**Ablauf des Bugs:**
1. UI-Save → `saveProductV2(product, { mode: 'manual', source: 'ui' })`
2. `saveProduct()` → schreibt neuen Titel nach `products_v2` ✅
3. Dual-Write → `firestore.collection('products').doc(id).get()` → **liest alten Titel** aus Legacy-Collection ❌
4. `normalizeProduct(freshData)` → normalisiert die alten Daten
5. `firestore.collection('products_v2').doc(id).set(normalized, { merge: true })` → **überschreibt neuen Titel** 💥
6. Frontend-Polling nach 60s → holt alte Daten → Titel springt zurück

## Fix (bereits implementiert)

**Datei:** `backend/lib/product-store.js`

**Änderung:** Zeile 43 liest jetzt aus `PRODUCTS_COLLECTION` (importiert aus `firestore.js`)
statt aus der lokalen `COLLECTION` Variable:

```js
// VORHER (BUG):
const freshSnap = await firestore.collection(COLLECTION).doc(productId).get();

// NACHHER (FIX):
const { PRODUCTS_COLLECTION } = require('./firestore');
const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
```

## Verifikation

1. `cd backend && npm test` — alle 285 Tests müssen bestehen ✅
2. Manueller Test:
   - Produkt öffnen → "Bearbeiten" → Titel ändern → "Speichern"
   - 2 Minuten warten (mind. 2 Polling-Zyklen)
   - Seite neu laden → Titel muss der manuell gesetzte sein
3. Backend-Logs prüfen:
   - `[saveProductV2]` darf keine Fehler loggen
   - Dual-Write soll aus `products_v2` lesen (gleiche Collection wie saveProduct)

## Impact

Dieser Bug betraf **ALLE manuellen Änderungen** über das ProductSheet:
- Titel
- Beschreibungen
- Attribute
- Preise
- Barcodes
- Kategorie

Alles, was der User über die UI änderte, wurde durch den Dual-Write mit Legacy-Daten überschrieben.

## Deployment

Backend-Änderung → Cloud Run Redeploy erforderlich.
