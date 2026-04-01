# PERF-002: eBay API Rate-Limiting & Call-Optimierung

## Problem

eBay API Limit (5.000 Calls/Tag) wird regelmäßig überschritten.
Fehlermeldung: `"Your application has exceeded usage limit on this call, please make call to Developer Analytics API to check your call usage."`
Bulk-Publish von 39 Artikeln → **0 von 39 erfolgreich**, alle fehlgeschlagen.

## Root Cause (6 Issues)

### Issue 1: Kein Rate-Limiter

`callTradingApi()` in `backend/lib/ebay-trading-api.js` (Zeile ~400-470) hat keinen Throttle-Mechanismus. Jeder Call geht sofort raus — egal wie viele in der letzten Sekunde/Stunde/Tag gemacht wurden.

### Issue 2: Kein Retry bei Rate-Limit-Error

Wenn eBay `"exceeded usage limit"` zurückgibt, wird der Error direkt durchgeworfen. Kein Retry, kein Backoff.

### Issue 3: Bulk-Publish ohne Delay

`bulkPublishProducts()` in `backend/lib/ebay-direct.js` (Zeile 4283):
- Loopt sequentiell durch alle Produkte
- Feuert `addFixedPriceItem()` **ohne jede Pause** ab
- 39 Calls in wenigen Sekunden → eBay Rate-Limit-Error

### Issue 4: Redundanter `resolveItemIsActive()` API Call

`publishProduct()` in `backend/lib/ebay-direct.js` (Zeile 4158-4168):
- Ruft **erst** `resolveItemIsActive()` auf (= GetItem API Call)
- Ruft **dann** `checkExistingEbayLink()` auf (= Firestore Query, kostenlos)
- Reihenfolge ist falsch — Firestore-Check zuerst würde den API Call in den meisten Fällen sparen

### Issue 5: GetItem vor jedem Revise

`reviseListingFromProduct()` in `backend/lib/ebay-direct.js` (Zeile 4364-4375):
- Ruft **immer** `getItemDetails(id)` auf um `listingType` zu ermitteln
- Firestore-Cache in `ebayListingsLive` hat diese Info bereits
- Bei 500 Revises/Tag = 500 unnötige GetItem Calls

### Issue 6: Bulk-Verify ohne Delay

`bulkVerifyPublishProducts()` in `backend/lib/ebay-direct.js` (Zeile ~4260):
- Gleiche sequentielle Loop wie Bulk-Publish, kein Delay

## Betroffene Dateien

| Datei | Änderung |
|-------|----------|
| `backend/lib/ebay-rate-limiter.js` | **NEU** — Globaler Rate-Limiter (Singleton) |
| `backend/lib/ebay-trading-api.js` | `callTradingApi()` → Rate-Limiter + Retry einbauen |
| `backend/lib/ebay-direct.js` | 4 Optimierungen in bestehenden Funktionen |
| `backend/__tests__/ebay-rate-limiter.test.js` | **NEU** — Tests für Rate-Limiter |
| `backend/__tests__/ebay-direct-bulk-publish.test.js` | **NEU** — Tests für Bulk-Delay + Call-Reihenfolge |

## Fixes

### Fix A: Globaler Rate-Limiter (NEUE Datei)

Erstelle `backend/lib/ebay-rate-limiter.js`:

```js
// CommonJS, kein externe Dependency
// Konfigurierbar über ENV
const MAX_CALLS_PER_SECOND = parseInt(process.env.EBAY_MAX_CALLS_PER_SECOND || '4', 10);
const MAX_CALLS_PER_HOUR = parseInt(process.env.EBAY_MAX_CALLS_PER_HOUR || '4500', 10);
const MAX_CALLS_PER_DAY = parseInt(process.env.EBAY_MAX_CALLS_PER_DAY || '4500', 10);
```

Implementierung:
- `async function acquireSlot()` — wartet (Promise-basiert, kein busy-wait) bis ein Slot frei ist
- `function getUsage()` — gibt `{ second, hour, day, limits }` zurück (für Logging/Monitoring)
- `function resetCounters()` — für Tests (Counter zurücksetzen)
- Sliding Window: Array von Timestamps, alte Einträge werden bei jedem `acquireSlot()` bereinigt
- Export als Singleton (Modul-Level State)
- **Keine externe Dependency** — kein p-queue, kein bottleneck

### Fix B: Retry mit Backoff in `callTradingApi()`

**Datei:** `backend/lib/ebay-trading-api.js`, Funktion `callTradingApi()` (Zeile ~400-470)

