# Claude Code Prompt: Stock-Consistency-Fixes (P0 + Phase 2)

## SESSION START

1. Lies `CLAUDE.md` — Goldene Regeln, Architektur, Non-Negotiables
2. Lies `TASKS.md` — Offene Bugs (BUG-068, BUG-070, BUG-071)
3. Lies `docs/analysis/stock-consistency-deep-dive.md` — vollständige Root-Cause-Analyse
4. `cd backend && npm test && npm run build` — grüne Baseline sichern

## REGELN

1. **CLAUDE.md ist Gesetz** — CommonJS, 2 Spaces, Single Quotes, async/await, tenantId überall
2. **Goldene Regel:** Production darf NICHT negativ beeinflusst werden
3. **Yellow Zone Dateien** — `order-state-machine.js`, `sync-event-bus.js`, `stock-sync-dispatcher.js` sind Yellow Zone. Änderungen nur wie hier beschrieben
4. **Kein Breaking Change** an bestehenden Exports oder Signaturen
5. **Additive Only** — bestehende Funktionen erweitern, nicht ersetzen
6. **Jede Änderung einzeln testen** — nach jeder Datei `npm test` laufen lassen
7. **BaseLinker ist TABU** — keine neuen Referenzen
8. **Tests:** Vitest mit require.cache-Patching (kein vi.mock für CJS). Siehe bestehende Tests als Vorlage
9. **Conventional Commits** — `fix:` Prefix für alle Commits

## IST-ZUSTAND (Probleme)

AvyCloud kann keinen konsistenten Bestand über Lager, Marktplätze, Bestellungen und Retouren aufrechterhalten. 4 kritische Schwachstellen identifiziert:

### Problem 1: Kein Lock bei parallelen Stock-Operationen
- **Wo:** Gesamter Stock-Flow — kein Schutz gegen parallele Aufrufe für dieselbe SKU
- **Effekt:** Concurrent Syncs lesen denselben Bestand, pushen widersprüchliche Werte an eBay/Kaufland
- **Beispiel:** 2 Orders mit gleicher SKU werden gleichzeitig versendet → beide lesen qty=50, beide dekrementieren unabhängig → Ergebnis falsch

### Problem 2: Order-Intake nicht atomar mit Reservierung
- **Wo:** `services/order-intake-ebay.js` Zeilen 226-255, `services/order-intake-kaufland.js` (gleicher Pattern)
- **Effekt:** Bestellung wird gespeichert (Z.226), Reservierung erfolgt ERST DANACH in separater Schleife (Z.244-255). Crash/Timeout dazwischen = Order ohne Reservierung = Oversell
- **Code:**
  ```js
  // Z.226: Bestellung speichern
  const saved = await saveOrderIfNew({ tenantId, order });
  // ... Schleife läuft weiter ...
  // Z.244-255: Reservierungen ERST NACH der Hauptschleife
  for (const order of newOrders) {
    await reserveStock({ tenantId, orderId, items });
  }
  ```

### Problem 3: _onOrderShipped() hat 3 unabhängige, nicht-recoverable Schritte
- **Wo:** `services/order-state-machine.js` Zeilen 216-279
- **Effekt:** confirmReservation (Z.222) kann fehlschlagen → decrement (Z.250) läuft trotzdem → reservedQty bleibt in Berechnung → available zu niedrig
- **Zusätzlich:** Wenn decrement fehlschlägt, wird der Fehler nur geloggt (Z.253), kein Retry, kein Persistieren
- **Code:**
  ```js
  // Z.220-226: Confirm kann fehlschlagen, kein Return!
  try {
    await confirmReservation({ tenantId, orderId });
  } catch (err) {
    console.warn('...'); // Läuft trotzdem weiter!
  }
  // Z.247-254: Decrement kann auch fehlschlagen
  try {
    await decrementProductByIdOrSku(sku, sold);
  } catch (err) {
    console.error('...'); // Nur geloggt, kein Retry!
  }
  ```

### Problem 4: Abgelaufene Reservierungen werden nie aufgeräumt
- **Wo:** `services/stock-reservation.js` Zeile 199-223 (`expireStaleReservations()`)
- **Wo NICHT:** `index.js` — **kein Cronjob** ruft `expireStaleReservations()` auf!
- **Effekt:** Phantom-Reservierungen akkumulieren → `getReservedQuantity()` zählt sie als `status='reserved'` → verfügbarer Bestand fällt immer weiter → Marktplätze zeigen 0 obwohl Ware auf Lager
- **`getReservedQuantity()`** (Z.149-168) filtert nur `status='reserved'` — abgelaufene aber nicht aufgeräumte Einträge zählen weiter!

