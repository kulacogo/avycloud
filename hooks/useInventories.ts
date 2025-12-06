import { useCallback, useEffect, useState } from 'react';
import { InventoryRecord } from '../types';
import {
  fetchInventories,
  syncInventories,
} from '../api/client';

export function useInventories() {
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInventories = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchInventories();
      setInventories(list);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load inventories:', err);
      setError(err?.message || 'Inventories konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncInventories();
      await loadInventories();
    } catch (err: any) {
      console.error('Inventory sync failed:', err);
      setError(err?.message || 'Inventory-Sync fehlgeschlagen.');
    } finally {
      setSyncing(false);
    }
  }, [loadInventories]);

  useEffect(() => {
    loadInventories();
  }, [loadInventories]);

  return {
    inventories,
    loading,
    error,
    refresh: loadInventories,
    sync: triggerSync,
    syncing,
  };
}

