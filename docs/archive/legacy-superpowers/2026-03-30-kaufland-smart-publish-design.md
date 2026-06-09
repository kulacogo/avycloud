# Kaufland Smart Bulk Publish

## Problem

Kaufland bulk publish fails for 85/100 products with "Unbekannter Fehler". Root causes are missing product data that can be auto-derived or auto-created. The frontend also swallows actual error messages (checks `blockers[]` instead of `error`).

## Solution

Add a pre-publish auto-fix pipeline to the bulk publish endpoint that resolves common issues automatically before attempting to create a Kaufland unit.

## Auto-Fix Pipeline

For each product in the bulk publish request:

```
1. Validate   → EAN present? SKU present?
2. Fix Price  → sellPrice missing? → derive from buyPrice × 1.40 or lowest_price
3. Defaults   → id_shipping_group fallback 144080, id_warehouse fallback 70462
4. Publish    → createUnit()
5. On Fail    → KAUFLAND_PRODUCT_NOT_FOUND? → putProductData() with title+EAN → retry createUnit()
6. Result     → { ok, status: 'published'|'fixed'|'skipped', fixes: [...], reason? }
```

### Skip Conditions (not fixable)

- No EAN → skip, reason: "Keine EAN vorhanden"
- Invalid EAN (Kaufland rejects) → skip, reason: "EAN ungültig"
- No price derivable (no sellPrice, buyPrice, or lowest_price) → skip, reason: "Kein Preis ableitbar"

### Auto-Fix Actions

| Problem | Fix | Source |
|---------|-----|--------|
| Missing sellPrice | Use `buyPrice * 1.40` | `details.pricing.buyPrice` |
| Missing sellPrice + buyPrice | Use `lowest_price.amount` | `details.pricing.lowest_price.amount` |
| EAN unknown at Kaufland | `putProductData({ ean, attributes: { title } })` then retry | Product title + EAN |
| Missing shipping group | Default `144080` | Hardcoded (SendCloud DPD DE) |
| Missing warehouse | Default `70462` | Hardcoded (Temp Warehouse) |

### Defaults

- `id_shipping_group`: 144080 (SendCloud DPD DE:de)
- `id_warehouse`: 70462 (Temp Warehouse)

Applied only when product has no explicit value set.

## Result Format (per product)

```json
{
  "productId": "abc123",
  "ok": true,
  "status": "fixed",
  "fixes": ["Preis aus Einkaufspreis abgeleitet (EK 10.00 x 1.40 = 14.00)", "Versandgruppe: Standard"],
  "data": { "id_unit": 12345 }
}
```

Or for skipped:

```json
{
  "productId": "xyz789",
  "ok": false,
  "status": "skipped",
  "reason": "Keine EAN vorhanden"
}
```

## Frontend Changes

- Use `r.error || r.reason` instead of `r.blockers` for Kaufland results (already partially fixed)
- Show three categories in bulk result: published, fixed+published, skipped
- Show fix details for auto-fixed products

## Files Modified

- `backend/routes/marketplace.js` — bulk publish endpoint with auto-fix pipeline
- `backend/lib/kaufland-api.js` — add `ensureProductData()` helper
- `components/MarketplaceListingsView.tsx` — result display with fix/skip categories
- `api/client.ts` — update `BulkPublishResult` type

## Non-Goals

- Changing single publish endpoint (only bulk)
- Modifying `pickUnitData()` core validation
- Creating new Firestore collections
- Persisting fix history