## 5 ÄNDERUNGEN

### Änderung 1: Stock-Lock pro SKU (NEUES MODUL)

**Neue Datei:** `backend/lib/stock-lock.js`

Erstelle ein einfaches In-Memory-Lock pro SKU/ProductId. Verhindert parallele Stock-Operationen für dasselbe Produkt.

```js
/**
 * In-Memory Lock per SKU / productId.
 * Prevents concurrent stock operations for the same entity.
 *
 * Usage:
 *   const release = await acquireStockLock(sku);
 *   try { ... } finally { release(); }
 *
 * Or:
 *   await withStockLock(sku, async () => { ... });
 */

const _locks = new Map(); // key → { promise, resolve }

async function acquireStockLock(key, timeoutMs = 15000) {
  const startMs = Date.now();
  while (_locks.has(key)) {
    const elapsed = Date.now() - startMs;
    if (elapsed > timeoutMs) {
      console.warn(`[stock-lock] Timeout waiting for lock: ${key} (${timeoutMs}ms)`);
      break; // Don't deadlock — proceed with warning
    }
    await _locks.get(key).promise;
  }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  _locks.set(key, { promise, resolve });
  return () => {
    _locks.delete(key);
    resolve();
  };
}

async function withStockLock(key, fn, timeoutMs = 15000) {
  const release = await acquireStockLock(key, timeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { acquireStockLock, withStockLock };
```

**Integration in `services/stock-sync-dispatcher.js`:**
- `syncStockToAllChannels()` mit `withStockLock(productId, ...)` wrappen
- Nur den Body der Funktion wrappen, Signatur bleibt identisch

**Integration in `services/order-state-machine.js`:**
- Die SKU-Schleife in `_onOrderShipped()` (Z.247-278) mit `withStockLock(sku, ...)` wrappen

---

### Änderung 2: Order-Intake sofort reservieren (BEIDE Intake-Files)

**Datei:** `services/order-intake-ebay.js`

Die Reservierung muss SOFORT nach `saveOrderIfNew()` erfolgen, nicht erst am Ende der Schleife.

**IST (Z.225-255):**
```js
for (const order of result.orders) {
  const saved = await saveOrderIfNew({ tenantId, order });
  if (saved) {
    totalSynced++;
    newOrders.push(order);
    // ... SKU sammeln
  }
}
// Reservierung erst NACH der Schleife
for (const order of newOrders) {
  await reserveStock({ ... });
}
```

**SOLL:**
```js
for (const order of result.orders) {
  const saved = await saveOrderIfNew({ tenantId, order });
  if (saved) {
    totalSynced++;
    newOrders.push(order);
    for (const item of (order.items || [])) {
      const sku = String(item.sku || '').trim();
      if (sku) newOrderSkus.add(sku);
    }

    // SOFORT reservieren — nicht erst am Ende
    try {
      const orderId = `ebay__${order.marketplaceOrderId}`;
      const items = (order.items || []).map((item) => ({
        sku: item.sku || null,
        quantity: item.quantity || 1,
      }));
      await reserveStock({ tenantId, orderId, items });
    } catch (err) {
      console.warn(`[ebay-intake] reserveStock failed for ${order.marketplaceOrderId}: ${err.message}`);
    }
  } else {
    totalSkipped++;
  }
}

// Die alte separate Reservierungs-Schleife (Z.244-255) ENTFERNEN
```

**Datei:** `services/order-intake-kaufland.js` — gleicher Pattern. Finde die Stelle wo `reserveStock()` in einer separaten Schleife nach dem Haupt-Loop aufgerufen wird und verschiebe den Aufruf direkt nach `saveOrderIfNew()`.

---

### Änderung 3: _onOrderShipped() Failure-Recovery

**Datei:** `services/order-state-machine.js`, Funktion `_onOrderShipped()` (Z.216-279)

Failures müssen in Firestore persistiert werden damit ein Recovery-Job sie nacharbeiten kann.

