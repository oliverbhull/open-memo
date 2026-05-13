import React, { useEffect, useRef, useState } from 'react';
import { FeedEntry } from './FeedEntry';
import { FeedEntryData } from './FeedEntry';

interface FeedProps {
  entries: FeedEntryData[];
  onCopy?: (text: string) => void;
  onDelete?: (id: string) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
  loading?: boolean;
}

export const Feed: React.FC<FeedProps> = ({ entries, onCopy, onDelete, onLoadMore, onRefresh, loading = false }) => {
  const feedRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  // Clean up expanded entries when entries change (remove entries that no longer exist)
  useEffect(() => {
    setExpandedEntries((prev) => {
      const entryIds = new Set(entries.map((e) => e.id));
      const newExpanded = new Set(prev);
      // Remove entries that no longer exist
      [...newExpanded].forEach(id => {
        if (!entryIds.has(id)) {
          newExpanded.delete(id);
        }
      });
      return newExpanded;
    });
  }, [entries]);

  // Initial scroll to top on mount
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, []);

  // Auto-scroll to top when new entries arrive
  useEffect(() => {
    if (shouldAutoScroll.current && feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  const handleScroll = () => {
    if (feedRef.current) {
      // If user scrolls down, disable auto-scroll
      shouldAutoScroll.current = feedRef.current.scrollTop < 50;
      
      // Load more when near bottom
      if (onLoadMore && !loading && entries.length > 0) {
        const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
        if (scrollHeight - scrollTop - clientHeight < 100) {
          onLoadMore();
        }
      }
    }
  };

  if (entries.length === 0) {
    return (
      <div className="feed-container">
        <div className="empty-state">
          <div className="empty-state-text">
            <div>No entries yet</div>
            <div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
              Start recording to create your first memo
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      className="feed-container"
      onScroll={handleScroll}
    >
      {entries.map((entry) => (
        <FeedEntry
          key={entry.id}
          entry={entry}
          onCopy={onCopy}
          onDelete={onDelete}
          isExpanded={expandedEntries.has(entry.id)}
          onExpandToggle={() => {
            setExpandedEntries((prev) => {
              const next = new Set(prev);
              if (next.has(entry.id)) {
                next.delete(entry.id);
              } else {
                next.add(entry.id);
              }
              return next;
            });
          }}
        />
      ))}
      {loading && (
        <div style={{ padding: '12px', textAlign: 'center', fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
          Loading more entries...
        </div>
      )}
    </div>
  );
};


