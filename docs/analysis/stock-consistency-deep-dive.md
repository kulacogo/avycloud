# Deep Dive: Bestandsinkonsistenzen in AvyCloud

> **Datum:** 29.03.2026
> **Schweregrad:** Business-Kritisch
> **Scope:** Lager ↔ Marktplätze ↔ Bestellungen ↔ Retouren

---

## Executive Summary

AvyCloud hat **12 identifizierte Schwachstellen** in der Bestandsverwaltung, davon **4 kritisch**. Das Grundproblem: Es gibt keinen single-atomic Pfad von "Bestellung rein" bis "Bestand auf Marktplatz aktualisiert". Stattdessen laufen 3-4 separate, nicht-transaktionale Schritte hintereinander — mit Fire-and-Forget-Pattern und In-Memory Event-Bus ohne Persistenz. Jeder Schritt kann unabhängig fehlschlagen, ohne dass die anderen davon erfahren.

**Die 4 kritischsten Probleme:**

1. **Kein Distributed Lock** — Parallele Stock-Syncs für dasselbe Produkt korrupieren Daten
2. **Order-Intake nicht atomar** — Bestellung wird gespeichert aber Reservierung kann fehlen → Oversell
3. **_onOrderShipped() ohne transaktionale Grenze** — Reservierung + Dekrement + Sync sind 3 unabhängige Schritte
4. **Expired Reservations blockieren Bestand** — Kein automatischer Cleanup → Phantom-Reservierungen

---

## 1. Architektur-Überblick

### 1.1 Die 5 Schichten

```
┌──────────────────────────────────────────────────────────┐
│  MARKTPLÄTZE (eBay, Kaufland)                            │
│  → Push: reviseFixedPriceItem() / updateUnit()           │
│  → Pull: syncEbayOrders() / syncKauflandOrders()         │
├──────────────────────────────────────────────────────────┤
│  SYNC-ENGINE (stock-sync-dispatcher.js)                  │
│  → computeAvailableQuantity() = physical - reserved      │
│  → syncStockToAllChannels() → eBay + Kaufland            │
│  → Retry nach 30s bei Failure                            │
├──────────────────────────────────────────────────────────┤
│  RESERVIERUNGEN (stock-reservation.js)                   │
│  → reserveStock() bei Order-Intake                       │
│  → confirmReservation() bei Versand                      │
│  → releaseReservation() bei Stornierung                  │
│  → 72h Expiry (NICHT automatisch!)                       │
├──────────────────────────────────────────────────────────┤
│  ORDER MANAGEMENT (order-state-machine.js)               │
│  → 12-State Engine (pending → ... → completed)           │
│  → _onOrderShipped() → confirm + decrement + sync        │
│  → Fire-and-Forget Side Effects                          │
├──────────────────────────────────────────────────────────┤
│  WAREHOUSE (warehouse.js)                                │
│  → bookStockIn/Out() mit Firestore Transactions          │
│  → storageBins = Source of Truth                          │
│  → refreshProductInventory() = Recalc aus Bins           │
│  → inventory.quantity = Rollup-Summary                   │
└──────────────────────────────────────────────────────────┘
```

### 1.2 Verfügbarkeitsformel

```
availableQty = MAX(0, inventory.quantity - getReservedQuantity(sku))
```

- `inventory.quantity` = Summe aller `storageBins[].quantity` (via `refreshProductInventory()`)
- `getReservedQuantity()` = Summe aller `stock_reservations` mit `status='reserved'` für diese SKU

### 1.3 Firestore Collections

| Collection | Zweck |
|---|---|
| `products_v2` | Stammdaten + `inventory.quantity` + `storageBins[]` + Marketplace-Mappings |
| `warehouseBins` | Physischer Bestand pro Lagerplatz |
| `stock_reservations` | Soft-Locks durch Bestellungen (72h Expiry) |
| `orders` | Bestellungen mit OMS-Status |
| `returns` | Retouren-Workflow |
| `warehouse_movements` | Audit Trail (stock_in, stock_out, restock_return) |
| `stock_sync_log` | Jeder Sync-Versuch zu Marktplätzen |
| `stock_sync_failures` | Persistente Failures für Monitoring |

