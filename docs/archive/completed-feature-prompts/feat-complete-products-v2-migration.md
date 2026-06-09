# FEAT: Products-V2 Migration abschließen — Lesepfade umstellen

> Schwere: **P0** — ~292 Produkte sind im UI unsichtbar, Dateninkonsistenz
> Betrifft: `lib/firestore.js`, `routes/products.js`, `lib/warehouse.js`, `services/quality-gate.js`

## Problem

`saveProductV2()` schreibt per Dual-Write in BEIDE Collections (`products` + `products_v2`).
Aber ALLE Lesepfade lesen noch aus `products`:

- `lib/firestore.js:96` → `const PRODUCTS_COLLECTION = 'products';` (hardcoded)
- `getAllProducts()` → liest aus `products` (817 Dokumente)
- `getProduct()` → liest aus `products`
- `findProductByStrictIdentifier()` → sucht in `products`
- `findProductByIdentityKey()` → sucht in `products`
- `findProductByIdentityAliases()` → sucht in `products`
- `adjustPendingIntakeQuantity()` → schreibt auf `products`
- `services/quality-gate.js:33` → hardcoded `'products'`
- `routes/products.js:1418` (SSE stream) → `process.env.PRODUCT_COLLECTION || 'products'`

Ergebnis: 1109 Produkte in products_v2, nur 817 in products → 292 Produkte fehlen im UI.

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

FEAT: Products-V2 Lesepfad-Migration. ALLE Lesepfade müssen von `products`
auf `products_v2` umgestellt werden. Dual-Write bleibt vorerst aktiv als Safety-Net.

GOLDENE REGEL: Production darf NICHT negativ beeinflusst werden.
Deshalb: Dual-Write beibehalten, aber PRIMARY READ auf products_v2 umstellen.

---

## Schritt 1: firestore.js — PRODUCTS_COLLECTION umstellen

Datei: lib/firestore.js, Zeile 96

AKTUELL:
```js
const PRODUCTS_COLLECTION = 'products';
```

NEU:
```js
const PRODUCTS_COLLECTION = process.env.USE_PRODUCTS_V2 === 'true' ? 'products_v2' : 'products';
```

Da USE_PRODUCTS_V2=true in Production gesetzt ist (siehe CLAUDE.md), liest alles
automatisch aus products_v2. Fallback auf products wenn Flag fehlt.

ACHTUNG: Damit ändern sich SOFORT alle Funktionen in firestore.js:
- getAllProducts() → liest aus products_v2
- getProduct() → liest aus products_v2
- saveProduct() → schreibt in products_v2 (+ Dual-Write in product-store.js)
- findProductByStrictIdentifier() → sucht in products_v2
- findProductByIdentityKey() → sucht in products_v2
- deleteProduct() → löscht aus products_v2
- adjustPendingIntakeQuantity() → updated products_v2

Das ist gewollt — products_v2 ist die vollständigere Collection.

---

## Schritt 2: quality-gate.js — Hardcoded Collection entfernen

Datei: services/quality-gate.js, Zeile 33

AKTUELL:
```js
const PRODUCTS_COLLECTION = 'products';
```

NEU:
```js
const { PRODUCTS_COLLECTION } = require('../lib/firestore');
```

ODER (falls nicht exportiert):
```js
const PRODUCTS_COLLECTION = process.env.USE_PRODUCTS_V2 === 'true' ? 'products_v2' : 'products';
```

---

## Schritt 3: SSE Stream — Collection Variable

Datei: routes/products.js, Zeile 1418

AKTUELL:
```js
const COLLECTION = process.env.PRODUCT_COLLECTION || 'products';
```

NEU:
```js
const COLLECTION = process.env.USE_PRODUCTS_V2 === 'true' ? 'products_v2' : (process.env.PRODUCT_COLLECTION || 'products');
```

---

## Schritt 4: warehouse.js — Produkt-Lookup in beiden Collections

Datei: lib/warehouse.js

`refreshProductInventory()` (Zeile ~159) schreibt `storageBins` und `storage`
in die `products` Collection. Diese Funktion muss AUCH products_v2 aktualisieren.

AKTUELL (Zeile ~20):
```js
const productsCollection = firestore.collection('products');
```

NEU:
```js
const productsCollection = firestore.collection('products');
const productsV2Collection = firestore.collection('products_v2');
```

Und in `refreshProductInventory()` nach dem Update auf `productsCollection`:
```js
// Dual-write: Auch products_v2 aktualisieren
try {
  const v2Ref = productsV2Collection.doc(productId);
  const v2Snap = await v2Ref.get();
  if (v2Snap.exists) {
    await v2Ref.update({
      storageBins: updatedBins,
      storage: primaryStorage,
    });
  }
} catch (e) {
  console.warn(`[warehouse] Dual-write products_v2 failed for ${productId}:`, e.message);
}
```

Gleiches gilt für:
- `assignProductToBin()`
- `removeProductFromBin()`
- `bookStockIn()`
- `bookStockOut()`

Überall wo `productsCollection.doc(productId).update(...)` aufgerufen wird,
muss danach ein best-effort Dual-Write auf products_v2 folgen.

---

## Schritt 5: Verifizierung

1. `npm test` — alle bestehenden Tests müssen passen
2. Neuen Test schreiben: `__tests__/lib/product-collection-migration.test.js`
   - Prüfe: `PRODUCTS_COLLECTION` ist 'products_v2' wenn USE_PRODUCTS_V2=true
   - Prüfe: `PRODUCTS_COLLECTION` ist 'products' wenn USE_PRODUCTS_V2 nicht gesetzt
3. `npm run build` — keine Fehler
4. TASKS.md aktualisieren

---

## Was sich NICHT ändert

- product-store.js bleibt wie es ist (Dual-Write)
- Keine Firestore-Felder umbenannt oder gelöscht (additive only)
- Keine bestehenden Routes geändert
- Keine ENV-Vars umbenannt
- warehouse.js Grundstruktur bleibt (nur Dual-Write ergänzt)

## Risikobetrachtung

LOW RISK weil:
- products_v2 hat MEHR Daten als products (1109 vs 817)
- Dual-Write bleibt aktiv → products wird weiterhin befüllt als Fallback
- Wenn USE_PRODUCTS_V2=false: alles bleibt beim Alten
```

## Kontext

Die `decisions.md` sagt bereits: "Legacy `products` Collection ist read-only."
Aber in der Praxis liest das gesamte System noch daraus. Diese Migration schließt
die Lücke zwischen Dokumentation und Realität.

### Betroffene Stellen (vollständige Liste)

| Datei | Zeile | Problem |
|-------|-------|---------|
| lib/firestore.js | 96 | `PRODUCTS_COLLECTION = 'products'` hardcoded |
| lib/firestore.js | 2583 | `getAllProducts()` liest aus products |
| lib/firestore.js | 2511 | `getProduct()` liest aus products |
| lib/firestore.js | 2670-2738 | `findProductByStrictIdentifier()` sucht in products |
| lib/firestore.js | 2886 | `adjustPendingIntakeQuantity()` schreibt auf products |
| lib/warehouse.js | ~20 | `productsCollection = 'products'` hardcoded |
| services/quality-gate.js | 33 | `PRODUCTS_COLLECTION = 'products'` hardcoded |
| routes/products.js | 1418 | SSE stream default 'products' |
