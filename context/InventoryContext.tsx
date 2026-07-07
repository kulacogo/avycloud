import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { InventoryRecord } from '../types';
import { useInventories } from '../hooks/useInventories';
import { fetchInventoryById } from '../api/client';

export interface InventoryContextValue {
  inventories: InventoryRecord[];
  loading: boolean;
  error: string | null;
  refreshInventories: () => Promise<void>;
  syncInventories: () => Promise<void>;
  syncing: boolean;
  activeInventoryId: string | null;
  activeInventory: InventoryRecord | null;
  setActiveInventoryId: (inventoryId: string | null) => void;
  resolveInventory: (inventoryId: string) => Promise<InventoryRecord | null>;
}

const InventoryContext = createContext<InventoryContextValue | undefined>(undefined);
const STORAGE_KEY = 'avystock:inventory';

export const InventoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { inventories, loading, error, refresh, sync, syncing } = useInventories();
  const [activeInventoryId, setActiveInventoryIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage might be blocked (SecurityError) or unavailable
      return null;
    }
  });

  const setActiveInventoryId = useCallback((inventoryId: string | null) => {
    setActiveInventoryIdState(inventoryId);
    if (typeof window !== 'undefined') {
      try {
        if (inventoryId) {
          window.localStorage.setItem(STORAGE_KEY, inventoryId);
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // Storage might be full or blocked
      }
    }
  }, []);

  const activeInventory = useMemo(() => {
    if (!activeInventoryId) return null;
    return inventories.find((inv) => inv.inventoryId === activeInventoryId) || null;
  }, [activeInventoryId, inventories]);

  const resolveInventory = useCallback(
    async (inventoryId: string) => {
      const cached =
        inventories.find((inv) => inv.inventoryId === inventoryId) || null;
      if (cached) {
        return cached;
      }
      try {
        const record = await fetchInventoryById(inventoryId);
        if (record) {
          await refresh();
        }
        return record;
      } catch (error) {
        console.error('Failed to resolve inventory:', error);
        return null;
      }
    },
    [inventories, refresh]
  );

  const value: InventoryContextValue = {
    inventories,
    loading,
    error,
    refreshInventories: refresh,
    syncInventories: sync,
    syncing,
    activeInventoryId,
    activeInventory,
    setActiveInventoryId,
    resolveInventory,
  };

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
};

export const useInventoryContext = () => {
  const ctx = useContext(InventoryContext);
  if (!ctx) {
    throw new Error('useInventoryContext must be used within an InventoryProvider');
  }
  return ctx;
};