---

## 2. Identifizierte Schwachstellen

### KRITISCH-1: Kein Distributed Lock für Stock-Operationen

**Dateien:** Alle Stock-Sync-Pfade
**Impact:** Parallele Sync-Calls für dasselbe Produkt pushen unterschiedliche Mengen

**Szenario:**
```
T0: Order-A ships SKU-123 → _onOrderShipped()
T1: Order-B ships SKU-123 → _onOrderShipped()
T2: Beide rufen computeAvailableQuantity() → lesen inventory.quantity=50
T3: Order-A decrementiert → qty=45
T4: Order-B decrementiert (liest altes qty=50) → qty=47 ← FALSCH (sollte 42 sein)
T5: Beide pushen zu eBay/Kaufland → unterschiedliche Mengen
```

**Warum:** Kein Mutex/Lock pro SKU oder ProductId. Firestore-Transactions innerhalb einzelner Operationen schützen nur die atomare Schreiboperation selbst, nicht den gesamten Flow von Lesen → Berechnen → Schreiben → Sync.

---

### KRITISCH-2: Order-Intake nicht atomar mit Reservierung

**Datei:** `services/order-intake-ebay.js`, Zeilen 226-255
**Impact:** Bestellung existiert, aber Bestand nicht reserviert → Oversell

```javascript
// Zeile 226: Bestellung speichern
const saved = await saveOrderIfNew({ tenantId, order });

// ... andere Logik ...

// Zeile 251: Reservierung SEPARAT
await reserveStock({ tenantId, orderId, items });
```

**Szenario:**
```
T0: saveOrderIfNew() → Order gespeichert ✓
T1: Server-Crash / Timeout / Exception
T2: reserveStock() wird NIE aufgerufen
T3: Order existiert → Bestand aber NICHT reserviert
T4: Gleicher Bestand wird für andere Order verfügbar gehalten → OVERSELL
```

**Zusätzlich:** `reserveStock()` prüft NICHT ob genug physischer Bestand vorhanden ist. Es wird immer reserviert, auch wenn `reservedQty > physicalQty`.

---

### KRITISCH-3: _onOrderShipped() hat 3 unabhängige, nicht-atomare Schritte

**Datei:** `services/order-state-machine.js`, Zeilen 216-279
**Impact:** Doppelte Dekrement-Risiken, verlorene Sync-Events

```javascript
async function _onOrderShipped({ orderId, tenantId }) {
  // Schritt 1: Reservierung bestätigen (kann fehlschlagen!)
  try {
    await confirmReservation({ tenantId, orderId });
  } catch (err) {
    console.warn('confirmReservation failed');
    // KEIN RETURN → Schritt 2 läuft trotzdem!
  }

  // Schritt 2: Physischen Bestand reduzieren
  for (const [sku, sold] of Object.entries(skuQtyMap)) {
    try {
      await decrementProductByIdOrSku(sku, sold);
    } catch (err) {
      console.error('decrementProductByIdOrSku failed');
      // KEIN RETRY → Bestand bleibt falsch!
    }
  }

  // Schritt 3: Marketplace-Sync (fire-and-forget)
  syncStockWithRetry({ ... }).catch(err => console.warn('sync failed'));
}
```

**Failure-Matrix:**

| Confirm | Decrement | Sync | Ergebnis |
|---|---|---|---|
| ✓ | ✓ | ✓ | OK |
| ✗ | ✓ | ✓ | Reservierung bleibt `reserved`, Bestand trotzdem reduziert → reservedQty immer noch in Berechnung → **Available zu niedrig** |
| ✓ | ✗ | ✓ | Reservierung confirmed, Bestand NICHT reduziert → Marketplace bekommt falsche Menge |
| ✓ | ✓ | ✗ | Lokal korrekt, aber Marktplatz zeigt alten Bestand → **Oversell-Fenster** |
| ✗ | ✗ | - | Order shipped aber nichts passiert → **Kompletter Bestand-Drift** |

---

### KRITISCH-4: Expired Reservations blockieren Bestand indefinit

