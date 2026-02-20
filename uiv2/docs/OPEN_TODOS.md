# Open TODOs (AvyCloud)

## eBay OAuth (Konto-Anmeldung) – wartet auf eBay Developer Program Freischaltung

- **Status**: offen / blockiert (Credentials fehlen)
- **Notiert am**: 2026-02-10
- **Reminder**: 2026-02-11 (selbe Uhrzeit wie dieses Ticket)

### Benötigte Inputs (vom User)

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RU_NAME` (RuName / redirect_uri value, nicht die URL)
- optional `EBAY_SCOPES` (wenn mehr als `sell.inventory.readonly` benötigt wird)

### Danach (kurz)

1. In AvyCloud: Admin → Integrations → eBay verbinden (OAuth Login/Consent)
2. MIP CSV importieren (Listing-Snapshots): `trendocean_239306_Combined_MIP.csv`
3. Live-Test: Offers by SKU (`GET /api/ebay/offers?sku=...`)