VORHER (Zeile ~420):
```js
const response = await fetchImpl(endpoint, { method: 'POST', headers, body: fullXml, signal });
```

NACHHER:
```js
const { acquireSlot } = require('./ebay-rate-limiter');

const MAX_RETRIES = parseInt(process.env.EBAY_RATE_LIMIT_MAX_RETRIES || '3', 10);
let lastError = null;

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  await acquireSlot();
  const response = await fetchImpl(endpoint, { method: 'POST', headers, body: fullXml, signal });
  const text = await response.text();

  // Rate-Limit-Error erkennen
  const isRateLimited = text.includes('exceeded usage limit') || text.includes('21917062');
  if (isRateLimited && attempt < MAX_RETRIES) {
    const backoffMs = Math.min(2000 * Math.pow(2, attempt), 16000); // 2s → 4s → 8s → 16s
    console.warn(`[callTradingApi] Rate limited on ${callName}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs}ms`);
    await new Promise((r) => setTimeout(r, backoffMs));
    continue;
  }

  // Normaler Flow (bestehenden XML-Parse-Code hier weiterverwenden)
  // ...
}
```

**Wichtig:** Den bestehenden XML-Parse + Error-Handling Code innerhalb der Retry-Loop platzieren. Nur bei Rate-Limit-Error wird retried — alle anderen Errors (z.B. Category-Mismatch) werden wie bisher sofort durchgeworfen.

### Fix C: Delay in Bulk-Funktionen

**Datei:** `backend/lib/ebay-direct.js`

**C1: `bulkPublishProducts()`** (Zeile 4283)

VORHER:
```js
for (const id of ids) {
  try {
    const result = await publishProduct(id, overrides, { actor });
    results.push(result);
  } catch (err) {
    results.push({ productId: id, ok: false, blockers: [safeString(err?.message)], warnings: [] });
  }
}
```

NACHHER:
```js
const BULK_DELAY_MS = parseInt(process.env.EBAY_BULK_PUBLISH_DELAY_MS || '300', 10);

for (let i = 0; i < ids.length; i++) {
  if (i > 0 && BULK_DELAY_MS > 0) {
    await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
  }
  try {
    const result = await publishProduct(ids[i], overrides, { actor });
    results.push(result);
  } catch (err) {
    results.push({ productId: ids[i], ok: false, blockers: [safeString(err?.message)], warnings: [] });
  }
}
```

**C2: `bulkVerifyPublishProducts()`** (Zeile ~4260) — gleicher Delay-Mechanismus einbauen.

### Fix D: Redundanten API Call in `publishProduct()` eliminieren

**Datei:** `backend/lib/ebay-direct.js`, Funktion `publishProduct()` (Zeile 4151-4179)

VORHER (Zeile 4158-4179):
```js
const existingItemId = safeString(product?.marketplace?.ebay?.itemId);
if (existingItemId) {
  const state = await resolveItemIsActive(existingItemId);  // ← API Call!
  if (state.isActive) {
    return { productId: id, ok: false, blockers: [...], warnings: [] };
  }
}

const linkedItemId = await checkExistingEbayLink(id);  // ← Firestore
if (linkedItemId) {
  return { productId: id, ok: false, blockers: [...], warnings: [] };
}
```

NACHHER — Firestore zuerst, API Call nur als Fallback:
```js
// Schritt 1: Firestore-Link prüfen (kein API Call)
const linkedItemId = await checkExistingEbayLink(id);
if (linkedItemId) {
  return {
    productId: id,
    ok: false,
    blockers: [`Bereits auf eBay gelistet (ItemID: ${linkedItemId}). Artikel kann nicht erneut gelistet werden.`],
    warnings: [],
  };
}

// Schritt 2: Nur API-Fallback wenn itemId in Produkt gespeichert aber kein Link existiert
const existingItemId = safeString(product?.marketplace?.ebay?.itemId);
if (existingItemId) {
  const state = await resolveItemIsActive(existingItemId);
  if (state.isActive) {
    return {
      productId: id,
      ok: false,
      blockers: [`Bereits auf eBay gelistet (ItemID: ${existingItemId}). Artikel kann nicht erneut gelistet werden.`],
      warnings: [],
    };
  }
}
```

### Fix E: Firestore-Cache vor GetItem in `reviseListingFromProduct()`

**Datei:** `backend/lib/ebay-direct.js`, Funktion `reviseListingFromProduct()` (Zeile 4364-4375)