**Datei:** `services/stock-reservation.js`, Zeilen 199-223
**Impact:** Phantom-Reservierungen halten Bestand zurück, der verkauft werden könnte

```javascript
async function expireStaleReservations({ tenantId } = {}) {
  // Nur 500 pro Aufruf
  const snap = await query.limit(500).get();
  // Muss MANUELL oder per Cronjob aufgerufen werden
  // Kein automatischer Scheduler gefunden!
}
```

**Probleme:**
1. `expireStaleReservations()` wird **nicht automatisch** aufgerufen — kein Cronjob in `index.js` gefunden
2. Limit von 500 pro Aufruf — bei Akkumulation braucht es viele Durchläufe
3. `getReservedQuantity()` filtert nur `status='reserved'` — expired-aber-nicht-aufgeräumte Reservierungen zählen weiter als reserviert

**Konsequenz:** Nach Wochen ohne Cleanup kann der verfügbare Bestand auf den Marktplätzen bei 0 stehen, obwohl physisch alles auf Lager ist.

---

### HOCH-1: computeAvailableQuantity() liest nicht-atomar

**Datei:** `services/stock-sync-dispatcher.js`, Zeilen 49-68

```javascript
async function computeAvailableQuantity(product, tenantId) {
  const physicalQty = Number(product?.inventory?.quantity ?? 0);  // READ 1 (evtl. stale)
  // ...
  reservedQty = await getReservedQuantity({ tenantId, sku });     // READ 2 (separate Query)
  const availableQty = Math.max(0, physicalQty - reservedQty);
}
```

Zwischen READ 1 und READ 2 kann sich beides geändert haben. Keine Firestore-Transaction schützt die Berechnung.

---

### HOCH-2: Event-Bus verliert Events

**Datei:** `services/sync-event-bus.js`, Zeilen 44-65

```javascript
const DEBOUNCE_MS = 5000;  // 5s Debounce

function emitSyncEvent(event, payload) {
  if (now - last < DEBOUNCE_MS) {
    return;  // EVENT WIRD VERWORFEN
  }
  bus.emit(event, payload);  // In-Memory EventEmitter
}
```

**Probleme:**
1. **Debounce verursacht Datenverlust:** Bestand ändert sich 3x in 5 Sekunden → nur 1. und 4. Change werden gesynct
2. **In-Memory:** Server-Crash = alle ausstehenden Events verloren
3. **Kein Dead-Letter-Queue:** Fehlgeschlagene Handler-Aufrufe sind für immer verloren

---

### HOCH-3: Marketplace-Sync ist Partial-Failure-anfällig

**Datei:** `services/stock-sync-dispatcher.js`, Zeilen 80-248

eBay und Kaufland werden sequentiell gesynct. Wenn eBay erfolgreich ist aber Kaufland fehlschlägt, zeigen die Kanäle für 30+ Sekunden (bis Retry) unterschiedliche Bestände. Kein Rollback von eBay bei Kaufland-Failure.

---

### HOCH-4: Retouren erhöhen Bestand NICHT automatisch

**Datei:** `services/returns-engine.js`, `restockItem()`

```javascript
async function restockItem({ returnId, orderId, itemCondition, tenantId }) {
  // Loggt nur eine Warehouse-Bewegung!
  await db.collection('warehouse_movements').add({
    type: 'restock_return',
    productSku: returnedItem.sku,
    quantity: returnedItem.quantity,
    // ...
  });
  // KEIN bookStockIn() Aufruf!
}
```

Das ist **by Design** (QC-Prüfung vor Wiedereinlagerung). Aber: Wenn der Lagermitarbeiter vergisst, manuell einzubuchen, bleibt der Bestand zu niedrig. Es gibt keinen Workflow/Alert der darauf hinweist.

---

### HOCH-5: refreshProductInventory() ist nicht transaktional

**Datei:** `lib/warehouse.js`, Zeilen 36-154

```javascript
async function refreshProductInventory(productId) {
  const snapshot = await binsCollection.get();  // LIEST ALLE BINS (nicht in Transaction)
  const totalQty = bins.reduce((sum, b) => sum + b.quantity, 0);
  await docRef.update({ 'inventory.quantity': totalQty });  // SCHREIBT (nicht in Transaction)
}
```

