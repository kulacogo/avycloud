# BUG-085: Dual-Write erzeugt Duplikate durch _pickCanonicalId

## Priorität: P0 (Datenintegrität — doppelte Produkte in Inventar/Listings)

## Problem

Produkte erscheinen doppelt in der Inventar-Tabelle mit identischer SKU, EAN, Preis, BIN-Zuordnung.
Beispiel: "Anker Powerbank Kunststoff A1689" (SKU-4251788962) existiert 2x in `products_v2`.

## Root Cause

`saveProductV2()` in `backend/lib/product-store.js` schreibt das Produkt unter **zwei verschiedenen Document-IDs**:

### Schritt 1: `saveProduct()` (firestore.js)
Schreibt das Produkt unter der **Original-ID** (z.B. UUID oder EAN-basiert) nach `products_v2`:
```js
const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(product.id);
// ...
await docRef.set(productWithEbay);
```

### Schritt 2: Dual-Write in `saveProductV2()` (product-store.js)
Liest das Produkt zurück, normalisiert es — und `normalizeProduct()` ruft `_pickCanonicalId()` auf:
```js
// product-canonical.js Zeile 95-98:
const canonicalId = _pickCanonicalId(product);
if (canonicalId && canonicalId !== product.id) {
  product.ops._originalId = product.id;
  product.id = canonicalId;  // ← ID ÄNDERT SICH!
}
```

Dann schreibt der Dual-Write unter der **kanonischen ID** (z.B. EAN `0194644170721`):
```js
// product-store.js Zeile 60-61:
const targetId = normalized.id || productId;  // normalized.id ≠ productId!
await firestore.collection(V2_COLLECTION).doc(targetId).set(normalized, { merge: true });
```

### Ergebnis
Zwei Dokumente in `products_v2`:
- Doc `original-uuid-123` → Original von saveProduct()
- Doc `0194644170721` → Kanonisierte Kopie vom Dual-Write

Beide haben identische SKU, EAN, Titel, Preis, BIN → **Duplikat in der UI**.

## Analyse: Warum existiert der Dual-Write überhaupt?

Der Dual-Write wurde eingeführt als `PRODUCTS_COLLECTION` noch `'products'` war.
Damals war der Flow:
1. `saveProduct()` → schreibt nach `products` (Legacy)
2. Dual-Write → liest aus `products`, normalisiert, schreibt nach `products_v2`

**Jetzt** mit `USE_PRODUCTS_V2=true`:
- `PRODUCTS_COLLECTION = 'products_v2'`
- `saveProduct()` schreibt DIREKT nach `products_v2`
- Der Dual-Write ist **redundant** — er liest aus `products_v2` und schreibt nach `products_v2`
- Schlimmer: durch `_pickCanonicalId()` schreibt er unter einer ANDEREN ID → Duplikat

## Fix

### Fix A: Dual-Write deaktivieren wenn `PRODUCTS_COLLECTION === V2_COLLECTION`

**Datei:** `backend/lib/product-store.js`

```js
async function saveProductV2(product, options = {}) {
  const result = await saveProduct(product, options);

  // Dual-Write ist nur nötig wenn saveProduct() in eine ANDERE Collection schreibt.
  // Wenn PRODUCTS_COLLECTION bereits 'products_v2' ist, schreibt saveProduct()
  // direkt dorthin → Dual-Write wäre redundant und erzeugt durch _pickCanonicalId
  // sogar Duplikate unter abweichenden Document-IDs.
  const { PRODUCTS_COLLECTION } = require('./firestore');
  const isDualWriteNeeded = PRODUCTS_COLLECTION !== V2_COLLECTION;

  if (USE_V2 && isDualWriteNeeded) {
    try {
      const productId = product.id;
      const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      const freshData = freshSnap.exists ? { id: productId, ...freshSnap.data() } : product;

      const normalized = normalizeProduct(freshData);
      const validation = validateCanonical(normalized);
      if (!validation.valid) {
        console.error(`[saveProductV2] Validation failed for ${productId}:`, validation.errors);
        normalized.ops._validationErrors = validation.errors;
      }

      const targetId = normalized.id || productId;
      await firestore.collection(V2_COLLECTION).doc(targetId).set(normalized, { merge: true });
    } catch (err) {
      console.error(`[saveProductV2] v2 write failed for ${product.id}: ${err.message}`);
    }
  }

  return result;
}
```

