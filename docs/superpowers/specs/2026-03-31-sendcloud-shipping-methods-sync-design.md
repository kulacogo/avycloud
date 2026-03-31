# SendCloud Versandmethoden-Synchronisation

> Alle aktiven SendCloud-Versanddienstleister und -Methoden dynamisch synchronisieren und in AvyCloud verfügbar machen — für Regeln, manuelle Auswahl und Bulk-Versand.

## Entscheidungen

| Frage | Entscheidung | Begründung |
|-------|-------------|------------|
| Sync-Strategie | Hybrid (API → Firestore Cache) | Methoden ändern sich selten; lokaler Cache macht UI schnell, Refresh-Button für Updates |
| UI-Scope | OrderDetail + Bulk-Ship + Regelkonfiguration | Alle Stellen profitieren von dynamischen Methoden |
| Darstellung | Gruppiert nach Carrier + kontextbezogene Filterung | Bei manueller Auswahl nur passende Methoden (Gewicht/Land) anzeigen; in Settings alle |
| Preislogik | CSV-Vorrang, SendCloud-Fallback | Verhandelte Sonderpreise in CSVs sind genauer; neue Carrier funktionieren sofort |

## 1. Daten-Synchronisation (Backend)

### Neue Firestore Collection: `shipping_methods`

Dokument pro Methode, ID = SendCloud `id` (als String).

```
{
  tenantId: string,
  sendcloudId: number,
  carrier: string,           // "dhl", "dpd", "gls", "ups", etc.
  carrierName: string,       // Display-Name des Carriers
  name: string,              // "DHL Paket", "DPD Classic 0-5 kg", etc.
  minWeight: number,         // kg
  maxWeight: number,         // kg
  countries: string[],       // ["DE", "AT", "NL", ...]
  prices: object | null,     // SendCloud-Preise wenn verfügbar
  servicePointInput: string, // "none", "required", "optional"
  enabled: boolean,          // In SendCloud-Account aktiv
  lastSyncedAt: string       // ISO timestamp
}
```