Zwischen Lesen und Schreiben kann ein paralleler `bookStockIn/Out()` die Bins ändern → `inventory.quantity` wird mit veralteten Werten überschrieben.

---

### MITTEL-1: Kaufland-Reconciliation überschreibt Warehouse-Werte

**Datei:** `routes/marketplace.js`, Zeilen 876-930

Wenn `inventory.quantity === 0` im Warehouse aber Kaufland `amount > 0` meldet, wird der Kaufland-Wert direkt nach `products_v2.inventory.quantity` geschrieben. Das kann den Warehouse-Bestand verfälschen, wenn das Warehouse tatsächlich 0 hat aber Kaufland noch einen alten Cache-Wert zeigt.

---

### MITTEL-2: BUG-068 — 170 Stock-Sync Fehler (aus TASKS.md)

Bereits bekannt: 170 fehlgeschlagene Stock-Syncs erzeugen aktives Oversell-Risiko. Abhängig von eBay Token Fix.

---

### MITTEL-3: BUG-070 — Marketplace-Tabellen zeigen falsche Bestände

- eBay: Lager-Spalte zeigt "—" obwohl Bestand vorhanden
- Kaufland: Aktive Angebote mit Marktplatz=0 und Lager=0
- Inkonsistenz zwischen physischem und angezeigtem Bestand verwirrt Nutzer

---

## 3. Root-Cause-Analyse

### Warum ist es dazu gekommen?

**1. Historisch gewachsene Architektur ohne zentrale Bestandslogik**

AvyCloud wurde Feature-für-Feature gebaut: erst Warehouse, dann eBay-Integration, dann Kaufland, dann OMS. Jede Schicht hat eigene Schreib-Pfade mit eigenen Fehlerbehandlungen. Es fehlt eine **zentrale Bestandstransaktionsschicht** die als Single-Point-of-Truth zwischen allen Modulen vermittelt.

**2. Fire-and-Forget als Architektur-Pattern**

`_onOrderShipped()`, `syncStockWithRetry()`, `emitSyncEvent()` — alle kritischen Bestandsoperationen sind fire-and-forget mit `console.warn` bei Fehlern. Es gibt keinen Mechanismus der garantiert, dass eine fehlgeschlagene Operation wiederholt wird (außer dem 6h Safety-Net-Cronjob für Order-Sync, der aber keine Stock-Syncs wiederholt).

**3. In-Memory Event-Bus statt persistenter Queue**

`sync-event-bus.js` nutzt Node.js EventEmitter — keine Persistenz, kein Retry, kein Dead-Letter. Ein Server-Restart verliert alle ausstehenden Events.

**4. Firestore-Transactions nur auf Einzeloperation-Ebene**

`bookStockIn/Out()` und `decrementProductByIdOrSku()` nutzen Transactions — aber nur für ihre eigene atomare Operation. Der übergeordnete Flow (Reservierung → Dekrement → Sync) hat keine transaktionale Klammer.

**5. Keine Validierung/Reconciliation**

Es fehlt ein periodischer Abgleich: "Stimmt `inventory.quantity` mit der Summe aller Bins überein? Stimmt der Marktplatz-Bestand mit dem verfügbaren Bestand überein?"

---

## 4. Lösungsvorschlag

### Phase 1: Sofort-Maßnahmen (1-2 Wochen)

#### FIX-A: Stock-Operation-Lock pro SKU

```javascript
// Neues Modul: lib/stock-lock.js
const activeLocks = new Map();

async function withStockLock(sku, fn) {
  while (activeLocks.has(sku)) {
    await activeLocks.get(sku);  // Warte auf vorherige Operation
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  activeLocks.set(sku, promise);
  try {
    return await fn();
  } finally {
    activeLocks.delete(sku);
    resolve();
  }
}
```

Wrappen um: `syncStockToAllChannels()`, `_onOrderShipped()`, `reserveStock()`.
**Aufwand:** ~2h, kein Breaking Change.

#### FIX-B: Expired-Reservations Cronjob

