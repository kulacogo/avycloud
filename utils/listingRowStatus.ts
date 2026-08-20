/**
 * Entscheidet, ob eine Marktplatz-Listing-Zeile ein auf dem Marktplatz
 * EXISTIERENDES Angebot repraesentiert (Incident 2026-08-20, praezisiert
 * 2026-08-21).
 *
 * Robust gegen BEIDE Zeilen-Formen:
 *   - ROHE eBay-Zeilen (/api/ebay/listings) tragen KEIN status-Feld, nur
 *     `active: boolean` (+ `listingStatus`, meist null — der Light-Sync-
 *     Ingest liefert es nicht) → active===true zaehlt.
 *   - ROHE Kaufland-Zeilen liefern den Status seit dem Ghost-Row-Fix
 *     GROSSGESCHRIEBEN ("LIVE") → Vergleich case-insensitiv.
 *   - NORMALISIERTE Zeilen (MarketplaceListingsView) haben lowercase-Status
 *     ("active"/"live"/"indexing"/"invalid") → Status-Set matcht.
 * (Historische Einordnung: Das Publish-Modal arbeitete schon immer auf den
 * normalisierten Zeilen — dort versagte 2026-08-20 nicht der Vergleich,
 * sondern die ops.listingStatus-Kette + das 6000er-Fetch-Limit.)
 *
 * "invalid"/"indexing" zaehlen bewusst als existent: die Unit ist beim
 * Marktplatz angelegt (auch wenn nicht kaufbar) — ein erneutes Publish
 * wuerde eine Duplikat-Unit erzeugen.
 */
export interface ListingRowStatusFields {
  status?: string | null;
  active?: boolean | null;
}

const EXISTING_STATUSES = new Set(["active", "live", "indexing", "invalid"]);

export function isListingRowActive(row: ListingRowStatusFields | null | undefined): boolean {
  if (!row) return false;
  if (row.active === true) return true;
  const status = String(row.status ?? "").trim().toLowerCase();
  return EXISTING_STATUSES.has(status);
}