**SOLL (Zeile 216 ff. ersetzen):**
```js
async function _onOrderShipped({ orderId, tenantId }) {
  const db = getDb();
  const failures = [];

  // 1. Confirm reservation
  try {
    const { confirmReservation } = require('./stock-reservation');
    const res = await confirmReservation({ tenantId, orderId });
    console.log(`[order-state-machine] confirmReservation orderId=${orderId} confirmed=${res.confirmed}`);
  } catch (err) {
    console.warn(`[order-state-machine] confirmReservation failed orderId=${orderId}: ${err.message}`);
    failures.push({ step: 'confirmReservation', error: err.message });
  }

  // 2. Fetch order
  const orderDoc = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data();
  const items = order.items || [];
  if (items.length === 0) return;

  // 3. Decrement + Sync per SKU (mit Stock-Lock)
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  const { decrementProductByIdOrSku } = require('../lib/warehouse');
  const { firestore: fs } = require('../lib/firestore');
  const { withStockLock } = require('../lib/stock-lock');

  const skuQtyMap = {};
  for (const item of items) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    skuQtyMap[sku] = (skuQtyMap[sku] || 0) + (Number(item.quantity) || 1);
  }

  for (const [sku, sold] of Object.entries(skuQtyMap)) {
    await withStockLock(sku, async () => {
      try {
        await decrementProductByIdOrSku(sku, sold);
        console.log(`[order-state-machine] stock-out sku=${sku} qty=${sold} (bins + inventory decremented)`);
      } catch (err) {
        console.error(`[order-state-machine] decrementProductByIdOrSku failed sku=${sku}: ${err.message}`);
        failures.push({ step: 'decrement', sku, qty: sold, error: err.message });
      }

      try {
        let snap = await fs.collection('products_v2')
          .where('identification.sku', '==', sku)
          .limit(1)
          .get();
        if (snap.empty) {
          snap = await fs.collection('products_v2')
            .where('details.identifiers.sku', '==', sku)
            .limit(1)
            .get();
        }
        if (!snap.empty) {
          const doc = snap.docs[0];
          const product = { id: doc.id, ...doc.data() };
          await syncStockWithRetry({ tenantId, product, reason: `shipped-${orderId}` });
        }
      } catch (err) {
        console.warn(`[order-state-machine] marketplace sync failed sku=${sku}: ${err.message}`);
        failures.push({ step: 'marketplaceSync', sku, error: err.message });
      }
    });
  }

  // Persist failures for recovery
  if (failures.length > 0) {
    try {
      await db.collection('stock_operation_failures').add({
        tenantId,
        orderId,
        operation: 'shipped',
        failures,
        status: 'pending', // Recovery-Job kann auf 'resolved' setzen
        createdAt: new Date().toISOString(),
      });
      console.error(`[order-state-machine] ${failures.length} stock failures for ${orderId} persisted to stock_operation_failures`);
    } catch (persistErr) {
      console.error(`[order-state-machine] CRITICAL: Failed to persist stock failures for ${orderId}:`, persistErr.message);
    }
  }
}
```

---

### Änderung 4: Reservation-Cleanup Cronjob

**Datei:** `backend/index.js` — NACH den bestehenden `setInterval`-Blöcken (nach Z.247)

**Neuen Block hinzufügen:**
```js
// Safety-net: expire stale stock reservations every 5 minutes
const RESERVATION_CLEANUP_MS = parseInt(process.env.RESERVATION_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10);
try {
  setTimeout(() => {
    const { expireStaleReservations } = require('./services/stock-reservation');
    expireStaleReservations()
      .then((r) => { if (r.expired > 0) console.log(`[reservation-cleanup] Expired ${r.expired} stale reservations`); })
      .catch((err) => console.warn('[reservation-cleanup] failed:', err?.message));
  }, 30_000); // 30s initial delay
  setInterval(() => {
    const { expireStaleReservations } = require('./services/stock-reservation');
    expireStaleReservations()
      .then((r) => { if (r.expired > 0) console.log(`[reservation-cleanup] Expired ${r.expired} stale reservations`); })
      .catch((err) => console.warn('[reservation-cleanup] failed:', err?.message));
  }, RESERVATION_CLEANUP_MS);
  console.log(`[reservation-cleanup] safety-net enabled: every ${RESERVATION_CLEANUP_MS}ms`);
} catch (err) {
  console.warn('[reservation-cleanup] failed to start:', err?.message || err);
}
```

**Zusätzlich:** In `services/stock-reservation.js` → `getReservedQuantity()` (Z.149-168) einen Expiry-Filter hinzufügen, damit auch ohne Cleanup abgelaufene Reservierungen NICHT mitgezählt werden:

**IST (Z.149-168):**
```js
async function getReservedQuantity({ tenantId = 'default', sku, productId }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved');
  // ...
}
```

**SOLL:** Ergebnisse filtern — nur Reservierungen zählen deren `expiresAt` in der Zukunft liegt:
```js
async function getReservedQuantity({ tenantId = 'default', sku, productId }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved');

  if (sku) {
    query = query.where('sku', '==', sku);
  } else if (productId) {
    query = query.where('productId', '==', productId);
  } else {
    return 0;
  }

  const snap = await query.get();
  const now = new Date().toISOString();
  let total = 0;
  snap.docs.forEach((doc) => {
    const data = doc.data();
    // Skip expired reservations even if cleanup hasn't run yet
    if (data.expiresAt && data.expiresAt < now) return;
    total += Number(data.quantity) || 0;
  });
  return total;
}
```

