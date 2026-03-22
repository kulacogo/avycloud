# AUDIT Sprint: P0 Security + TypeScript Fixes

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

Dieses Audit behebt kritische Security-Lücken und TypeScript-Fehler. Arbeite die Teile nacheinander ab.
Nach jedem Teil: cd backend && npm test — muss grün bleiben.

---

## TEIL 1 — P0 SECURITY: Multi-Tenancy Leaks

### 1a) Webhooks: tenantId hardcoded auf 'default'

Datei: `backend/routes/webhooks.js`
Zeilen: ~171, ~218, ~226, ~235

Problem: Alle Webhook-Handler (SendCloud, Kaufland, eBay) emittieren Sync-Events mit `tenantId: 'default'` statt den tatsächlichen Tenant aus den Daten abzuleiten.

```js
// Zeile ~171 — FALSCH:
emitSyncEvent('shipment:updated', {
  entityId: orderId || `parcel-${parcelId}`,
  tenantId: 'default',  // ← hardcoded
  source: 'sendcloud-webhook',
});
```

Fix:
- Bei SendCloud-Webhooks: `tenantId` aus dem zugehörigen Shipment-Dokument laden (`shipments` Collection → `tenantId` Feld)
- Bei Kaufland/eBay-Webhooks: `tenantId` aus dem zugehörigen Order-Dokument laden
- Fallback auf 'default' NUR wenn kein Dokument gefunden wird (mit console.warn)

### 1b) Competitor Price History: tenantId-Filter fehlt

Datei: `backend/routes/products.js`
Zeilen: ~2259–2289 (Routes `/v1/competitors/:productId/history` und `/v1/competitors/overview`)

Problem: Firestore-Queries auf `priceHistory` Collection filtern NICHT nach tenantId. Ein Tenant kann Wettbewerbsdaten anderer Tenants sehen.

```js
// Zeile ~2263 — FALSCH:
const snap = await firestore.collection('priceHistory')
  .where('productId', '==', req.params.productId)
  .where('timestamp', '>=', since)
  .orderBy('timestamp', 'desc')
  .limit(500)
  .get();
// FEHLT: .where('tenantId', '==', tenantId)
```

Fix:
- Beide Routes: `.where('tenantId', '==', tenantId)` hinzufügen
- tenantId aus `req.tenantId` oder `req.user.tenantId` (prüfe wie andere Routes es machen)

### 1c) Admin: Hardcoded Inventory ID

Datei: `backend/routes/admin.js`
Zeile: ~367

Problem: `const invId = String(req.body?.inventoryId || '78659').trim();` — Magic Number als Fallback.

Fix:
- Wenn `inventoryId` fehlt oder leer → HTTP 400 `{ ok: false, error: { message: 'inventoryId ist Pflichtfeld' } }`
- Kein Default-Wert. Der Client muss explizit eine ID mitgeben.

---

## TEIL 2 — P0 TypeScript: Fehlende Exports + Kaputtes Error Dashboard

### 2a) Fehlende Exports in api/client.ts

Datei: `api/client.ts`

Problem: `hooks/useErrors.ts` importiert `fetchErrors`, `fetchErrorSummary`, `resolveError`, `OperationalError`, `ErrorSummary` — aber diese existieren nicht in `api/client.ts`.

Prüfe:
1. Gibt es die Error-API-Endpoints im Backend? Suche in `backend/routes/` nach Routen wie `/api/errors` oder `/api/operational-errors`
2. Wenn Backend-Endpoints existieren → implementiere die fehlenden API-Client-Funktionen in `api/client.ts` + die Types
3. Wenn Backend-Endpoints NICHT existieren → erstelle Stub-Funktionen die leere Daten zurückgeben, und markiere als TODO
4. Ziel: `hooks/useErrors.ts` kompiliert fehlerfrei

### 2b) View Type Mismatch in App.tsx

Datei: `App.tsx`
Zeilen: ~124–125

Problem: "duplicates" und "audit-log" sind in `ALLOWED_VIEWS` aber nicht im `View` Type-Union.

Fix:
- Erweitere den `View` Type um `'duplicates' | 'audit-log'`
- Prüfe ob die zugehörigen Komponenten (`DuplicatesView`, `AuditLogView`) importiert und gerendert werden
- Wenn Komponenten fehlen → entferne die Views aus ALLOWED_VIEWS (statt kaputte Routen zu haben)

### 2c) Dashboard Null-Reference

Dateien: `components/Dashboard.tsx` (Zeilen ~732, ~734, ~876, ~878) und `components/DashboardMobile.tsx` (~426, ~428, ~459, ~461)

Problem: `finance` Objekt wird ohne Null-Check zugegriffen. `finance.shipping_ytd` kann undefined sein.

Fix:
- Optional Chaining: `finance?.shipping_ytd ?? 0`
- Oder Guard am Anfang: `const finance = rawFinance || { shipping_ytd: 0, ... }`

