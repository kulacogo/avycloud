import type { Product } from '../types';
import { getProductPhysicalQuantity, normalizeSyncStatus } from './product';

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
  const count = (product as any)?.ops?.baselinker?.links_count;
  if (typeof count === 'number' && Number.isFinite(count)) return count > 0;
  const flag = (product as any)?.ops?.baselinker?.has_links;
  if (typeof flag === 'boolean') return flag;
  return false;
}

export function hasAiImages(product: Product): boolean {
  const images = (product as any)?.details?.images;
  if (!Array.isArray(images) || images.length === 0) return false;
  return images.some((img) => {
    const source = String(img?.source || '').toLowerCase();
    if (source === 'generated') return true;
    const notes = String(img?.notes || '');
    return /\b(ai|generated|gen)\b/i.test(notes);
  });
}

export function isBaselinkerSyncedOk(product: Product): boolean {
  const status = normalizeSyncStatus(
    ((product as any)?.ops?.sync_status || 'pending') as any,
    (product as any)?.ops?.last_synced_iso
  );
  if (status !== 'synced') return false;
  const last = (product as any)?.ops?.last_synced_iso;
  return typeof last === 'string' && last.trim().length > 0;
}

export function isInventoryItem(product: Product): boolean {
  const qty = getProductPhysicalQuantity(product);
  if (!(qty > 0)) return false;
  if (!hasBin(product)) return false;
  if (!isBaselinkerSyncedOk(product)) return false;
  if (!hasMarketplaceListing(product)) return false;
  if (!hasAiImages(product)) return false;
  if (!(product as any)?.completeness?.complete) return false;
  return true;
}

export function isProductBacklogItem(product: Product): boolean {
  return !isInventoryItem(product);
}