---

### Änderung 5: Stock-Lock in syncStockToAllChannels()

**Datei:** `services/stock-sync-dispatcher.js`, Funktion `syncStockToAllChannels()`

Den gesamten Body der Funktion in `withStockLock(productId, ...)` wrappen. Die Signatur bleibt identisch.

**IST:**
```js
async function syncStockToAllChannels({ tenantId = 'default', product, reason = 'manual' }) {
  // ... gesamter Body
  return { results };
}
```

**SOLL:**
```js
async function syncStockToAllChannels({ tenantId = 'default', product, reason = 'manual' }) {
  const productId = product?.id || 'unknown';
  const { withStockLock } = require('../lib/stock-lock');

  return withStockLock(`sync:${productId}`, async () => {
    // ... gesamter originaler Body (unverändert)
    return { results };
  });
}
```

Beachte: Der Lock-Key nutzt `sync:` Prefix damit er nicht mit den SKU-Locks aus `_onOrderShipped()` kollidiert.

---

## TESTS

**Neue Testdatei:** `backend/__tests__/stock-consistency.test.js`

Mindestens diese Tests:

```
describe('stock-lock')
  ✓ serialisiert parallele Aufrufe für denselben Key
  ✓ erlaubt parallele Aufrufe für verschiedene Keys
  ✓ Timeout bricht Lock nach 15s ab (ohne Deadlock)
  ✓ Lock wird auch bei Exception im Callback released

describe('getReservedQuantity expiry filter')
  ✓ zählt NICHT-abgelaufene Reservierungen
  ✓ ignoriert abgelaufene Reservierungen (expiresAt < now)
  ✓ Reservierung ohne expiresAt wird trotzdem gezählt (Backwards-Compat)

describe('_onOrderShipped failure persistence')
  ✓ persistiert Failures in stock_operation_failures Collection
  ✓ läuft alle Schritte auch wenn confirm fehlschlägt
```

Nutze das bestehende Test-Pattern aus `backend/__tests__/` — require.cache-Patching für Mocks, keine vi.mock().

---

## BUILD-REIHENFOLGE

1. **Schritt 0:** `cd backend && npm test && npm run build` — Baseline grün
2. **Schritt 1:** `lib/stock-lock.js` erstellen + Unit-Tests → `npm test`
3. **Schritt 2:** `services/stock-reservation.js` → Expiry-Filter in `getReservedQuantity()` + Test → `npm test`
4. **Schritt 3:** `index.js` → Reservation-Cleanup-Cronjob einfügen → `npm test`
5. **Schritt 4:** `services/order-intake-ebay.js` → Reservierung inline verschieben → `npm test`
6. **Schritt 5:** `services/order-intake-kaufland.js` → Reservierung inline verschieben → `npm test`
7. **Schritt 6:** `services/order-state-machine.js` → `_onOrderShipped()` mit Failure-Recovery + Stock-Lock → `npm test`
8. **Schritt 7:** `services/stock-sync-dispatcher.js` → `syncStockToAllChannels()` mit Stock-Lock wrappen → `npm test`
9. **Schritt 8:** Alle Tests grün? → `npm run build` → fertig

## WARNUNG

- `index.js` ist **Red Zone** — nur die `setInterval`-Blöcke hinzufügen, NICHTS anderes ändern
- `order-state-machine.js` und `stock-sync-dispatcher.js` sind **Yellow Zone** — Änderungen NUR wie hier beschrieben
- **Keine neuen Dependencies** — `stock-lock.js` und `stock-reconciliation.js` nutzen nur native JS + bestehende Module
- **Kein BaseLinker** — selbsterklärend aber zur Sicherheit: KEINE BaseLinker-Referenzen
- `stock_operation_failures`, `stock_reconciliation_log`, `restock_alerts` sind NEUE Firestore Collections — kein Schema-Change an bestehenden Collections
- `returns-engine.js` ist **Yellow Zone** — nur die eine Zeile in `restockItem()` hinzufügen

---

## PHASE 2: FIX-E (Reconciliation) + FIX-G (Retoure-Alert)

> Phase 2 baut auf Phase 1 (Änderungen 1-5) auf. Implementiere Phase 2 NACH Phase 1.

---

### Änderung 6: Stock Reconciliation Job (NEUER SERVICE)

**Neue Datei:** `backend/services/stock-reconciliation.js`

Zwei-Tier Reconciliation:

- **Tier 1 — Activity-based (alle 30 Min):** Prüft nur Produkte mit kürzlicher Stock-Aktivität
- **Tier 2 — Full Scan (1x täglich, ~3:00 Uhr nachts):** Prüft den gesamten Katalog

Beide Tiers prüfen dieselben zwei Drift-Typen:

1. **Bin-Drift:** `inventory.quantity` stimmt nicht mit Summe von `storageBins[].quantity` überein → Auto-Fix via `refreshProductInventory()`
2. **Marketplace-Drift:** eBay/Kaufland hat anderen Bestand als `availableQty` → Auto-Fix via `syncStockToAllChannels()`

```js
/**
 * Stock Reconciliation Service
 *
 * Two-tier drift detection + auto-repair:
 * - Tier 1: Activity-based (every 30min) — checks products with recent stock activity
 * - Tier 2: Full scan (1x daily ~3:00 AM) — checks entire catalog
 *
 * Drift types:
 * - bin_drift: inventory.quantity != sum(storageBins[].quantity)
 * - marketplace_drift: last-synced marketplace qty != current availableQty
 *
 * Logs all results to stock_reconciliation_log collection.
 */

const { firestore } = require('../lib/firestore');
const { refreshProductInventory } = require('../lib/warehouse');
const { syncStockToAllChannels, computeAvailableQuantity } = require('./stock-sync-dispatcher');

const RECONCILIATION_LOG = 'stock_reconciliation_log';

/**
 * Tier 1: Activity-based reconciliation.
 * Queries stock_sync_log + warehouse_movements for SKUs with activity in the last hour,
 * then checks those products for drift.
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId='default']
 * @param {number} [opts.lookbackMinutes=60] — how far back to check for activity
 * @returns {Promise<{ checked: number, drifts: Array }>}
 */
async function reconcileActivityBased({ tenantId = 'default', lookbackMinutes = 60 } = {}) {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
  const affectedProductIds = new Set();

  // 1. Sammle productIds aus stock_sync_log (letzte Stunde)
  try {
    const syncSnap = await firestore.collection('stock_sync_log')
      .where('createdAt', '>=', since)
      .limit(500)
      .get();
    syncSnap.docs.forEach((doc) => {
      const pid = doc.data().productId;
      if (pid) affectedProductIds.add(pid);
    });
  } catch (err) {
    console.warn('[reconciliation] stock_sync_log query failed:', err?.message);
  }

  // 2. Sammle productIds aus warehouse_movements (letzte Stunde)
  try {
    const movSnap = await firestore.collection('warehouse_movements')
      .where('createdAt', '>=', since)
      .limit(500)
      .get();
    for (const doc of movSnap.docs) {
      const data = doc.data();
      // warehouse_movements hat productSku, nicht productId → Lookup nötig
      const sku = data.productSku;
      if (sku) {
        const pSnap = await firestore.collection('products_v2')
          .where('identification.sku', '==', sku)
          .limit(1)
          .get();
        if (!pSnap.empty) affectedProductIds.add(pSnap.docs[0].id);
      }
    }
  } catch (err) {
    console.warn('[reconciliation] warehouse_movements query failed:', err?.message);
  }

  if (affectedProductIds.size === 0) {
    return { checked: 0, drifts: [] };
  }

  console.log(`[reconciliation] Activity-based: checking ${affectedProductIds.size} products`);

  // 3. Lade betroffene Produkte und prüfe Drift
  const drifts = [];
  for (const productId of affectedProductIds) {
    try {
      const doc = await firestore.collection('products_v2').doc(productId).get();
      if (!doc.exists) continue;
      const product = { id: doc.id, ...doc.data() };
      const productDrifts = await checkAndFixDrifts(product, tenantId);
      drifts.push(...productDrifts);
    } catch (err) {
      console.warn(`[reconciliation] Failed to check ${productId}:`, err?.message);
    }
  }

  // 4. Log
  await logReconciliation({ tenantId, tier: 'activity', checked: affectedProductIds.size, drifts });
  return { checked: affectedProductIds.size, drifts };
}

/**
 * Tier 2: Full catalog scan.
 * Iterates ALL products_v2 docs and checks for drift.
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId='default']
 * @returns {Promise<{ checked: number, drifts: Array }>}
 */
async function reconcileFullScan({ tenantId = 'default' } = {}) {
  console.log('[reconciliation] Full scan starting...');
  const snap = await firestore.collection('products_v2').get();
  const drifts = [];
  let checked = 0;

  for (const doc of snap.docs) {
    try {
      const product = { id: doc.id, ...doc.data() };
      // Nur Produkte mit Bestand oder Marketplace-Listing prüfen
      const hasInventory = Number(product.inventory?.quantity || 0) > 0;
      const hasBins = Array.isArray(product.storageBins) && product.storageBins.length > 0;
      const hasEbay = Boolean(product.ops?.ebay?.itemId || product.marketplace?.ebay?.itemId);
      const hasKaufland = Boolean(product.ops?.kaufland?.unitId || product.marketplace?.kaufland?.unitId);
      if (!hasInventory && !hasBins && !hasEbay && !hasKaufland) continue;

      const productDrifts = await checkAndFixDrifts(product, tenantId);
      drifts.push(...productDrifts);
      checked++;
    } catch (err) {
      console.warn(`[reconciliation] Full scan failed for ${doc.id}:`, err?.message);
    }
  }

  console.log(`[reconciliation] Full scan done: ${checked} products, ${drifts.length} drifts`);
  await logReconciliation({ tenantId, tier: 'full', checked, drifts });
  return { checked, drifts };
}

/**
 * Check a single product for bin-drift and marketplace-drift.
 * Auto-fixes drifts and returns array of drift objects.
 *
 * @param {Object} product
 * @param {string} tenantId
 * @returns {Promise<Array<{ productId, sku, type, expected, actual, delta, fixed }>>}
 */
async function checkAndFixDrifts(product, tenantId) {
  const drifts = [];
  const productId = product.id;
  const sku = product.identification?.sku || product.details?.identifiers?.sku || '';

  // ── Drift 1: Bin-Total vs inventory.quantity ──
  const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
  const binTotal = bins.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
  const inventoryQty = Number(product.inventory?.quantity ?? 0);

  if (binTotal !== inventoryQty) {
    console.warn(`[reconciliation] BIN DRIFT: ${productId} (sku=${sku}) bins=${binTotal} inventory=${inventoryQty}`);
    let fixed = false;
    try {
      await refreshProductInventory(productId);
      fixed = true;
    } catch (err) {
      console.error(`[reconciliation] refreshProductInventory failed for ${productId}:`, err?.message);
    }
    drifts.push({
      productId, sku,
      type: 'bin_drift',
      expected: binTotal,
      actual: inventoryQty,
      delta: binTotal - inventoryQty,
      fixed,
    });
  }

  // ── Drift 2: Marketplace vs availableQty ──
  try {
    const { availableQty } = await computeAvailableQuantity(product, tenantId);
    const lastSyncedQty = product.ops?.lastSyncedQuantity;

    // Nur prüfen wenn wir wissen was zuletzt gesynct wurde
    if (lastSyncedQty !== undefined && lastSyncedQty !== availableQty) {
      console.warn(`[reconciliation] MARKETPLACE DRIFT: ${productId} (sku=${sku}) synced=${lastSyncedQty} available=${availableQty}`);
      let fixed = false;
      try {
        await syncStockToAllChannels({ tenantId, product, reason: 'reconciliation' });
        fixed = true;
      } catch (err) {
        console.error(`[reconciliation] syncStockToAllChannels failed for ${productId}:`, err?.message);
      }
      drifts.push({
        productId, sku,
        type: 'marketplace_drift',
        expected: availableQty,
        actual: lastSyncedQty,
        delta: availableQty - lastSyncedQty,
        fixed,
      });
    }
  } catch (err) {
    // computeAvailableQuantity kann fehlschlagen wenn Reservierungs-Query Error hat
    console.warn(`[reconciliation] availableQty check failed for ${productId}:`, err?.message);
  }

  return drifts;
}

/**
 * Log reconciliation results to Firestore.
 */
async function logReconciliation({ tenantId, tier, checked, drifts }) {
  try {
    await firestore.collection(RECONCILIATION_LOG).add({
      tenantId,
      tier,
      checked,
      driftCount: drifts.length,
      drifts: drifts.slice(0, 100), // Max 100 drifts pro Log-Eintrag
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[reconciliation] Failed to log results:', err?.message);
  }
}

module.exports = {
  reconcileActivityBased,
  reconcileFullScan,
  checkAndFixDrifts,
};
```

