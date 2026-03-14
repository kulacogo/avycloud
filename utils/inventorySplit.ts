import type { Product } from '../types';
import { getProductPhysicalQuantity } from './product';

export function hasBin(product: Product): boolean {
  const code = (product as any)?.storage?.binCode;
  if (typeof code === 'string' && code.trim().length > 0) return true;
  const bins = (product as any)?.storageBins;
  if (Array.isArray(bins) && bins.length) {
    return bins.some((b) => typeof b?.code === 'string' && b.code.trim().length > 0);
  }
  return false;
}

export function hasMarketplaceListing(product: Product): boolean {
  const listingStatus = (product as any)?.ops?.listingStatus;
  if (!listingStatus) return false;
  return listingStatus.ebay === 'active' || listingStatus.kaufland === 'active';
}

export function hasAiImages(product: Product): boolean {
  const images = (product as any)?.details?.images;
  if (!Array.isArray(images) || images.length === 0) return false;
  return images.some((img) => {
    const source = String(img?.source || '').toLowerCase();
    if (source === 'generated') return true;
    // In our pipelines, AI-enriched images are often stored as "web" (extracted/scraped/selected by AI),
    // while manual operator images are "upload".
    if (source === 'web') return true;
    const notes = String(img?.notes || '');
    return /\b(ai|generated|gen)\b/i.test(notes);
  });
}

export function isInventoryItem(product: Product): boolean {
  // Inventory view = physical warehouse inventory:
  // - has physical stock (>0)
  // - has at least one BIN
  //
  // "Ready & live" gates (sync/listing/AI/completeness) are handled via filters,
  // not as hard requirements here, to avoid empty Inventory when enrichment is partial.
  const qty = getProductPhysicalQuantity(product);
  if (!(qty > 0)) return false;
  if (!hasBin(product)) return false;
  return true;
}

export function isProductBacklogItem(product: Product): boolean {
  return !isInventoryItem(product);
}

