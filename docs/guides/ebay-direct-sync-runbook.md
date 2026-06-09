# AvyCloud eBay Direct Sync Runbook

## Ziel

Direkte AvyCloud ↔ eBay Synchronisation ohne retired middleware fuer:

- Live Listing Import (GetMyeBaySelling + GetItem)
- Produkt-Linking (SKU/EAN/GTIN/MPN)
- Gap Analyse (Kategorie, Item Specifics, Titel, Untertitel, Beschreibung)
- Kontrollierten Ruecksync (Dry-Run + Apply via ReviseFixedPriceItem/ReviseItem)

## Benoetigte Secrets / ENV

- `EBAY_TRADING_APP_ID`
- `EBAY_TRADING_DEV_ID`
- `EBAY_TRADING_CERT_ID`
- `EBAY_TRADING_USER_TOKEN`
- Optional:
  - `EBAY_TRADING_ENV` (`production` oder `sandbox`, default `production`)
  - `EBAY_TRADING_SITE_ID` (default `77` = eBay DE)
  - `EBAY_TRADING_COMPATIBILITY_LEVEL` (default `1209`)
  - `EBAY_TRADING_TIMEOUT_MS` (default `25000`)

## API Endpunkte (Backend)

- `GET /api/ebay/trading/status`
- `POST /api/ebay/listings/sync`
- `GET /api/ebay/listings`
- `GET /api/ebay/listings/:itemId/detail`
- `POST /api/ebay/listing-links/rebuild`
- `GET /api/ebay/listing-links`
- `POST /api/ebay/gaps/rebuild`
- `GET /api/ebay/gaps`
- `POST /api/ebay/gaps/:id/actions`
- `POST /api/ebay/sync/dry-run`
- `POST /api/ebay/sync/apply`
- `POST /api/ebay/reports/generate`

## Gap Lifecycle

Status pro Gap:

`new -> reviewed -> accepted|ignored -> ready_to_sync -> synced|failed`

Aktionen:

- `review`
- `accept_avy`
- `accept_ebay`
- `ignore`
- `ready_to_sync`
- `reset`
- `rename_alias`

## Operativer Ablauf

1. **Status pruefen**
   - `GET /api/ebay/trading/status`
2. **Listings importieren + Audit**
   - `POST /api/ebay/listings/sync`
3. **Linking/Gaps nachziehen (optional separat)**
   - `POST /api/ebay/listing-links/rebuild`
   - `POST /api/ebay/gaps/rebuild`
4. **Gaps in AvyCloud UI pruefen und status setzen**
5. **Dry-Run**
   - `POST /api/ebay/sync/dry-run`
6. **Apply**
   - `POST /api/ebay/sync/apply`
7. **Reports exportieren**
   - `POST /api/ebay/reports/generate`

## CLI Skripte

- `node backend/scripts/ebay-sync-live-listings.js --reports`
- `node backend/scripts/ebay-build-product-links.js --reports`
- `node backend/scripts/ebay-audit-gaps.js --reports`
- Dry-Run:
  - `node backend/scripts/ebay-apply-corrections.js --reports`
- Apply:
  - `node backend/scripts/ebay-apply-corrections.js --apply --reports`

## Report Artefakte

In `backend/exports/ebay-direct/<timestamp>/`:

- `summary.json`
- `matched.csv`
- `unmatched.csv`
- `gaps.csv`
- `rename_suggestions.csv`
- `apply_results.csv`

## Guardrails

- Kategorie-Aenderung blockiert bei Geboten (`bidCount > 0`)
- Kategorie-Aenderung blockiert bei Laufzeit < 12h bis Ende
- Nur Gaps mit `accepted` oder `ready_to_sync` gehen in Dry-Run/Apply
