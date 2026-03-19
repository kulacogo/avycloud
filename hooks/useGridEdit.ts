import { useState, useCallback, useMemo } from "react";
import type { BulkFieldUpdate } from "../api/client";

export interface GridEditState {
  isEditMode: boolean;
  dirtyFields: Map<string, Record<string, any>>;
}

export interface UseGridEditReturn {
  isEditMode: boolean;
  dirtyFields: Map<string, Record<string, any>>;
  dirtyCount: number;
  toggleEditMode: () => void;
  setCellValue: (productId: string, field: string, value: any, originalValue: any) => void;
  discardAll: () => void;
  getDirtyProductIds: () => string[];
  getDirtyUpdates: () => { productIds: string[]; updates: Map<string, BulkFieldUpdate[]> };
  /** Convert dirty map to per-product bulk-update calls */
  toBulkUpdatePayloads: () => { productId: string; updates: BulkFieldUpdate[] }[];
}

export function useGridEdit(): UseGridEditReturn {
  const [isEditMode, setIsEditMode] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Map<string, Record<string, any>>>(new Map());

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const fields of dirtyFields.values()) {
      count += Object.keys(fields).length;
    }
    return count;
  }, [dirtyFields]);

  const toggleEditMode = useCallback(() => {
    setIsEditMode((prev) => !prev);
    // Don't auto-discard — user may want to toggle view without losing changes
  }, []);

  const setCellValue = useCallback(
    (productId: string, field: string, value: any, originalValue: any) => {
      setDirtyFields((prev) => {
        const next = new Map(prev);
        const existing = next.get(productId) || {};

        // No-op detection: if value equals original, remove from dirty
        const normalizedOriginal = originalValue ?? "";
        const normalizedNew = value ?? "";
        if (String(normalizedOriginal) === String(normalizedNew)) {
          const { [field]: _removed, ...rest } = existing;
          if (Object.keys(rest).length === 0) {
            next.delete(productId);
          } else {
            next.set(productId, rest);
          }
        } else {
          next.set(productId, { ...existing, [field]: value });
        }

        return next;
      });
    },
    []
  );

  const discardAll = useCallback(() => {
    setDirtyFields(new Map());
  }, []);

  const getDirtyProductIds = useCallback(() => {
    return Array.from(dirtyFields.keys());
  }, [dirtyFields]);

  const getDirtyUpdates = useCallback(() => {
    const productIds: string[] = [];
    const updates = new Map<string, BulkFieldUpdate[]>();
    for (const [productId, fields] of dirtyFields) {
      productIds.push(productId);
      const fieldUpdates: BulkFieldUpdate[] = Object.entries(fields).map(
        ([field, value]) => ({ field, value })
      );
      updates.set(productId, fieldUpdates);
    }
    return { productIds, updates };
  }, [dirtyFields]);

  const toBulkUpdatePayloads = useCallback(() => {
    const payloads: { productId: string; updates: BulkFieldUpdate[] }[] = [];
    for (const [productId, fields] of dirtyFields) {
      payloads.push({
        productId,
        updates: Object.entries(fields).map(([field, value]) => ({ field, value })),
      });
    }
    return payloads;
  }, [dirtyFields]);

  return {
    isEditMode,
    dirtyFields,
    dirtyCount,
    toggleEditMode,
    setCellValue,
    discardAll,
    getDirtyProductIds,
    getDirtyUpdates,
    toBulkUpdatePayloads,
  };
}
