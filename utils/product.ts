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

export const deriveInitials = (email: string): string => {
  const local = (email || "").split("@")[0] || "";
  const parts = local.split(/[.\-_]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
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

const pickEbayCategoryIdFromAttributes = (attributes: Record<string, unknown> | undefined): string => {
  if (!attributes || typeof attributes !== 'object') return '';
  const direct =
    safeString(attributes.ebay_category_id) ||
    safeString(attributes.ebayCategoryId) ||
    safeString(attributes.category_id) ||
    safeString(attributes.categoryId);
  if (direct) {
    const digits = direct.replace(/\D+/g, '');
    return digits || '';
  }
  const key = Object.keys(attributes).find((k) => {
    const lower = safeString(k).toLowerCase();
    return lower === 'kategorie-id' || lower === 'kategorie id' || lower === 'kategorie_id';
  });
  if (!key) return '';
  const value = safeString((attributes as Record<string, unknown>)[key]);
  const digits = value.replace(/\D+/g, '');
  return digits || '';
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
 * Canonical eBay category id for product datasheets/listings.
 * Falls back to known legacy fields where possible.
 */
export const getProductEbayCategoryId = (product: Product): string => {
  const details: any = product?.details || {};
  const attrs =
    details?.attributes && typeof details.attributes === 'object' && !Array.isArray(details.attributes)
      ? (details.attributes as Record<string, unknown>)
      : undefined;
  const direct =
    safeString(details?.categoryId) ||
    safeString(details?.ebayCategoryId) ||
    safeString(details?.ebay_category_id) ||
    pickEbayCategoryIdFromAttributes(attrs);
  if (!direct) return '';
  const digits = direct.replace(/\D+/g, '');
  return digits || direct;
};

/**
 * Canonical eBay category breadcrumb.
 * We intentionally only use eBay listing taxonomy.
 */
export const getProductEbayCategoryPath = (product: Product): string => {
  const categoryId = getProductEbayCategoryId(product);
  if (!categoryId) return '';
  const details: any = product?.details || {};
  const fromIdentification = normalizeBreadcrumb(product?.identification?.category);
  if (fromIdentification) return fromIdentification;
  const fromLegacyPath =
    normalizeBreadcrumb(details?.ebayCategoryPath) ||
    normalizeBreadcrumb(details?.ebayCategoryBreadcrumb);
  if (fromLegacyPath) return fromLegacyPath;
  return '';
};

/**
 * UI display category:
 * - Use eBay category breadcrumb only (listing taxonomy)
 * - If missing/unknown, show placeholder
 */
export const getProductDisplayCategory = (product: Product): string => {
  const ebayCategory = getProductEbayCategoryPath(product);
  return ebayCategory || '—';
};
