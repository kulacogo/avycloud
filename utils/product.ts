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
  const inventoryQty = product?.inventory?.quantity;
  if (typeof inventoryQty === 'number' && Number.isFinite(inventoryQty)) {
    return Math.max(0, inventoryQty);
  }

  const storageQty = product?.storage?.quantity;
  if (typeof storageQty === 'number' && Number.isFinite(storageQty)) {
    return Math.max(0, storageQty);
  }

  if (Array.isArray(product.storageBins) && product.storageBins.length) {
    return product.storageBins.reduce((sum, bin) => sum + (bin.quantity || 0), 0);
  }

  return 0;
};

const sanitizeNumeric = (value?: string | number | null): string | null => {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D+/g, '');
  if (digits.length >= 6) {
    return digits;
  }
  return null;
};

const hashStringToDigits = (input: string): string => {
  const MODULO = 1_000_000_000_000; // 12 digits
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 131 + input.charCodeAt(i)) % MODULO;
  }
  const normalized = hash || 1;
  return normalized.toString().padStart(12, '0');
};

export const getStableNumericId = (product: Product): string => {
  const identifiers = product.details?.identifiers ?? {};
  const preferred = [identifiers.ean, identifiers.gtin, product.id];
  for (const candidate of preferred) {
    const numeric = sanitizeNumeric(candidate);
    if (numeric) {
      return numeric;
    }
  }
  return hashStringToDigits(product.id || product.identification?.name || 'product');
};
