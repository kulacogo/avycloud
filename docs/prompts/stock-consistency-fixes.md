# Claude Code Prompt: Stock-Consistency-Fixes (P0)

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

- `index.js` ist **Red Zone** — nur den einen `setInterval`-Block hinzufügen, NICHTS anderes ändern
- `order-state-machine.js` und `stock-sync-dispatcher.js` sind **Yellow Zone** — Änderungen NUR wie hier beschrieben
- **Keine neuen Dependencies** — `stock-lock.js` nutzt nur native JS (Map, Promise)
- **Kein BaseLinker** — selbsterklärend aber zur Sicherheit: KEINE BaseLinker-Referenzen
- `stock_operation_failures` ist eine NEUE Firestore Collection — kein Schema-Change an bestehenden Collections