```javascript
// In index.js, nach den bestehenden setInterval-Blöcken:
const RESERVATION_CLEANUP_INTERVAL = 5 * 60 * 1000; // Alle 5 Minuten
setInterval(async () => {
  try {
    const { expireStaleReservations } = require('./services/stock-reservation');
    const result = await expireStaleReservations();
    if (result.expired > 0) {
      console.log(`[reservation-cleanup] Expired ${result.expired} stale reservations`);
    }
  } catch (err) {
    console.error('[reservation-cleanup] Failed:', err.message);
  }
}, RESERVATION_CLEANUP_INTERVAL);
```

**Aufwand:** ~30 Minuten.

#### FIX-C: _onOrderShipped() Failure-Recovery

```javascript
async function _onOrderShipped({ orderId, tenantId }) {
  const failures = [];

  // Schritt 1: Confirm
  try {
    await confirmReservation({ tenantId, orderId });
  } catch (err) {
    failures.push({ step: 'confirm', error: err.message });
  }

  // Schritt 2: Decrement (NUR wenn Confirm OK oder keine Reservierung existierte)
  for (const [sku, sold] of Object.entries(skuQtyMap)) {
    try {
      await decrementProductByIdOrSku(sku, sold);
    } catch (err) {
      failures.push({ step: 'decrement', sku, error: err.message });
    }
  }

  // Schritt 3: Sync
  for (const [sku, sold] of Object.entries(skuQtyMap)) {
    try {
      const product = await lookupProductBySku(sku);
      if (product) await syncStockWithRetry({ tenantId, product, reason: `shipped-${orderId}` });
    } catch (err) {
      failures.push({ step: 'sync', sku, error: err.message });
    }
  }

  // Failures PERSISTIEREN für Recovery
  if (failures.length) {
    await firestore.collection('stock_operation_failures').add({
      orderId, tenantId, operation: 'shipped',
      failures, createdAt: new Date().toISOString(),
    });
    console.error(`[order-state-machine] ${failures.length} failures for ${orderId}`, failures);
  }
}
```

**Aufwand:** ~2h.

#### FIX-D: Order-Intake atomar machen

```javascript
// In order-intake-ebay.js:
const saved = await saveOrderIfNew({ tenantId, order });
if (saved) {
  // SOFORT reservieren, nicht erst nach der Schleife
  try {
    await reserveStock({ tenantId, orderId, items });
  } catch (err) {
    // Bestellung LÖSCHEN wenn Reservierung fehlschlägt
    await deleteOrder(orderId);
    throw err;
  }
}
```

**Aufwand:** ~1h.

### Phase 2: Strukturelle Verbesserungen (2-4 Wochen)

#### FIX-E: Bestandsrekonciliation-Job

Ein Cronjob der alle 30 Minuten prüft:

1. `inventory.quantity` vs. Summe aller `warehouseBins` → Drift erkennen + korrigieren
2. Marketplace-Bestand (aus `ebayListingsLive` / `kauflandUnitsLive`) vs. `availableQty` → Divergenz loggen + re-sync triggern
3. Offene Reservierungen vs. tatsächliche Orders → Orphaned Reservations finden

```javascript
async function reconcileStock({ tenantId = 'default' }) {
  const products = await getAllProductsV2();
  const drifts = [];

  for (const product of products) {
    // 1. Bin-Total vs inventory.quantity
    const binTotal = (product.storageBins || [])
      .reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
    const inventoryQty = Number(product.inventory?.quantity || 0);

    if (binTotal !== inventoryQty) {
      drifts.push({
        productId: product.id,
        sku: product.identification?.sku,
        type: 'bin_drift',
        binTotal,
        inventoryQty,
        delta: binTotal - inventoryQty,
      });
      // Auto-fix: setze inventory.quantity auf Bin-Total
      await refreshProductInventory(product.id);
    }

    // 2. Available vs Marketplace
    const { availableQty } = await computeAvailableQuantity(product, tenantId);
    const ebayQty = product.ops?.ebay?.lastSyncedQty;
    const kauflandQty = product.ops?.kaufland?.lastSyncedQty;

    if (ebayQty !== undefined && ebayQty !== availableQty) {
      drifts.push({
        productId: product.id, type: 'ebay_drift',
        expected: availableQty, actual: ebayQty,
      });
      await syncStockToAllChannels({ tenantId, product, reason: 'reconciliation' });
    }
  }

  return { checked: products.length, drifts };
}
```