**WICHTIG — `ops.lastSyncedQuantity` setzen:**

In `services/stock-sync-dispatcher.js` → `syncStockToAllChannels()` — NACH erfolgreichem Sync die zuletzt gepushte Menge auf dem Produkt speichern, damit die Reconciliation Marketplace-Drift erkennen kann:

Am ENDE der Funktion, nach dem `stock_sync_log`-Write, diesen Block hinzufügen:

```js
// Track last-synced quantity for reconciliation drift detection
try {
  if (productId && productId !== 'unknown') {
    await firestore.collection('products_v2').doc(productId).update({
      'ops.lastSyncedQuantity': availableQty,
      'ops.lastSyncedAt': new Date().toISOString(),
    });
  }
} catch (err) {
  // best-effort — do not fail sync for tracking write
  console.warn(`[stock-sync] lastSyncedQuantity write failed for ${productId}:`, err?.message);
}
```

Stelle sicher dass `availableQty` und `productId` im Scope sind (sind sie — `availableQty` wird oben berechnet, `productId` wird zu Beginn aus `product.id` extrahiert).

---

**Integration in `backend/index.js`** — NACH dem Reservation-Cleanup-Block aus Änderung 4:

```js
// Safety-net: stock reconciliation every 30min (activity-based) + full scan at ~3:00 AM
const RECONCILIATION_INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS || String(30 * 60 * 1000), 10);
let _lastFullScanDate = null; // Track so we only run once per day
try {
  setTimeout(() => {
    const { reconcileActivityBased } = require('./services/stock-reconciliation');
    reconcileActivityBased()
      .then((r) => { if (r.drifts.length > 0) console.log(`[reconciliation] Activity: ${r.drifts.length} drifts fixed (${r.checked} products)`); })
      .catch((err) => console.warn('[reconciliation] activity-based failed:', err?.message));
  }, 120_000); // 2 min initial delay (after other safety-nets start)

  setInterval(async () => {
    try {
      // Tier 2: Full scan at ~3:00 AM (once per day)
      const now = new Date();
      const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
      if (now.getHours() === 3 && now.getMinutes() < 30 && _lastFullScanDate !== today) {
        _lastFullScanDate = today;
        const { reconcileFullScan } = require('./services/stock-reconciliation');
        const fullResult = await reconcileFullScan();
        if (fullResult.drifts.length > 0) {
          console.log(`[reconciliation] Full scan: ${fullResult.drifts.length} drifts fixed (${fullResult.checked} products)`);
        }
        return; // Don't also run activity-based in the same cycle
      }

      // Tier 1: Activity-based (every 30min)
      const { reconcileActivityBased } = require('./services/stock-reconciliation');
      const result = await reconcileActivityBased();
      if (result.drifts.length > 0) {
        console.log(`[reconciliation] Activity: ${result.drifts.length} drifts fixed (${result.checked} products)`);
      }
    } catch (err) {
      console.warn('[reconciliation] interval failed:', err?.message);
    }
  }, RECONCILIATION_INTERVAL_MS);
  console.log(`[reconciliation] safety-net enabled: activity every ${RECONCILIATION_INTERVAL_MS}ms, full scan daily ~3:00 AM`);
} catch (err) {
  console.warn('[reconciliation] failed to start:', err?.message || err);
}
```

