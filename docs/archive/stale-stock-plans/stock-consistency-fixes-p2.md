# Claude Code Prompt: Stock-Consistency-Fixes Phase 2 (P1)

## SESSION START

1. Lies `CLAUDE.md` — Goldene Regeln, Architektur, Non-Negotiables
2. Lies `TASKS.md` — Offene Bugs
3. Lies `docs/analysis/stock-consistency-deep-dive.md` — Root-Cause-Analyse (Abschnitt 4: FIX-E + FIX-G)
4. Lies `docs/prompts/stock-consistency-fixes.md` — Phase 1 als Referenz für Code-Stil + Patterns
5. `cd backend && npm test` — grüne Baseline sichern

## REGELN

1. **CLAUDE.md ist Gesetz** — CommonJS, 2 Spaces, Single Quotes, async/await, tenantId überall
2. **Goldene Regel:** Production darf NICHT negativ beeinflusst werden
3. **Yellow Zone Dateien** — `stock-sync-dispatcher.js`, `warehouse.js` sind Yellow Zone. Nur lesen, nicht ändern
4. **Kein Breaking Change** an bestehenden Exports oder Signaturen
5. **Additive Only** — neue Module + neue Cronjobs in index.js
6. **Jede Änderung einzeln testen** — nach jeder Datei `npm test` laufen lassen
7. **BaseLinker ist TABU** — keine neuen Referenzen
8. **Tests:** Vitest mit require.cache-Patching (kein vi.mock für CJS)
9. **Conventional Commits** — `fix:` Prefix für alle Commits

## IST-ZUSTAND (Probleme)

### Problem 1: Kein periodischer Bestandsabgleich (FIX-E aus Deep-Dive)

Es gibt keinen Mechanismus der prüft:
- Stimmt `inventory.quantity` mit der Summe aller `storageBins[].quantity` überein? (Bin-Drift)
- Stimmt der zuletzt an eBay/Kaufland gepushte Bestand mit dem aktuellen `availableQty` überein? (Marketplace-Drift)
- Gibt es verwaiste Reservierungen ohne zugehörige Order? (Orphaned Reservations)

**Effekt:** Stille Drifts akkumulieren über Tage/Wochen → falsche Bestände auf Marktplätzen → Oversell oder Undersell.

### Problem 2: Retouren ohne Wiedereinlagerung bleiben unsichtbar (FIX-G aus Deep-Dive)

`restockItem()` in `services/returns-engine.js` (Z.284-316) loggt nur eine `warehouse_movements` Eintra mit `type: 'restock_return'`, ruft aber NICHT `bookStockIn()` auf. Das ist **by Design** (QC-Prüfung vor Einlagerung).

Aber: Wenn der Lagermitarbeiter vergisst manuell einzubuchen, bleibt der Bestand dauerhaft zu niedrig. Es gibt keinen Alert oder Workflow der darauf hinweist.

**Effekt:** A-Ware Retouren liegen im Lager, Bestand zeigt sie nicht → Produkte erscheinen als ausverkauft obwohl verfügbar.

## 3 ÄNDERUNGEN

### Änderung 1: Stock-Reconciliation Service (NEUES MODUL)

**Neue Datei:** `backend/services/stock-reconciliation.js`

Zwei-Tier Reconciliation:

**Tier 1 — Activity-based (alle 30 Minuten):**
- Finde Produkte mit kürzlicher Stock-Aktivität: Query `stock_sync_log` für `createdAt` der letzten 60 Minuten, sammle eindeutige `productId`s
- Zusätzlich: Query `warehouse_movements` für `createdAt` der letzten 60 Minuten, sammle `productSku`s → resolve zu productIds
- Für jedes betroffene Produkt: Drift-Checks ausführen (siehe unten)

**Tier 2 — Full Scan (1x täglich, nachts ~3:00 Uhr):**
- Lade alle Produkte via `getAllProducts()` aus `lib/firestore.js`
- Für jedes Produkt: Drift-Checks ausführen
- Logge Gesamtergebnis

**Drift-Checks (für beide Tiers identisch):**