### Fix B: Bestehende Duplikate bereinigen (Cleanup-Script)

**Neues Script:** `backend/scripts/dedupe-products-v2.js`

Logik:
1. Alle Dokumente aus `products_v2` laden
2. Gruppieren nach SKU (normalized, case-insensitive)
3. Für jede SKU-Gruppe mit >1 Dokument:
   - Bestimme das "bessere" Dokument (neueres `ops.last_saved_iso`, mehr Felder befüllt)
   - Das andere Dokument ist das Duplikat
   - Prüfe ob das Duplikat Warehouse-Daten hat die dem Primären fehlen → merge
   - Lösche das Duplikat
4. Safety: Dry-run default, `--apply` zum tatsächlichen Löschen
5. Log: Welche Dokument-IDs zusammengelegt wurden

```js
// Pseudo-Code
const allDocs = await firestore.collection('products_v2').get();
const bySku = new Map(); // SKU → [{ id, data, ... }]

allDocs.forEach(doc => {
  const sku = normalizeSkuValue(doc.data()?.identification?.sku);
  if (!sku) return;
  if (!bySku.has(sku)) bySku.set(sku, []);
  bySku.get(sku).push({ id: doc.id, data: doc.data() });
});

for (const [sku, docs] of bySku) {
  if (docs.length <= 1) continue;
  console.log(`DUPLICATE: SKU=${sku}, IDs=[${docs.map(d => d.id).join(', ')}]`);

  // Pick primary (prefer the one that saveProduct() wrote = the one with original product.id format)
  // Delete the canonical-ID duplicate
  // Merge any warehouse/order data before deletion
}
```

### Fix C: `_pickCanonicalId` absichern

**Datei:** `backend/lib/product-canonical.js`

Die ID-Kanonisierung darf NIE die Document-ID in Firestore ändern wenn das Produkt bereits existiert.
Entweder:
- `_pickCanonicalId()` entfernen (Empfehlung — die Normalisierung sollte Daten normalisieren, nicht IDs)
- Oder: `normalizeProduct()` bekommt ein Flag `{ preserveId: true }` das die ID-Änderung verhindert

**Empfehlung: `_pickCanonicalId` komplett deaktivieren.**

Die ID-Kanonisierung war ein Migrations-Artefakt. Jetzt wo `products_v2` primary ist und
alle IDs stabil sind, erzeugt sie nur noch Probleme. Die kanonische ID kann als
`ops.canonical_id` gespeichert werden ohne die Document-ID zu ändern.

```js
// VORHER:
const canonicalId = _pickCanonicalId(product);
if (canonicalId && canonicalId !== product.id) {
  product.ops._originalId = product.id;
  product.id = canonicalId;
}

// NACHHER:
const canonicalId = _pickCanonicalId(product);
if (canonicalId && canonicalId !== product.id) {
  product.ops._canonicalId = canonicalId; // Nur als Metadatum, NICHT als Document-ID
}
```

## Reihenfolge der Fixes

1. **Fix A** zuerst — verhindert neue Duplikate sofort
2. **Fix C** — verhindert ID-Mutation in normalizeProduct()
3. **Fix B** — bereinigt bestehende Duplikate
4. Deploy + Verify

## Tests

1. `cd backend && npm test` — alle Tests müssen bestehen
2. Unit-Test: `saveProductV2` mit `PRODUCTS_COLLECTION === V2_COLLECTION` → kein Dual-Write
3. Unit-Test: `normalizeProduct()` mit `preserveId: true` → ID bleibt unverändert
4. Cleanup-Script dry-run: prüfen wie viele Duplikate existieren
5. Manueller Test: Produkt speichern → nur 1 Dokument in `products_v2`

## Impact

- Jedes Produkt mit gültiger EAN/GTIN war potenziell betroffen
- Duplikate verfälschen: Inventar-Zählung, Bestandswerte, Listing-Export, Warehouse-Zuordnung
- Worst Case: Doppelte eBay/Kaufland Listings für dasselbe Produkt

## Deployment

Backend-Änderung → Cloud Run Redeploy erforderlich.
Cleanup-Script muss lokal oder in Cloud Shell ausgeführt werden (GCP Credentials nötig).