---

### Änderung 7: Retoure-Wiedereinlagerungs-Alert (FIX-G)

**Problem:** `restockItem()` in `services/returns-engine.js` (Z.284-316) loggt nur eine `warehouse_movements`-Einträge mit `type: 'restock_return'`, aber ruft NICHT `bookStockIn()` auf. Das ist by Design (QC-Prüfung). Aber es gibt keinen Alert wenn die Wiedereinlagerung vergessen wird.

**Lösung:** Nach dem `warehouse_movements`-Write in `restockItem()` einen `restock_alerts`-Eintrag erstellen. Ein Checker-Job prüft regelmäßig ob ein entsprechender `bookStockIn()` erfolgt ist.

**Datei:** `services/returns-engine.js`, Funktion `restockItem()` (Z.284-316)

NACH dem bestehenden `warehouse_movements.add()` (Z.304-315) diesen Block hinzufügen:

```js
  // Create restock alert — will be checked/resolved by reconciliation job
  try {
    await db.collection('restock_alerts').add({
      tenantId,
      returnId,
      orderId,
      productSku: returnedItem.sku || null,
      productName: returnedItem.name || null,
      quantity: returnedItem.quantity || 1,
      condition: itemCondition,
      status: 'pending', // → 'resolved' when bookStockIn happens, 'overdue' after 24h
      createdAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h deadline
    });
  } catch (alertErr) {
    console.warn(`[returns-engine] Failed to create restock alert for ${returnId}:`, alertErr?.message);
  }
```

**Checker-Logik in `services/stock-reconciliation.js`:**

Neue exportierte Funktion hinzufügen:

```js
/**
 * Check for overdue restock alerts.
 * A restock_alert is overdue when:
 * - status='pending' AND dueAt < now
 * - No matching bookStockIn found in warehouse_movements after the alert was created
 *
 * Updates status to 'overdue' and logs a warning.
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId='default']
 * @returns {Promise<{ checked: number, overdue: number }>}
 */
async function checkRestockAlerts({ tenantId = 'default' } = {}) {
  const now = new Date().toISOString();

  const snap = await firestore.collection('restock_alerts')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'pending')
    .where('dueAt', '<', now)
    .limit(200)
    .get();

  if (snap.empty) return { checked: 0, overdue: 0 };

  let overdue = 0;
  const batch = firestore.batch();

  for (const doc of snap.docs) {
    const data = doc.data();
    const sku = data.productSku;

    // Check if a bookStockIn happened after the alert was created
    let restocked = false;
    if (sku) {
      try {
        const movSnap = await firestore.collection('warehouse_movements')
          .where('productSku', '==', sku)
          .where('type', '==', 'stock_in')
          .where('createdAt', '>', data.createdAt)
          .limit(1)
          .get();
        restocked = !movSnap.empty;
      } catch {
        // Query kann fehlschlagen wenn kein Index existiert — treat as not found
      }

      // Fallback: check warehouseEvents (bookStockIn uses this)
      if (!restocked) {
        try {
          const evSnap = await firestore.collection('warehouseEvents')
            .where('productSku', '==', sku)
            .where('type', '==', 'stock_in')
            .where('createdAt', '>', data.createdAt)
            .limit(1)
            .get();
          restocked = !evSnap.empty;
        } catch {
          // ignore
        }
      }
    }

    if (restocked) {
      // Already restocked — resolve the alert silently
      batch.update(doc.ref, { status: 'resolved', resolvedAt: now });
    } else {
      // Overdue — mark and warn
      batch.update(doc.ref, { status: 'overdue', overdueAt: now });
      overdue++;
      console.warn(`[restock-alert] OVERDUE: SKU=${sku} from return ${data.returnId} (${data.condition}) — not restocked within 24h`);
    }
  }

  await batch.commit();
  return { checked: snap.docs.length, overdue };
}
```

Exportiere die neue Funktion:
```js
module.exports = {
  reconcileActivityBased,
  reconcileFullScan,
  checkAndFixDrifts,
  checkRestockAlerts,
};
```

**Integration in `index.js`** — Im Reconciliation-Interval (innerhalb des bestehenden `setInterval` aus Änderung 6), den Restock-Alert-Check NACH der Activity-Reconciliation aufrufen:

```js
// Im setInterval-Block von Änderung 6, nach reconcileActivityBased():
try {
  const { checkRestockAlerts } = require('./services/stock-reconciliation');
  const alertResult = await checkRestockAlerts();
  if (alertResult.overdue > 0) {
    console.warn(`[restock-alert] ${alertResult.overdue} overdue restock alerts!`);
  }
} catch (err) {
  console.warn('[restock-alert] check failed:', err?.message);
}
```

---

## PHASE 2 TESTS

Zur bestehenden Testdatei `backend/__tests__/stock-consistency.test.js` hinzufügen:

```
describe('stock-reconciliation')
  ✓ checkAndFixDrifts erkennt bin_drift wenn bins != inventory.quantity
  ✓ checkAndFixDrifts erkennt marketplace_drift wenn lastSyncedQuantity != availableQty
  ✓ checkAndFixDrifts returned leeres Array wenn kein Drift
  ✓ reconcileActivityBased findet Produkte aus stock_sync_log der letzten Stunde
  ✓ reconcileFullScan überspringt Produkte ohne Bestand/Listings

describe('restock-alerts')
  ✓ restockItem() erstellt restock_alerts Eintrag mit status=pending
  ✓ checkRestockAlerts markiert überfällige Alerts als overdue
  ✓ checkRestockAlerts resolved Alerts wenn bookStockIn erfolgt ist
```

---

## PHASE 2 BUILD-REIHENFOLGE

> Phase 1 (Schritte 0-8) muss bereits abgeschlossen sein.

9. **Schritt 9:** `services/stock-reconciliation.js` erstellen (reconcileActivityBased + reconcileFullScan + checkAndFixDrifts) + Tests → `npm test`
10. **Schritt 10:** `services/stock-sync-dispatcher.js` → `ops.lastSyncedQuantity` nach Sync setzen → `npm test`
11. **Schritt 11:** `services/returns-engine.js` → `restock_alerts` Eintrag in `restockItem()` hinzufügen → `npm test`
12. **Schritt 12:** `services/stock-reconciliation.js` → `checkRestockAlerts()` hinzufügen + Tests → `npm test`
13. **Schritt 13:** `index.js` → Reconciliation-Interval + Restock-Alert-Check hinzufügen → `npm test`
14. **Schritt 14:** Alle Tests grün? → `npm run build` → fertig
