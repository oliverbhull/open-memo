import { useState, useEffect, useCallback, useRef } from 'react';
import { FeedEntryData } from '../components/FeedEntry';
import { entryService } from '../services/EntryService';
import { syncOrchestrator } from '../services/SyncOrchestrator';

export function useEntries() {
  const [entries, setEntries] = useState<FeedEntryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const mountedRef = useRef(true);

  // Initialize and load entries
  useEffect(() => {
    const abortController = new AbortController();
    mountedRef.current = true;

    const init = async () => {
      try {
        await entryService.init();
        
        if (abortController.signal.aborted || !mountedRef.current) return;

        const recentEntries = entryService.getRecentEntries();
        if (!abortController.signal.aborted && mountedRef.current) {
          setEntries(recentEntries);
        }
        
        const count = await entryService.getTotalCount();
        if (!abortController.signal.aborted && mountedRef.current) {
          setTotalCount(count);
          setLoading(false);
        }
      } catch (err) {
        if (abortController.signal.aborted || !mountedRef.current) return;
        setError(err instanceof Error ? err : new Error('Failed to initialize'));
        setLoading(false);
      }
    };

    init();

    // Listen for new entries
    const handleEntryAdded = (entry: FeedEntryData) => {
      if (!abortController.signal.aborted && mountedRef.current) {
        setEntries(prev => [entry, ...prev]);
        setTotalCount(prev => prev + 1);
      }
    };

    // Listen for errors
    const handleError = (err: unknown) => {
      if (!abortController.signal.aborted && mountedRef.current) {
        setError(err instanceof Error ? err : new Error('Entry service error'));
      }
    };

    entryService.on('entryAdded', handleEntryAdded);
    entryService.on('error', handleError);

    return () => {
      abortController.abort();
      mountedRef.current = false;
      entryService.off('entryAdded', handleEntryAdded);
      entryService.off('error', handleError);
    };
  }, []);

  // Add a new entry
  const addEntry = useCallback(async (data: unknown) => {
    try {
      const entry = await entryService.addEntry(data);
      return entry;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to add entry'));
      return null;
    }
  }, []);

  // Load more entries (for lazy loading)
  const loadMore = useCallback(async (count: number = 50) => {
    try {
      const newEntries = await entryService.loadMoreEntries(count);
      setEntries(prev => [...prev, ...newEntries]);
      return newEntries;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to load more entries'));
      return [];
    }
  }, []);

  // Delete an entry
  const deleteEntry = useCallback(async (id: string) => {
    try {
      const success = await entryService.deleteEntry(id);
      if (success) {
        setEntries(prev => prev.filter(e => e.id !== id));
        setTotalCount(prev => Math.max(0, prev - 1));
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to delete entry'));
      return false;
    }
  }, []);

  // Refresh entries and trigger sync
  const refresh = useCallback(async () => {
    try {
      // Trigger sync if connected
      const isConnected = await syncOrchestrator.isConnected();
      if (isConnected) {
        try {
          await syncOrchestrator.syncNow();
        } catch (syncError) {
          // Continue with reload even if sync fails
          console.error('Error syncing on refresh:', syncError);
        }
      }
      
      // Reload entries from storage
      await entryService.init();
      const recentEntries = entryService.getRecentEntries();
      setEntries(recentEntries);
      
      const count = await entryService.getTotalCount();
      setTotalCount(count);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to refresh entries'));
    }
  }, []);

  return {
    entries,
    loading,
    error,
    totalCount,
    addEntry,
    loadMore,
    deleteEntry,
    refresh,
  };
}