```js
const { refreshProductInventory } = require('../lib/warehouse');
const { computeAvailableQuantity } = require('./stock-sync-dispatcher');
const { syncStockToAllChannels } = require('./stock-sync-dispatcher');
const { getAllProducts, firestore } = require('../lib/firestore');

/**
 * Check 1: Bin-Drift
 * Vergleiche inventory.quantity mit Summe der storageBins[].quantity
 * Auto-Fix via refreshProductInventory()
 */
async function checkBinDrift(product) {
  const inventoryQty = Number(product.inventory?.quantity || 0);
  const binTotal = (product.storageBins || [])
    .reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);

  if (binTotal === inventoryQty) return null;

  return {
    productId: product.id,
    sku: product.identification?.sku || product.details?.identifiers?.sku || null,
    type: 'bin_drift',
    expected: binTotal,
    actual: inventoryQty,
    delta: binTotal - inventoryQty,
  };
}

/**
 * Check 2: Marketplace-Drift
 * Vergleiche aktuelle availableQty mit dem zuletzt gepushten Wert aus stock_sync_log
 * Auto-Fix via syncStockToAllChannels()
 */
async function checkMarketplaceDrift(product, tenantId) {
  const { availableQty } = await computeAvailableQuantity(product, tenantId);

  // Letzten erfolgreichen Sync aus stock_sync_log holen
  const logSnap = await firestore.collection('stock_sync_log')
    .where('productId', '==', product.id)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (logSnap.empty) return null; // Nie gesynct → kein Drift feststellbar

  const lastSync = logSnap.docs[0].data();
  const lastPushed = Number(lastSync.availableQuantity ?? -1);

  if (lastPushed === availableQty) return null;

  return {
    productId: product.id,
    sku: product.identification?.sku || product.details?.identifiers?.sku || null,
    type: 'marketplace_drift',
    expected: availableQty,
    lastPushed,
    delta: availableQty - lastPushed,
  };
}
```

**Haupt-Funktionen:**

