# P2 Bugs — Batch 3: Backend Robustness (B023, B024, B026, B033, B037, B038, B039)

> Backend-Fixes für Race Conditions, Validierung und Konsistenz. Jeder Fix braucht einen Test.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe diese 7 Backend-Bugs in Branch `fix/p2-backend-robustness`:

## B-023: Race Condition bei parallelem Return-Sync
Datei: services/returns-engine.js
Problem: syncEbayReturns() und syncKauflandReturns() laufen parallel alle 6h. Gleiche Retoure → Firestore Conflict.
Fix: Nutze Firestore Transaction mit `set(..., { merge: true })` beim Retouren-Upsert. Prüfe ob `marketplaceReturnId` bereits existiert bevor ein neues Dokument erstellt wird.
Test: Zwei parallele Sync-Calls für gleiche returnId → kein Duplikat.

## B-024: Return Reason nicht gegen Enum validiert
Datei: services/returns-engine.js
Problem: Gemappte Reasons werden nicht gegen RETURN_REASONS validiert. Unbekannte Reasons → Frontend-Filter findet sie nicht.
Fix:
1. Finde die RETURN_REASONS Definition (wahrscheinlich in returns-engine.js oder einem shared file)
2. Nach dem Mapping: if (!RETURN_REASONS.includes(mappedReason)) mappedReason = 'other'
3. Logge unbekannte Reasons: console.warn(`Unknown return reason: ${original} → mapped to 'other'`)
Test: Unbekannter Reason wird zu 'other'.

## B-026: SevDesk Versandkosten-Filter zu breit
Datei: lib/sevdesk.js
Problem: getShippingCostsFromSevDesk() filtert nach "sendcloud" in payeePayerName ODER paymtPurpose. Matcht auch Kunden-Notizen.
Fix: Filter nur auf payeePayerName (Empfänger/Sender), NICHT auf paymtPurpose. Oder: strengerer Match — nur wenn payeePayerName exakt "SendCloud" enthält (case-insensitive).
Test: Transaktion mit "sendcloud" nur in paymtPurpose → wird NICHT als Versandkosten gezählt.

## B-033: Inkonsistente Feldnamen shipment vs shipment_tracking
Problem: Order-Objekt nutzt manchmal order.shipment_tracking, manchmal order.shipment.
Fix:
1. Suche alle Vorkommen von `shipment_tracking` und `shipment` in backend/
2. Standardisiere auf EIN Feld (empfohlen: `shipment` als Objekt mit tracking-Infos)
3. ACHTUNG: Firestore-Felder NICHT umbenennen (additive only). Stattdessen: beim Lesen beide Felder unterstützen, beim Schreiben nur das neue nutzen.
4. Compat-Layer: `const tracking = order.shipment || order.shipment_tracking || {}`
Test: Order mit altem Feld shipment_tracking → wird korrekt gelesen.

## B-037: SevDesk Balance-Cache Array vs Object Confusion
Datei: Wo getCheckAccountBalances() definiert und konsumiert wird
Problem: Gibt { accounts: [...], total } zurück. Consumer iterieren direkt über Result statt über .accounts.
Fix: Finde alle Consumer von getCheckAccountBalances(). Stelle sicher dass sie `.accounts` nutzen.
Test: Consumer-Code erhält korrekten Array.

## B-038: Keine Idempotency bei Order-Erstellung
Datei: services/order-engine.js oder wo syncEbayOrders/syncKauflandOrders definiert ist
Problem: Duplikat-Check via Query. Bei Firestore-Timeout → Query schlägt fehl → Order doppelt erstellt.
Fix: Nutze marketplaceOrderId als Firestore Document-ID (oder als Teil davon). Dann ist `set()` automatisch idempotent.
ALTERNATIV: `set()` mit `{ merge: true }` und marketplaceOrderId als Feld im Dokument. Vor dem Create: Retry der Query mit Backoff.
Test: Gleiche marketplaceOrderId zweimal syncen → nur 1 Dokument.

## B-039: Hardcoded 30-Tage Reconciliation Window
Problem: Reconciliation Runner nutzt maxAgeDays: 30 hardcoded.
Fix: Mach es konfigurierbar via ENV-Variable: RECONCILIATION_MAX_AGE_DAYS (default: 30).
Test: Mit ENV=60 → 60 Tage Fenster.

Danach: cd backend && npm test (alle Tests grün). Commit: `fix: P2 backend robustness — race conditions, validation, idempotency, config`
```
