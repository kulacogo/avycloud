import { useCallback, useEffect, useState } from 'react';
import { InventoryRecord } from '../types';
import {
  fetchInventories,
  syncInventories,
} from '../api/client';
import { useAuth } from '../context/AuthContext';

export function useInventories() {
  const { user, loading: authLoading } = useAuth();
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInventories = useCallback(async () => {
    // Avoid 401 spam while auth is still initializing or user is logged out.
    if (authLoading || !user) {
      setInventories([]);
      setError(null);
      return;
    }
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
  }, [authLoading, user?.uid]);

  const triggerSync = useCallback(async () => {
    if (authLoading || !user) {
      setError('Bitte zuerst einloggen.');
      return;
    }
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
  }, [authLoading, user?.uid, loadInventories]);

  useEffect(() => {
    loadInventories();
  }, [loadInventories, authLoading, user?.uid]);

  return {
    inventories,
    loading,
    error,
    refresh: loadInventories,
    sync: triggerSync,
    syncing,
  };
}

