/**
 * Entscheidet, ob eine Marktplatz-Listing-Zeile ein auf dem Marktplatz
 * EXISTIERENDES Angebot repraesentiert (Incident 2026-08-20).
 *
 * Hintergrund: Das Publish-Modal schloss "bereits gelistet" ueber
 * `l.status === "active" | "live" | "indexing" | "invalid"` aus. Das
 * matchte in der Praxis NIE:
 *   - eBay-Zeilen (/api/ebay/listings) tragen GAR KEIN status-Feld,
 *     nur `active: boolean` + `listingStatus` (meist null, der
 *     Light-Sync-Ingest liefert es nicht).
 *   - Kaufland-Zeilen liefern den Status seit dem Ghost-Row-Fix
 *     GROSSGESCHRIEBEN ("LIVE"), der Vergleich war lowercase.
 * Ergebnis: die SKU/EAN-Ausschlussliste war leer und bereits gelistete
 * Artikel erschienen weiter auf der "zu listenden"-Liste.
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
