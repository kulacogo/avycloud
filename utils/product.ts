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

const toNumber = (value: any): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Physical quantity (what is in the warehouse), independent of reservations.
 * Prefers API-enriched `inventory.physicalQuantity` when present.
 */
export const getProductPhysicalQuantity = (product: Product): number => {
  const physical = (product as any)?.inventory?.physicalQuantity;
  if (typeof physical === 'number' && Number.isFinite(physical)) {
    return Math.max(0, physical);
  }

  const inventoryQty = product?.inventory?.quantity;
  if (typeof inventoryQty === 'number' && Number.isFinite(inventoryQty)) {
    return Math.max(0, inventoryQty);
  }

  const storageQty = product?.storage?.quantity;
  if (typeof storageQty === 'number' && Number.isFinite(storageQty)) {
    return Math.max(0, storageQty);
  }

  if (Array.isArray(product.storageBins) && product.storageBins.length) {
    return product.storageBins.reduce((sum, bin) => sum + toNumber(bin?.quantity), 0);
  }

  return 0;
};

/**
 * Reserved quantity from open orders (API-enriched).
 */
export const getProductReservedQuantity = (product: Product): number => {
  const reserved = (product as any)?.inventory?.reservedQuantity;
  if (typeof reserved === 'number' && Number.isFinite(reserved)) {
    return Math.max(0, reserved);
  }
  return 0;
};

/**
 * Available quantity = physical - reserved (API-enriched preferred).
 */
export const getProductAvailableQuantity = (product: Product): number => {
  const available = (product as any)?.inventory?.availableQuantity;
  if (typeof available === 'number' && Number.isFinite(available)) {
    return Math.max(0, available);
  }
  const physical = getProductPhysicalQuantity(product);
  const reserved = getProductReservedQuantity(product);
  return Math.max(0, physical - reserved);
};

export const getProductQuantity = (product: Product): number => {
  // Backwards-compatible alias: historically this represented "physical quantity".
  return getProductPhysicalQuantity(product);
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

const safeString = (value: unknown): string => {
  return value == null ? '' : String(value).trim();
};

const normalizeBreadcrumb = (value: unknown): string => {
  const raw = safeString(value).replace(/\s+/g, ' ');
  if (!raw) return '';
  return raw
    .split('>')
    .map((segment) => safeString(segment))
    .filter(Boolean)
    .join(' > ');
};

/**
 * Canonical BaseLinker category breadcrumb used in ProductSheet.
 * Falls back to legacy multi-inventory storage keys if needed.
 */
export const getProductBaselinkerCategoryPath = (product: Product): string => {
  const details: any = product?.details || {};
  const legacy = details?.baselinkerCategories;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    // Keep precedence aligned with backend resolver:
    // 78659 is the canonical single-inventory source.
    const preferredKeys = ['78659'];
    for (const key of preferredKeys) {
      const value = normalizeBreadcrumb((legacy as Record<string, unknown>)[key]);
      if (value) return value;
    }
  }

  const direct = normalizeBreadcrumb(details?.baselinkerCategoryPath);
  if (direct) return direct;

  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const secondaryKeys = ['91387'];
    for (const key of secondaryKeys) {
      const value = normalizeBreadcrumb((legacy as Record<string, unknown>)[key]);
      if (value) return value;
    }
    for (const value of Object.values(legacy as Record<string, unknown>)) {
      const normalized = normalizeBreadcrumb(value);
      if (normalized) return normalized;
    }
  }

  const attrs: any = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const attrDirect = normalizeBreadcrumb(attrs?.Kategorie);
  if (attrDirect) return attrDirect;
  const attrKey = Object.keys(attrs).find((key) => safeString(key).toLowerCase() === 'kategorie');
  if (attrKey) {
    const attrValue = normalizeBreadcrumb(attrs[attrKey]);
    if (attrValue) return attrValue;
  }

  return '';
};

/**
 * UI display category:
 * - Use BaseLinker category breadcrumb only (inventory taxonomy)
 * - If missing, show placeholder instead of mixing in eBay taxonomy
 */
export const getProductDisplayCategory = (product: Product): string => {
  const blCategory = getProductBaselinkerCategoryPath(product);
  return blCategory || '—';
};
