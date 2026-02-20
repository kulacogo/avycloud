# eBay Listing Update Feature Design

## Summary
Bereits gelistete Artikel auf eBay aktualisieren (gap-basiert via ReviseFixedPriceItem).

## Anforderungen
- Selektierte Artikel aktualisieren ("eBay aktualisieren"-Button)
- Alle gelisteten Artikel auf einmal aktualisieren (Bulk-Aktion)
- Gap-basiert: nur geänderte Felder werden übertragen
- Direkt anwenden mit Ergebnis-Summary (kein Dry-Run-Preview)

## Backend

### Neue Funktion: `bulkUpdateListedProducts` (ebay-direct.js)
- `applyAll: true` → alle aktiven ItemIds aus `ebayListingsLive`
- `productIds` → ItemIds aus `ebayListingLinks` (productId-Match), Fallback SKU-Match
- Delegiert an bestehende `applySync`-Pipeline (GetItem + ReviseFixedPriceItem, gap-basiert)
- Rückgabe: `{ total, success, failed, results: [{itemId, productId, ok, updatedFields, error}] }`

### Neuer Endpoint: `POST /api/ebay/update/bulk`
```json
{ "productIds": ["..."], "applyAll": true }
```

## Frontend (AdminTable)

### Neuer Button: "eBay aktualisieren"
- Neben "Auf eBay listen"-Button
- Sichtbar wenn ≥1 selektiertes Produkt gelistet ist
- Deaktiviert während Update (`ebayUpdateInProgress`)

### Neue Bulk-Aktion: "Alle eBay-Listings aktualisieren"
- Im bestehenden Dropdown-Menü
- Selektion-unabhängig

### Flow
```
Click → confirm(dialog) → API → Notice (Aktualisiert: X, Fehlgeschlagen: Y)
```

## API Client
```typescript
bulkUpdateEbayListings({ productIds?, applyAll? }) → POST /api/ebay/update/bulk
```