Alle Queries mit `tenantId` (CLAUDE.md Regel #8).

### Sync-Logik

Neue Funktion `syncShippingMethods(tenantId)` in `backend/services/shipping-engine.js`:

1. Prüft `lastSyncedAt` des neuesten Dokuments — wenn < 1 Stunde alt, gibt gecachte Liste zurück (Stale-Check)
2. Ruft `GET https://panel.sendcloud.sc/api/v2/shipping_methods` auf (bestehende Auth-Logik)
3. Mapped jede Methode auf das Schema oben
4. Upsert in Firestore `shipping_methods` Collection (batch write)
5. Entfernt Methoden die nicht mehr in der API-Antwort sind (`enabled: false` setzen, nicht löschen)
6. Gibt aktualisierte Liste zurück

### Trigger

- Öffnen der Order-Settings-Seite (Frontend ruft Sync-Endpoint)
- Öffnen des Ship-Dialogs in OrderDetail
- Manueller Refresh-Button im UI
- Stale-Check verhindert unnötige API-Calls (max 1x pro Stunde)

### Neue/Erweiterte Endpoints

**Neu:** `POST /api/shipping-methods/sync`
- Triggert `syncShippingMethods(tenantId)`
- Response: `{ methods: ShippingMethod[], syncedAt: string }`

**Erweitert:** `GET /api/shipping-methods`
- Liest aus Firestore statt live SendCloud API
- Optional Query-Parameter für kontextbezogene Filterung:
  - `?weight=2.5` — nur Methoden deren Gewichtsbereich passt
  - `?country=DE` — nur Methoden die das Zielland unterstützen
  - `?grouped=true` — Antwort gruppiert nach Carrier
- Wenn Collection leer: automatischer Sync-Trigger (Erststart)

## 2. Manuelle Carrier-Auswahl (OrderDetail)

### Ship-Dialog Erweiterung

Wenn der User auf "Versenden" klickt, zeigt der Dialog zusätzlich:

1. **Carrier-Dropdown** — Gruppierte Liste aller synchronisierten Carrier (DHL, DPD, GLS, ...)
2. **Methoden-Dropdown** — Gefiltert nach:
   - Gewähltem Carrier
   - Gewicht der Bestellung
   - Zielland der Bestellung
3. **Default-Auswahl** — Automatisch per Carrier-Regel bestimmte Methode ist vorausgewählt
4. **Override** — User kann jederzeit eine andere Methode wählen

Der gewählte `shippingMethodId` wird an `POST /api/orders/:id/ship` übergeben. Die bestehende Logik in `shipOrder()` nutzt diesen Wert bereits — kein Backend-Change nötig für den eigentlichen Versand.

### Betroffene Dateien

- `components/OrderDetail.tsx` — Ship-Dialog erweitern
- `api/client.ts` — `getShippingMethods()` mit neuen Query-Parametern
- `hooks/` — Optional: `useShippingMethods(weight, country)` Hook

## 3. Bulk-Ship Erweiterung

### Optionales Methoden-Override

Im Bulk-Ship-Dialog (ShippingView.tsx):

1. Neues optionales Dropdown: "Versandmethode für alle" (Carrier + Methode)
2. Wenn gesetzt: alle gewählten Bestellungen nutzen diese Methode
3. Wenn leer: weiterhin automatische Regelzuordnung pro Bestellung (Gewicht-basiert)
4. Hinweistext: "Ohne Auswahl wird die Versandmethode automatisch per Regel bestimmt"

### Backend

`POST /api/orders/bulk-ship` akzeptiert bereits `shippingMethodId` — muss nur pro Order weitergereicht statt global gesetzt werden. Anpassung: wenn `shippingMethodId` im Request-Body, überschreibt er die Regel für alle Orders im Batch.

## 4. Regelkonfiguration (OrderSettings)

### Carrier-Rules UI Verbesserung

Aktuell: `shippingMethodId` ist ein Freitext-Zahlenfeld.

Neu: Dropdown aus synchronisierten Methoden.

1. Beim Öffnen der Settings: `POST /api/shipping-methods/sync` triggern
2. Carrier-Rules-Formular:
   - Gewichtsbereich (`minWeight`, `maxWeight`) — bleibt Freitext
   - Versandmethode — Dropdown, gruppiert nach Carrier
   - `carrier` wird automatisch aus gewählter Methode befüllt
   - `label` wird automatisch aus Methoden-Name befüllt
3. Validierung: gewählte Methode muss existieren (kein veralteter ID-Wert)

### Betroffene Dateien

- `components/orders/OrderSettingsView.tsx` — Dropdown statt Freitext
- `backend/routes/orders.js` — Validierung optional erweitern (prüfen ob `shippingMethodId` in `shipping_methods` existiert)

## 5. Preislogik

Keine Änderung am bestehenden System:

1. CSV-Preis hat Vorrang (DHL, DPD Sonderkonditionen in `backend/data/`)
2. SendCloud-API-Preis als Fallback (aus Parcel-Response)
3. `costEstimated: true` Flag wenn Fallback genutzt
4. Neue Carrier ohne CSV nutzen automatisch SendCloud-Preis

## 6. Nicht im Scope

- Keine eigene Carrier-Verwaltung (SendCloud bleibt Source of Truth)
- Kein Servicepoint-Auswahl-UI (kann als Follow-up ergänzt werden)
- Keine automatische CSV-Preistabellen-Generierung
- Keine Änderung an Webhook-Handling oder Tracking-Sync

## Betroffene Dateien (Zusammenfassung)

| Datei | Änderung |
|-------|----------|
| `backend/services/shipping-engine.js` | `syncShippingMethods()`, Firestore CRUD |
| `backend/routes/orders.js` | Neuer Sync-Endpoint, erweiterter GET |
| `components/OrderDetail.tsx` | Ship-Dialog mit Carrier/Methoden-Dropdown |
| `components/orders/ShippingView.tsx` | Bulk-Ship Methoden-Override |
| `components/orders/OrderSettingsView.tsx` | Carrier-Rules Dropdown |
| `api/client.ts` | Neue/erweiterte API-Funktionen |
| `types.ts` | `ShippingMethod` Interface |