### 2d) Dashboard onSelectProduct

Datei: `components/Dashboard.tsx`
Zeile: ~935

Problem: Referenz auf `onSelectProduct` die nicht existiert.

Fix: Prüfe ob es als Prop übergeben wird oder ob es `_onSelectProduct` oder ein anderer Name sein sollte.

---

## TEIL 3 — P1 Backend: Silent Error Swallowing

Dateien: Mehrere Routes und Services

Problem: 20+ Stellen mit `.catch(() => {})` die Fehler komplett verschlucken.

Betroffene Dateien (suche nach `.catch(() =>`):
- `backend/routes/orders.js` (~Zeile 69, 1563)
- `backend/routes/integrations.js` (~Zeile 279)
- `backend/routes/rules.js` (~Zeile 121, 149, 168, 203)
- Weitere

Fix pro Stelle:
```js
// VORHER:
firestore.collection('orders').doc(orderId).update({ marketplace: resolvedMarketplace })
  .catch(() => {});

// NACHHER:
firestore.collection('orders').doc(orderId).update({ marketplace: resolvedMarketplace })
  .catch((err) => console.warn('[orders] Non-critical update failed:', err?.message || err));
```

Mindestens die Fehler loggen. Nicht verschlucken.

---

## TEIL 4 — P1 Frontend: Error-States für kritische Views

Problem: Mehrere Views zeigen nur `console.error` bei API-Fehlern, kein UI-Feedback.

Betroffene Komponenten + Fix-Pattern:

1. `components/InventoryView.tsx` (~Zeile 200): Füge `[error, setError]` State + Error-Banner hinzu
2. `components/orders/ReturnsView.tsx` (~Zeile 566): Gleich
3. `components/orders/ShippingView.tsx` (~Zeile 126): Gleich
4. `components/WarehouseView.tsx` (~Zeile 119): Gleich

Error-Banner Pattern (konsistent mit bestehenden Views):
```tsx
{error && (
  <div className="rounded-xl border border-error/30 bg-error-dim px-4 py-3 text-sm text-error">
    {error}
    <button onClick={() => setError(null)} className="ml-2 text-xs underline">×</button>
  </div>
)}
```

---

## TEIL 5 — P1 Types: Fehlende Properties + Status-Vergleiche

### 5a) WarehouseBin + Zone-Type

Datei: `types.ts`

Problem: `WarehouseBin` fehlt `quantity` Property. Zone 'XQ' fehlt in `ProductStorageLocation.zone`.

Fix:
- `WarehouseBin` Interface: `quantity?: number` hinzufügen
- `ProductStorageLocation.zone`: `'XQ' | 'P'` ergänzen

### 5b) Status-Vergleiche

Dateien: `MobileOperationsView.tsx` (~267), `OrdersView.tsx` (~25, 182, 192)

Problem: `OmsStatus` Type enthält 'new' und 'shipped' nicht, aber Code vergleicht damit.

Fix: Prüfe die OmsStatus-Definition in types.ts und ergänze fehlende Status-Werte.

### 5c) OrderDetail ActionButton

Datei: `components/OrderDetail.tsx` (~441, 539, 560, 567)

Problem: ActionButton erwartet `onClick: () => Promise<void>` aber bekommt andere Signaturen.

Fix: ActionButton-Props lockern oder Caller anpassen.

---

## TEIL 6 — Abschluss

1. `cd backend && npm test` — alle grün
2. `npx tsc --noEmit 2>&1 | wc -l` — TypeScript-Fehler zählen, sollte signifikant weniger sein als vorher (Baseline messen!)
3. TASKS.md aktualisieren: Neue Sektion "Audit — Code Quality Sprint" mit erledigten Items
4. Zusammenfassung: Was wurde geändert, welche Dateien, wie viele TS-Fehler beseitigt
```

## Kontext für Mensch

### Backend Security (P0)
- 2 Multi-Tenancy-Leaks: Webhooks + Competitor Prices
- 1 Hardcoded Magic Number in Admin

### Frontend Types (P0)
- Error Dashboard komplett kaputt (fehlende Exports)
- View-Routing für Duplicates/AuditLog kaputt
- Dashboard Null-References

### Backend Quality (P1)
- 20+ silent .catch(() => {}) die Fehler verschlucken
- 128+ console.log Stellen (nicht in diesem Sprint, separater Cleanup)

### Frontend UX (P1)
- 4 kritische Views ohne Error-UI
- Type-Mismatches die Runtime-Crashes verursachen können

### Nicht in diesem Sprint (P2)
- 128+ console.log Cleanup (separater Prompt)
- i18n-Lücken (24 Komponenten ohne t())
- Accessibility (362 nicht-semantische Buttons)
- Empty States für Listen/Tabellen
- Responsive Design Gaps
