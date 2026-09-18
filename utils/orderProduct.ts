import type { OrderItem, Product } from "../types";

type ProductIdentity = Pick<Product, "id"> & {
  identification?: { sku?: string | null; barcodes?: string[] };
  details?: { identifiers?: { sku?: string | null; ean?: string | null; gtin?: string | null; upc?: string | null } };
};
const key = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** Read-only resolution. Never uses the intake resolver (it changes stock). */
export async function resolveOrderProduct<P extends ProductIdentity>(item: OrderItem, deps: {
  products: P[];
  loadProducts: () => Promise<P[]>;
  loadProduct: (id: string) => Promise<P>;
}): Promise<P> {
  const ids = [...new Set([item.productId, item.pickHint?.productId].map(value => String(value || "").trim()).filter(Boolean))];
  if (ids.length > 1) throw new Error("Die Produktzuordnung dieser Position ist widersprüchlich.");
  const sku = key(item.sku || item.pickHint?.sku);
  const ean = key(item.ean);
  if (!ids.length && !sku && !ean) throw new Error("Diese Position hat keine eindeutige Produktzuordnung.");
  const matches = (product: P) => {
    if (ids.length) return product.id === ids[0];
    if (sku) return [product.identification?.sku, product.details?.identifiers?.sku].some(value => key(value) === sku);
    return [product.details?.identifiers?.ean, product.details?.identifiers?.gtin, product.details?.identifiers?.upc, ...(product.identification?.barcodes || [])].some(value => key(value) === ean);
  };
  // This list is already tenant-scoped by GET /api/products. An unverified
  // ID from a historic order must never be used to fetch an arbitrary product.
  let candidates = deps.products.filter(matches);
  if (!candidates.length) candidates = (await deps.loadProducts()).filter(matches);
  if (!candidates.length) throw new Error("Das Produkt dieser Position ist nicht verfügbar oder nicht mehr zugeordnet.");
  if (candidates.length !== 1) throw new Error("Die Produktzuordnung ist mehrdeutig. Bitte die SKU prüfen.");
  const product = await deps.loadProduct(candidates[0].id);
  if (product.id !== candidates[0].id) throw new Error("Das geladene Produkt passt nicht zur Bestellposition.");
  return product;
}