**Aufwand:** ~1 Woche.

#### FIX-F: Event-Bus durch persistente Queue ersetzen

Langfristig: `sync-event-bus.js` durch Google Cloud Tasks oder Pub/Sub ersetzen. Jedes Stock-Event wird als Task persistiert und guaranteed-at-least-once ausgeführt.

**Aufwand:** ~2 Wochen.

#### FIX-G: Retoure-Wiedereinlagerungs-Workflow

Automatischer Alert/Task wenn eine Retoure als `a_ware`/`b_ware` markiert ist aber nach 24h kein entsprechender `bookStockIn()` erfolgte. Optional: Auto-Restock mit Confirmation-Step im UI.

**Aufwand:** ~3 Tage.

---

## 5. Priorisierte Roadmap

| Prio | Fix | Aufwand | Impact | Blockt |
|---|---|---|---|---|
| P0 | FIX-B: Reservation Cleanup Cronjob | 30 Min | Befreit geblockten Bestand sofort | — |
| P0 | FIX-A: Stock-Lock pro SKU | 2h | Verhindert korrupte Parallel-Syncs | — |
| P0 | FIX-D: Order-Intake atomar | 1h | Verhindert Oversell bei Crash | — |
| P1 | FIX-C: Shipped-Failure-Recovery | 2h | Macht Fehler sichtbar + recoverable | — |
| P1 | FIX-E: Reconciliation-Job | 1 Woche | Erkennt + korrigiert ALLE Drifts | — |
| P2 | FIX-G: Retoure-Alert | 3 Tage | Verhindert vergessene Rückbuchungen | — |
| P2 | FIX-F: Persistente Queue | 2 Wochen | Eliminiert Event-Verlust permanent | FIX-A (Lock überflüssig mit Queue) |

**Empfehlung:** FIX-B + FIX-A + FIX-D sofort umsetzen (< 1 Tag). Das löst die akutesten Probleme ohne Architektur-Umbau.

---

## 6. Bekannte Bugs (aus TASKS.md)

| Bug | Zusammenhang |
|---|---|
| **BUG-068** | 170 Stock-Sync Fehler — direktes Oversell-Risiko, abhängig von eBay Token Fix |
| **BUG-070** | Marketplace-Tabellen zeigen falschen Bestand ("—" statt echter Menge) |
| **BUG-071** | Bestellungen: Pipeline-Zahlen inkonsistent mit Tab-Zahlen |
| **BUG-092** | Duplikat-Versandeinträge durch Race Condition in SendCloud-Sync |
| **FIX-2** | Inventar → Bestandswert KPI zeigt >€0 (hängt mit falschen inventory.quantity zusammen) |

---

## 7. Anhang: Alle Schreibpfade für inventory.quantity

| # | Datei | Zeile | Methode | Transaktional | Trigger Sync |
|---|---|---|---|---|---|
| 1 | `warehouse.js` | 136 | `refreshProductInventory()` | NEIN | Nein (wird nach Sync aufgerufen) |
| 2 | `warehouse.js` | 537 | `decrementProductByIdOrSku()` | JA | Ja (via caller) |
| 3 | `warehouse.js` | 606 | `decrementProductByIdOrSku()` | JA | Ja (via caller) |
| 4 | `warehouse.js` | 824 | `assignProductToBin()` | JA | Ja (via refresh) |
| 5 | `warehouse.js` | 805 | `bookStockIn()` | JA | Ja (via refresh) |
| 6 | `warehouse.js` | 923 | `bookStockOut()` (zero-stock) | JA | Ja (via refresh) |
| 7 | `warehouse.js` | 944 | `bookStockOut()` (remaining) | JA | Ja (via refresh) |
| 8 | `marketplace.js` | 918 | Kaufland Reconciliation | BATCH | NEIN ⚠️ |