```js
/**
 * Activity-based reconciliation — nur Produkte mit kürzlicher Aktivität.
 * Aufgerufen alle 30 Minuten.
 */
async function reconcileRecentActivity({ tenantId = 'default' } = {}) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h lookback
  const productIds = new Set();

  // 1. Aus stock_sync_log
  const syncLogSnap = await firestore.collection('stock_sync_log')
    .where('createdAt', '>=', since)
    .limit(500)
    .get();
  syncLogSnap.docs.forEach((doc) => {
    const id = doc.data().productId;
    if (id) productIds.add(id);
  });

  // 2. Aus warehouse_movements (resolve SKU → productId)
  const movSnap = await firestore.collection('warehouse_movements')
    .where('createdAt', '>=', since)
    .limit(200)
    .get();
  // SKUs sammeln und per findProductsBySkuChunk auflösen
  const skus = new Set();
  movSnap.docs.forEach((doc) => {
    const sku = doc.data().productSku;
    if (sku) skus.add(sku);
  });
  if (skus.size > 0) {
    const { findProductsBySkuChunk } = require('./stock-sync-dispatcher');
    const skuArray = Array.from(skus);
    for (let i = 0; i < skuArray.length; i += 10) {
      const products = await findProductsBySkuChunk(skuArray.slice(i, i + 10));
      products.forEach((p) => productIds.add(p.id));
    }
  }

  if (productIds.size === 0) return { checked: 0, drifts: [] };

  // Produkt-Daten laden und Drift-Checks
  return _runDriftChecks(Array.from(productIds), tenantId, 'activity');
}

/**
 * Full scan reconciliation — alle Produkte.
 * Aufgerufen 1x täglich nachts.
 */
async function reconcileFullScan({ tenantId = 'default' } = {}) {
  const products = await getAllProducts();
  const productIds = products.map((p) => p.id);
  return _runDriftChecks(productIds, tenantId, 'full_scan');
}

/**
 * Interne Funktion: Drift-Checks für eine Liste von Product-IDs.
 * Liest frisches Produkt, prüft Bin-Drift + Marketplace-Drift, fixt automatisch.
 */
async function _runDriftChecks(productIds, tenantId, reason) {
  const drifts = [];
  let fixed = 0;

  for (const productId of productIds) {
    try {
      // Frisches Produkt lesen
      const doc = await firestore.collection('products_v2').doc(productId).get();
      if (!doc.exists) continue;
      const product = { id: doc.id, ...doc.data() };

      // Check 1: Bin-Drift
      const binDrift = checkBinDrift(product);
      if (binDrift) {
        drifts.push(binDrift);
        try {
          await refreshProductInventory(productId);
          binDrift.autoFixed = true;
          fixed++;
          console.log(`[stock-reconciliation] bin-drift fixed: ${productId} delta=${binDrift.delta}`);
        } catch (err) {
          binDrift.autoFixed = false;
          binDrift.fixError = err.message;
          console.warn(`[stock-reconciliation] bin-drift fix failed: ${productId}: ${err.message}`);
        }
      }

      // Check 2: Marketplace-Drift
      const mktDrift = await checkMarketplaceDrift(product, tenantId);
      if (mktDrift) {
        drifts.push(mktDrift);
        try {
          // Re-read product after potential bin-drift fix
          const freshDoc = await firestore.collection('products_v2').doc(productId).get();
          const freshProduct = { id: freshDoc.id, ...freshDoc.data() };
          await syncStockToAllChannels({ tenantId, product: freshProduct, reason: `reconciliation-${reason}` });
          mktDrift.autoFixed = true;
          fixed++;
          console.log(`[stock-reconciliation] marketplace-drift fixed: ${productId} delta=${mktDrift.delta}`);
        } catch (err) {
          mktDrift.autoFixed = false;
          mktDrift.fixError = err.message;
          console.warn(`[stock-reconciliation] marketplace-drift fix failed: ${productId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[stock-reconciliation] check failed for ${productId}: ${err.message}`);
    }
  }

  // Ergebnisse loggen
  const result = {
    reason,
    checked: productIds.length,
    driftsFound: drifts.length,
    autoFixed: fixed,
    drifts,
    completedAt: new Date().toISOString(),
  };

  try {
    await firestore.collection('stock_reconciliation_log').add({
      ...result,
      // Drifts kürzen für Log-Speichereffizienz — max 50 Einträge
      drifts: drifts.slice(0, 50),
    });
  } catch (err) {
    console.warn('[stock-reconciliation] log write failed:', err.message);
  }

  if (drifts.length > 0) {
    console.log(`[stock-reconciliation] ${reason}: checked=${productIds.length} drifts=${drifts.length} fixed=${fixed}`);
  }

  return result;
}

module.exports = {
  reconcileRecentActivity,
  reconcileFullScan,
  checkBinDrift,
  checkMarketplaceDrift,
};
```

---

### Änderung 2: Restock-Alert Service (NEUES MODUL)

**Neue Datei:** `backend/services/restock-alert.js`

Prüft ob `warehouse_movements` mit `type: 'restock_return'` und Condition `a_ware` oder `b_ware` existieren, für die KEIN korrespondierender `bookStockIn()` innerhalb von 24h erfolgte.

**Erkennung:** `bookStockIn()` in `lib/warehouse.js` (Z.731) ist transaktional und aktualisiert `storageBins[]` + `inventory.quantity`. Ein `bookStockIn` für ein Produkt hinterlässt keine direkte Spur in einer separaten Collection — aber er ändert `inventory.quantity` und die `storageBins` des Produkts.

**Pragmatischer Ansatz:** Vergleiche `warehouse_movements` (restock_return) mit dem tatsächlichen Bestandsverlauf. Wenn ein Restock-Movement existiert aber der Bestand des Produkts sich nicht erhöht hat (kein `bookStockIn` erfolgt), erzeuge einen Alert.

```js
const { getDb } = require('../lib/firestore');

const ALERT_COLLECTION = 'restock_alerts';
const MOVEMENTS_COLLECTION = 'warehouse_movements';

/**
 * Findet Retouren die als a_ware/b_ware eingestuft wurden,
 * aber nach 24h immer noch nicht physisch eingebucht sind.
 *
 * "Nicht eingebucht" = es existiert ein warehouse_movement mit type='restock_return'
 * für eine SKU, aber kein späterer warehouse_movement mit type='stock_in' für dieselbe SKU,
 * UND der Alert wurde noch nicht erzeugt.
 *
 * Da bookStockIn() keinen eigenen warehouse_movement-Eintrag schreibt,
 * prüfen wir stattdessen ob bereits ein restock_alert für dieses Movement existiert.
 * Wenn nicht → Alert erzeugen. Manuelle Einbuchung markiert den Alert als 'resolved'.
 */
async function checkPendingRestocks({ tenantId = 'default' } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const alerts = [];

  // 1. Finde restock_return Movements die älter als 24h sind
  const movSnap = await db.collection(MOVEMENTS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('type', '==', 'restock_return')
    .where('createdAt', '<=', cutoff)
    .limit(200)
    .get();

  if (movSnap.empty) return { checked: 0, newAlerts: 0 };

  // 2. Für jedes Movement prüfen ob Alert bereits existiert
  for (const movDoc of movSnap.docs) {
    const mov = movDoc.data();
    const condition = mov.condition || '';

    // Nur a_ware und b_ware — c_ware wird entsorgt
    if (condition !== 'a_ware' && condition !== 'b_ware') continue;

    // Prüfe ob Alert für dieses Movement schon existiert
    const existingAlert = await db.collection(ALERT_COLLECTION)
      .where('movementId', '==', movDoc.id)
      .limit(1)
      .get();

    if (!existingAlert.empty) continue; // Alert existiert schon

    // Alert erzeugen
    const alert = {
      tenantId,
      movementId: movDoc.id,
      returnId: mov.returnId || null,
      orderId: mov.orderId || null,
      productSku: mov.productSku || null,
      productName: mov.productName || null,
      quantity: mov.quantity || 1,
      condition,
      status: 'pending', // pending | resolved | dismissed
      restockMovementCreatedAt: mov.createdAt,
      createdAt: new Date().toISOString(),
    };

    await db.collection(ALERT_COLLECTION).add(alert);
    alerts.push(alert);
    console.log(
      `[restock-alert] NEW: SKU=${mov.productSku} qty=${mov.quantity} condition=${condition} returnId=${mov.returnId} — pending since ${mov.createdAt}`
    );
  }

  return { checked: movSnap.docs.length, newAlerts: alerts.length };
}

module.exports = { checkPendingRestocks };
```

---

### Änderung 3: Cronjobs in index.js

**Datei:** `backend/index.js` — NACH dem reservation-cleanup Block (nach Z.376)

**Zwei neue Blöcke hinzufügen:**

```js
// Stock reconciliation: activity-based every 30min, full scan daily at 3 AM
const RECONCILIATION_INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS || String(30 * 60 * 1000), 10);
try {
  let lastFullScanDate = null;
  const runReconciliation = async () => {
    try {
      const { reconcileRecentActivity, reconcileFullScan } = require('./services/stock-reconciliation');

      // Full scan 1x pro Tag zwischen 3:00-3:29 Uhr
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() === 3 && now.getMinutes() < 30 && lastFullScanDate !== today) {
        lastFullScanDate = today;
        const result = await reconcileFullScan();
        console.log(`[stock-reconciliation] full-scan: checked=${result.checked} drifts=${result.driftsFound} fixed=${result.autoFixed}`);
        return;
      }

      // Activity-based alle 30min
      const result = await reconcileRecentActivity();
      if (result.driftsFound > 0) {
        console.log(`[stock-reconciliation] activity: checked=${result.checked} drifts=${result.driftsFound} fixed=${result.autoFixed}`);
      }
    } catch (err) {
      console.warn('[stock-reconciliation] failed:', err?.message);
    }
  };
  setTimeout(runReconciliation, 4 * 60 * 1000); // First run after 4 min
  setInterval(runReconciliation, RECONCILIATION_INTERVAL_MS);
  console.log(`[stock-reconciliation] enabled: activity every ${RECONCILIATION_INTERVAL_MS}ms, full scan daily at 03:00`);
} catch (err) {
  console.warn('[stock-reconciliation] failed to start:', err?.message || err);
}

// Restock alert: check for pending return restocks every 2 hours
const RESTOCK_ALERT_INTERVAL_MS = parseInt(process.env.RESTOCK_ALERT_INTERVAL_MS || String(2 * 60 * 60 * 1000), 10);
try {
  const runRestockAlert = async () => {
    try {
      const { checkPendingRestocks } = require('./services/restock-alert');
      const result = await checkPendingRestocks();
      if (result.newAlerts > 0) {
        console.log(`[restock-alert] checked=${result.checked} newAlerts=${result.newAlerts}`);
      }
    } catch (err) {
      console.warn('[restock-alert] failed:', err?.message);
    }
  };
  setTimeout(runRestockAlert, 5 * 60 * 1000); // First run after 5 min
  setInterval(runRestockAlert, RESTOCK_ALERT_INTERVAL_MS);
  console.log(`[restock-alert] enabled: every ${RESTOCK_ALERT_INTERVAL_MS}ms`);
} catch (err) {
  console.warn('[restock-alert] failed to start:', err?.message || err);
}
```

---

## TESTS

**Neue Testdatei:** `backend/__tests__/stock-reconciliation.test.js`

Mindestens diese Tests:

```
describe('stock-reconciliation')
  describe('checkBinDrift')
    ✓ erkennt Drift wenn inventory.quantity ≠ Summe storageBins
    ✓ gibt null zurück wenn kein Drift
    ✓ behandelt Produkt ohne storageBins (leer)

  describe('checkMarketplaceDrift')
    ✓ erkennt Drift wenn availableQty ≠ letzter sync_log Wert
    ✓ gibt null zurück wenn kein sync_log existiert
    ✓ gibt null zurück wenn Werte übereinstimmen

  describe('reconcileRecentActivity')
    ✓ findet Produkte aus stock_sync_log der letzten Stunde
    ✓ gibt { checked: 0, drifts: [] } zurück wenn keine Aktivität
```

**Neue Testdatei:** `backend/__tests__/restock-alert.test.js`

```
describe('restock-alert')
  describe('checkPendingRestocks')
    ✓ erzeugt Alert für a_ware Movement älter als 24h
    ✓ erzeugt Alert für b_ware Movement älter als 24h
    ✓ ignoriert c_ware Movements
    ✓ erzeugt keinen Duplikat-Alert wenn Alert schon existiert
    ✓ gibt { checked: 0, newAlerts: 0 } zurück wenn keine Movements
```

Nutze das bestehende Test-Pattern — require.cache-Patching für Firestore-Mocks, keine vi.mock().

---

## NEUE FIRESTORE COLLECTIONS

| Collection | Zweck | Felder |
|---|---|---|
| `stock_reconciliation_log` | Audit Trail für Reconciliation-Läufe | `reason`, `checked`, `driftsFound`, `autoFixed`, `drifts[]`, `completedAt` |
| `restock_alerts` | Pending Wiedereinlagerungs-Alerts | `tenantId`, `movementId`, `returnId`, `orderId`, `productSku`, `productName`, `quantity`, `condition`, `status` (pending/resolved/dismissed), `createdAt` |

Keine Änderung an bestehenden Collections.

---

## BUILD-REIHENFOLGE

1. **Schritt 0:** `cd backend && npm test` — Baseline grün (351 Tests)
2. **Schritt 1:** `services/stock-reconciliation.js` erstellen → `npm test`
3. **Schritt 2:** `__tests__/stock-reconciliation.test.js` erstellen → `npm test`
4. **Schritt 3:** `services/restock-alert.js` erstellen → `npm test`
5. **Schritt 4:** `__tests__/restock-alert.test.js` erstellen → `npm test`
6. **Schritt 5:** `index.js` → Beide Cronjob-Blöcke hinzufügen → `npm test`
7. **Schritt 6:** Alle Tests grün? → fertig

## WARNUNG

- `index.js` ist **Red Zone** — nur die zwei `setInterval`-Blöcke hinzufügen, NICHTS anderes ändern
- `stock-sync-dispatcher.js` und `warehouse.js` werden NUR GELESEN (für Imports), NICHT geändert
- **Keine neuen Dependencies** — alles mit vorhandenen Modulen
- **Kein BaseLinker** — keine Referenzen
- `stock_reconciliation_log` und `restock_alerts` sind NEUE Collections — kein Schema-Change an bestehenden
- `getAllProducts()` kann bei großen Katalogen langsam sein — Full Scan läuft nachts, das ist OK
- `checkMarketplaceDrift()` braucht einen Composite Index auf `stock_sync_log` (`productId` + `createdAt` DESC) — Firestore erstellt diesen automatisch bei erster Query, loggt aber eine Warnung mit Index-URL. Das ist erwartetes Verhalten.
