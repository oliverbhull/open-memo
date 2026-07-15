import { useState, useEffect, useCallback, useRef } from 'react';
import { FeedEntryData } from '../components/FeedEntry';
import { entryService } from '../services/EntryService';

export function useEntries() {
  const [entries, setEntries] = useState<FeedEntryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
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
        
        if (!abortController.signal.aborted && mountedRef.current) setLoading(false);
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
      throw err;
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

  return {
    entries,
    loading,
    error,
    addEntry,
    loadMore,
  };
}