VORHER:
```js
let listing = {};
try {
  const live = await getItemDetails(id);  // ← API Call, IMMER
  if (live?.item && typeof live.item === 'object') listing = live.item;
} catch (e) {
  console.warn(`[reviseListingFromProduct] Live fetch failed for ${id}, using defaults: ${e?.message}`);
}
```

NACHHER:
```js
const CACHE_MAX_AGE_MS = parseInt(process.env.EBAY_REVISE_CACHE_MAX_AGE_MS || String(24 * 60 * 60 * 1000), 10);

let listing = {};
// Erst Firestore-Cache prüfen (kostenlos)
const cachedDoc = await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(id).get();
if (cachedDoc.exists) {
  const cached = cachedDoc.data() || {};
  const cacheAge = Date.now() - Date.parse(cached.lastSyncAtIso || '1970-01-01');
  if (cacheAge < CACHE_MAX_AGE_MS && cached.listingType) {
    listing = cached;
  }
}

// Nur API Call wenn kein brauchbarer Cache
if (!listing.listingType) {
  try {
    const live = await getItemDetails(id);
    if (live?.item && typeof live.item === 'object') listing = live.item;
  } catch (e) {
    console.warn(`[reviseListingFromProduct] Live fetch failed for ${id}, using defaults: ${e?.message}`);
  }
}
```

## Constraints

- **Keine Änderung an Routen** (`backend/routes/marketplace.js` bleibt unangetastet)
- **Keine Frontend-Änderungen**
- **Keine neuen Dependencies** — kein p-queue, kein bottleneck, kein Lodash
- **CommonJS** im Backend (kein import/export, nur require/module.exports)
- **Keine Firestore-Felder umbenennen/löschen** (additive only, CLAUDE.md)
- **Keine ENV-Vars umbenennen** die in CI/CD referenziert werden
- **Bestehende Tests nicht ändern** — nur neue Tests hinzufügen

## Tests

### `backend/__tests__/ebay-rate-limiter.test.js`
1. `acquireSlot()` resolved sofort wenn unter Limit
2. `acquireSlot()` verzögert wenn pro-Sekunde-Limit erreicht
3. `getUsage()` gibt korrekte Counter zurück
4. `resetCounters()` setzt alles auf 0
5. ENV-Konfiguration wird korrekt gelesen (Mock process.env)

### `backend/__tests__/ebay-direct-bulk-publish.test.js`
1. `bulkPublishProducts()` wartet BULK_DELAY_MS zwischen Calls
2. Delay ist konfigurierbar über ENV
3. Fehler eines Artikels stoppt nicht den Rest (try/catch pro Artikel)
4. `publishProduct()` prüft Firestore-Link VOR API Call

### Bestehende Tests
- `cd backend && npm test` muss weiterhin grün sein
- Keine bestehenden Tests modifizieren

## Reihenfolge

1. `backend/lib/ebay-rate-limiter.js` + `backend/__tests__/ebay-rate-limiter.test.js` erstellen
2. `callTradingApi()` in `ebay-trading-api.js` anpassen (Fix B: acquireSlot + Retry)
3. `ebay-direct.js` Fixes C, D, E umsetzen
4. `backend/__tests__/ebay-direct-bulk-publish.test.js` erstellen
5. `cd backend && npm test` — alle Tests grün
6. `cd backend && npm run build` — Build prüfen

## ENV-Variablen (alle optional, Defaults funktionieren sofort)

| Variable | Default | Beschreibung |
|----------|---------|-------------|
| `EBAY_MAX_CALLS_PER_SECOND` | `4` | Max API Calls pro Sekunde |
| `EBAY_MAX_CALLS_PER_HOUR` | `4500` | Max API Calls pro Stunde (Puffer unter 5000) |
| `EBAY_MAX_CALLS_PER_DAY` | `4500` | Max API Calls pro Tag (Puffer unter 5000) |
| `EBAY_BULK_PUBLISH_DELAY_MS` | `300` | Delay zwischen Bulk-Publish Calls (ms) |
| `EBAY_REVISE_CACHE_MAX_AGE_MS` | `86400000` | Max Cache-Alter für Revise-Cache (24h) |
| `EBAY_RATE_LIMIT_MAX_RETRIES` | `3` | Max Retries bei Rate-Limit-Error |

## Verifizierung

1. `cd backend && npm test` — alle Tests grün
2. Deploy Backend (Cloud Run)
3. Bulk-Publish 10 Artikel → alle erfolgreich, kein Rate-Limit-Error
4. Bulk-Publish 39 Artikel → alle erfolgreich (mit Delay ~12s statt sofort)
5. `getUsage()` in Logs prüfen — Counter zählen korrekt hoch
