# BUG-092: Versand — Duplikat-Einträge + falscher "Problem"-Status

## Problem

Bestellung `17-14373-89235` hat **2 Einträge** in der Versand-Tabelle:
1. Tracking `01596811364368`, Status **Ausstehend**, Carrier DPD — korrekt
2. Kein Tracking, Status **Problem**, gleicher Kunde Sergej Riemer — falsch

SendCloud zeigt nur **1 Paket**: Status "Paket unterwegs", Tracking `01596811364368`, DPD Classic 10-20kg.

Das Problem betrifft potenziell alle Sendungen — nicht nur diesen einen Auftrag.

## Root Cause (3 Issues)

### Issue 1: Keine DB-Level Idempotenz bei Sync

`syncSendCloudParcels()` in `backend/services/shipping-engine.js` (ab Zeile ~582):
- Lädt `existingParcelIds` einmalig aus Firestore beim Sync-Start
- Prüft nur In-Memory ob ein Paket bereits existiert
- **Race Condition**: Bei concurrent Syncs (Frontend Auto-Sync alle 60s + manueller Sync-Klick) können beide denselben Parcel fetchen und je ein Dokument anlegen
- Zeile ~772: `db.collection(SHIPMENTS_COLLECTION).add(shipmentDoc)` — kein Upsert, kein Unique-Constraint

### Issue 2: Webhook + Sync Race

- SendCloud Webhook (`backend/routes/webhooks.js` ab Zeile ~58) updated Status eines bestehenden Shipments
- Parallel läuft ein Sync und fetcht denselben Parcel von der SendCloud API
- Wenn der Sync den Parcel mit neuem Status sieht (z.B. 1002 = Announcement Failed) und das Dokument noch nicht als existierend erkennt → neues Duplikat mit Status "problem"

### Issue 3: Status-Sync fehlt für bestehende Einträge

- `syncSendCloudParcels()` erstellt nur NEUE Shipments für unbekannte Parcel-IDs
- Es **updated NICHT** den Status bestehender Shipments bei erneutem Sync
- Ergebnis: Ein Parcel der in SendCloud längst "unterwegs" ist, bleibt in AvyCloud auf "ausstehend"

## Betroffene Dateien

| Datei | Relevanz |
|-------|----------|
| `backend/services/shipping-engine.js` | `syncSendCloudParcels()` (Zeile ~582-812), `mapSendCloudStatus()` (Zeile ~36-50), `createParcel()` (Zeile ~171) |
| `backend/routes/webhooks.js` | SendCloud Webhook Handler (Zeile ~58-182), `SENDCLOUD_STATUS_MAP` |
| `backend/routes/orders.js` | Ship + Tracking Endpoints |
| `components/orders/ShippingView.tsx` | Frontend-Deduplizierung (Zeile ~112-124) — Band-Aid, nicht die Lösung |

## Fixes

### Fix A: Upsert statt Add bei Sync (Kernofix)

In `syncSendCloudParcels()`:
- Statt `db.collection(SHIPMENTS_COLLECTION).add(shipmentDoc)` → Upsert per `sendcloudParcelId`
- Query: `where('sendcloudParcelId', '==', parcelId).limit(1)`
- Wenn Dokument existiert: **Status, Tracking, Carrier updaten** (statt Skip)
- Wenn nicht: neues Dokument anlegen
- Das behebt gleichzeitig Issue 1 (keine Duplikate) und Issue 3 (Status wird aktualisiert)

```javascript
// VORHER (shipping-engine.js, ~Zeile 772):
await db.collection(SHIPMENTS_COLLECTION).add(shipmentDoc);

// NACHHER:
const existing = await db.collection(SHIPMENTS_COLLECTION)
  .where('sendcloudParcelId', '==', Number(parcelId))
  .where('tenantId', '==', tenantId)
  .limit(1)
  .get();

if (!existing.empty) {
  // Update status + tracking für bestehenden Eintrag
  const doc = existing.docs[0];
  await doc.ref.update({
    status: shipmentDoc.status,
    trackingNumber: shipmentDoc.trackingNumber || doc.data().trackingNumber,
    carrier: shipmentDoc.carrier || doc.data().carrier,
    carrierCode: shipmentDoc.carrierCode || doc.data().carrierCode,
    updatedAt: new Date().toISOString(),
  });
} else {
  await db.collection(SHIPMENTS_COLLECTION).add(shipmentDoc);
}
```

### Fix B: Cleanup-Script für existierende Duplikate

Erstelle `backend/scripts/cleanup-shipping-duplicates.js`:
- Query alle Shipments, gruppiere nach `(orderId, sendcloudParcelId)`
- Wenn >1 Dokument pro Gruppe: behalte das neueste (oder das mit Tracking), lösche Rest
- Dry-Run default, `--apply` zum Löschen
- Logge Statistiken: "X Duplikate gefunden, Y gelöscht"

### Fix C: Webhook-Handler robuster machen

In `backend/routes/webhooks.js`:
- Wenn Webhook kein bestehendes Shipment findet (Query by `sendcloudParcelId`): **neues Dokument anlegen** statt ignorieren
- Wenn Webhook bestehendes findet: Status + Tracking updaten (already implemented, verify)
- Sicherstellen dass `trackingNumber` aus Webhook immer übernommen wird

## Constraints

- **Keine Änderung an Firestore-Feldnamen** (additive only, CLAUDE.md)
- **tenantId** bei allen Queries mitgeben
- **Bestehende Shipments nicht löschen** — nur Duplikate bereinigen
- **Tests**: Min. 1 Test für Upsert-Logik (Vitest)
- `cd backend && npm test` muss grün bleiben

## Verifizierung

1. `cd backend && npm test` — alle Tests grün
2. Deploy Backend
3. SendCloud Sync klicken → Bestellung 17-14373-89235 sollte nur 1 Eintrag haben mit Status "In Zustellung" und Tracking
4. Cleanup-Script: `node backend/scripts/cleanup-shipping-duplicates.js` (dry-run) → prüfen → `--apply`
5. Erneut Sync → keine neuen Duplikate
