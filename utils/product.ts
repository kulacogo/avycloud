import { Product, SyncStatus } from '../types';

export const normalizeSyncStatus = (
  status: SyncStatus,
  lastSyncedIso?: string | null
): SyncStatus => {
  if (status === 'synced' && !lastSyncedIso) {
    return 'pending';
  }
  return status;
};

export const getProductQuantity = (product: Product): number => {
  const inventoryQty = product.inventory?.quantity ?? 0;
  const storageQty = product.storage?.quantity ?? 0;
  return inventoryQty + storageQty;
};

