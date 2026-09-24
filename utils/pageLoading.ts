// These views load their primary data themselves; the catalog is only optional
// enrichment. Keep their requests mounted while App loads products in parallel.
const INDEPENDENT_VIEWS = new Set(['dashboard', 'home', 'finance', 'marketplace-ebay', 'marketplace-kaufland']);
export function blocksOnProductCatalog(view: string, loading: boolean, productCount: number): boolean {
  return loading && productCount === 0 && !INDEPENDENT_VIEWS.has(view);
}
