# INT-001: Integrationen — Einstellungen & Konfiguration

> **Ziel:** Marketplace-Rahmenbedingungen (eBay Policies, Kaufland Shipping Groups/Warehouses) und Integrations-Settings (SendCloud, SevDesk) über die API abrufen, in Firestore cachen, als Defaults konfigurieren und im Listing-Flow auswählbar machen.

## Scope

| Integration | API-konfigurierbare Settings |
|---|---|
| **eBay** | Versand-, Rücknahme-, Zahlungs-Rahmenbedingungen (Seller Profiles) |
| **Kaufland** | Versandgruppen, Lager |
| **SendCloud** | Absenderadressen, Versandmethoden |
| **SevDesk** | Steuerraten, Bankkonten |

Nur Settings die über die jeweilige API abrufbar sind erscheinen auf der UI. Portal-only Einstellungen werden nicht abgebildet.

## Architektur

### Datenmodell — Firestore Collection `integration_settings`

Ein Dokument pro Tenant + Integration. Dokument-ID: `{tenantId}__{integration}`.

```
// Beispiel: eBay
{
  tenantId: "trendocean",
  integration: "ebay",
  cachedData: {
    shipping: [{ id: "123", name: "Ohne Versandkosten ab 100€" }, ...],
    return: [{ id: "456", name: "30 Tage Retoure Kostenlos" }, ...],
    payment: [{ id: "789", name: "eBay-Zahlungsabwicklung" }, ...]
  },
  defaults: {
    shippingPolicyId: "123",
    returnPolicyId: "456",
    paymentPolicyId: "789"
  },
  lastSyncedAt: Timestamp
}

// Beispiel: Kaufland
{
  tenantId: "trendocean",
  integration: "kaufland",
  cachedData: {
    shippingGroups: [{ id: 144080, name: "SendCloud DPD DE", storefront: "de", isDefault: true }, ...],
    warehouses: [{ id: 70462, name: "Temp Warehouse", isDefault: true }, ...]
  },
  defaults: {
    shippingGroupId: 144080,
    warehouseId: 70462
  },
  lastSyncedAt: Timestamp
}

// Beispiel: SendCloud
{
  tenantId: "trendocean",
  integration: "sendcloud",
  cachedData: {
    senderAddresses: [{ id: 1, company: "TrendOcean", street: "...", city: "..." }, ...],
    shippingMethods: [{ id: 8, name: "DHL Paket", carrier: "dhl", ... }, ...]
  },
  defaults: {
    senderAddressId: 1,
    shippingMethodId: 8
  },
  lastSyncedAt: Timestamp
}

// Beispiel: SevDesk
{
  tenantId: "trendocean",
  integration: "sevdesk",
  cachedData: {
    taxRates: [{ id: "1", taxRate: 19, name: "Umsatzsteuer 19%" }, ...],
    checkAccounts: [{ id: "42", name: "Geschäftskonto", iban: "DE89..." }, ...]
  },
  defaults: {
    taxRateId: "1",
    checkAccountId: "42"
  },
  lastSyncedAt: Timestamp
}
```

### Cache-Strategie

- **Auto-Sync:** Beim Öffnen der Konfigurations-Seite oder Listing-Dialogs, wenn `lastSyncedAt` > 24h her
- **Manueller Sync:** "Synchronisieren" Button auf jeder Konfigurations-Seite
- **Beim Publish:** Defaults aus `integration_settings` lesen, kein API-Call an Marketplace

### API Endpoints (Backend)

```
GET  /api/integrations/:integration/settings      → Settings + cachedData lesen
PUT  /api/integrations/:integration/defaults       → Defaults setzen
POST /api/integrations/:integration/sync           → Manueller Sync (force)
```

`:integration` = `ebay` | `kaufland` | `sendcloud` | `sevdesk`

### Sync-Funktionen (Backend)

| Integration | API Call | Ziel in cachedData |
|---|---|---|
| eBay | `getSellerProfiles()` (bereits vorhanden) | `shipping`, `return`, `payment` |
| Kaufland | `GET /shipping-groups` (neu) | `shippingGroups` |
| Kaufland | `GET /warehouses` (neu) | `warehouses` |
| SendCloud | `GET /sender_addresses` (neu) | `senderAddresses` |
| SendCloud | `GET /shipping_methods` (neu) | `shippingMethods` |
| SevDesk | `GET /TaxRate` (neu) | `taxRates` |
| SevDesk | `GET /CheckAccount` (bereits vorhanden) | `checkAccounts` |

### Publish-Flow Änderungen

**eBay:** `mapProductToEbayItem()` liest Defaults aus `integration_settings` statt `process.env.EBAY_DEFAULT_*`. ENV-Vars bleiben als Fallback.

**Kaufland:** Hardcoded `KL_DEFAULT_SHIPPING_GROUP` / `KL_DEFAULT_WAREHOUSE` werden durch Firestore-Defaults ersetzt.

**Listing-Dialog (Bulk Publish):** Dropdown-Bereich "Rahmenbedingungen" im Dialog, vorbelegt mit Defaults, änderbar vor Absenden. Override wird als `overrides`-Objekt an den bestehenden Publish-Endpoint geschickt.

## Frontend

### Navigation

Neuer Sidebar-Eintrag **"Integrationen"** mit Unterseiten:
- `/integrations` → Übersicht (Karten für jede Integration mit Status + letzter Sync)
- `/integrations/ebay` → eBay Konfiguration
- `/integrations/kaufland` → Kaufland Konfiguration
- `/integrations/sendcloud` → SendCloud Konfiguration
- `/integrations/sevdesk` → SevDesk Konfiguration

### Konfigurations-Seite (pro Integration)

1. **Header:** Integration-Name + Logo + Verbindungsstatus + "Synchronisieren" Button + letzter Sync Timestamp
2. **Tabelle(n):** Gecachte Rahmenbedingungen/Settings mit Name, ID, Details
3. **Defaults:** Radio/Select pro Kategorie für bevorzugte Auswahl, "Speichern" Button

### Listing-Dialog Erweiterung

Im bestehenden eBay Bulk-Publish-Dialog:
- Aufklappbarer Bereich "Rahmenbedingungen"
- 3 Dropdowns: Versand, Rücknahme, Zahlung — vorbelegt mit Defaults
- Gleiches für Kaufland: Versandgruppe + Lager Dropdowns

## Nicht im Scope

- Erstellen/Bearbeiten von Rahmenbedingungen (nur Lesen + Auswahl)
- Kaufland Return Policies (keine API dafür)
- SendCloud Contracts/Brands (nice-to-have, spätere Iteration)
- SevDesk Buchungskonten/Einheiten (nice-to-have, spätere Iteration)
