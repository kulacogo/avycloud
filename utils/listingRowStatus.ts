/** Listing eligibility uses marketplace state, never a stale product badge.
 * Existing invalid/indexing units remain excluded from duplicate creation;
 * manual Kaufland publish reuses an inactive unit after a fresh API check.
 */
export interface ListingRowStatusFields {
  status?: string | null;
  listingStatus?: string | null;
  active?: boolean | null;
  quantity?: number | null;
}
const EXISTING_STATUSES = new Set(["active", "available", "live", "indexing", "invalid"]);
const INACTIVE_STATUSES = new Set(["ended", "completed", "onhold", "paused", "inactive", "deactivated", "blocked", "in_review", "stale", "deleted"]);
export function isListingRowActive(row: ListingRowStatusFields | null | undefined): boolean {
  if (!row || row.active === false) return false;
  const status = String(row.listingStatus || row.status || "").trim().toLowerCase();
  if (INACTIVE_STATUSES.has(status)) return false;
  if (["available", "live"].includes(status) && row.quantity === 0) return false;
  return row.active === true || EXISTING_STATUSES.has(status);
}
