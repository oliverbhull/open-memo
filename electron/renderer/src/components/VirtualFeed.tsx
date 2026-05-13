import React, { useEffect, useRef, useState, useCallback } from 'react';
import { List, useListRef } from 'react-window';
import { FeedEntry, FeedEntryData } from './FeedEntry';

// Default height for collapsed entries (will be measured and updated)
// Breakdown:
// Container margins: 1px top + 1px bottom = 2px
// Card padding: 16px top + 16px bottom = 32px
// Card border: 1px top + 1px bottom = 2px
// Text row (.textContainer min-height): 24px
// Location row margin-top: 4px
// Location row (min-height): 16px
// Total: 2 + 32 + 2 + 24 + 4 + 16 = 80px
const DEFAULT_COLLAPSED = 80;

// Default height for expanded entry base (without text content)
// Will be measured and updated dynamically
const DEFAULT_EXPANDED_BASE = 76; // 2 + 32 + 2 + 24 + 8 + 8 = 76px

interface VirtualFeedProps {
  entries: FeedEntryData[];
  onCopy?: (text: string) => void;
  onDelete?: (id: string) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
  loading?: boolean;
}

interface RowProps {
  entry: FeedEntryData;
  onCopy?: (text: string) => void;
  onDelete?: (id: string) => void;
  isExpanded?: boolean;
  onExpandToggle?: (entryId: string) => void;
}

export const VirtualFeed: React.FC<VirtualFeedProps> = ({
  entries,
  onCopy,
  onDelete,
  onLoadMore,
  onRefresh,
  loading = false,
}) => {
  const listRef = (useListRef as any)();
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(500);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const lastLoadMoreIndex = useRef<number>(-1);
  // Initialize all entries as expanded by default
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => {
    return new Set(entries.map(e => e.id));
  });
  const scrollStartY = useRef<number>(0);
  const isRefreshing = useRef<boolean>(false);
  
  // Store measured heights for each entry
  const entryHeightsRef = useRef<Map<string, number>>(new Map());
  const rowRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  
  // Pull-to-refresh state
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const dragStartY = useRef<number>(0);
  const dragStartScrollTop = useRef<number>(0);
  const isDragging = useRef<boolean>(false);
  const PULL_THRESHOLD = 80; // Distance in pixels to trigger refresh

  // Measure actual height of an entry
  const measureEntryHeight = useCallback((entryId: string, entry: FeedEntryData, isExpanded: boolean): number => {
    const rowElement = rowRefsRef.current.get(entryId);
    if (rowElement) {
      // Measure the actual rendered height
      const height = rowElement.offsetHeight;
      if (height > 0) {
        entryHeightsRef.current.set(entryId, height);
        return height;
      }
    }
    
    // Fallback to estimation if not measured yet
    if (isExpanded) {
      // Estimate expanded height: base + text lines
      // Get container width for accurate line calculation
      const containerWidth = containerRef.current?.clientWidth || 330;
      // Account for: container padding (20px) + card margins (20px) + card padding (32px) = 72px
      const textWidth = containerWidth - 72;
      // More accurate character width estimation: font-size 17px, average char ~0.6em = ~10px
      const charsPerLine = Math.floor(textWidth / 10);
      const lines = Math.max(1, Math.ceil(entry.text.length / charsPerLine));
      const estimatedHeight = DEFAULT_EXPANDED_BASE + (lines * 24); // 24px line-height for fullText
      return estimatedHeight;
    }
    
    return DEFAULT_COLLAPSED;
  }, []);

  // Calculate height based on measured or estimated values
  const getRowHeight = useCallback((index: number): number => {
    const entry = entries[index];
    if (!entry) return DEFAULT_COLLAPSED;
    
    const isExpanded = expandedEntries.has(entry.id);
    const cachedHeight = entryHeightsRef.current.get(entry.id);
    
    if (cachedHeight && cachedHeight > 0) {
      return cachedHeight;
    }
    
    // Return estimated height if not measured yet
    return measureEntryHeight(entry.id, entry, isExpanded);
  }, [entries, expandedEntries, measureEntryHeight]);

  const handleExpandToggle = useCallback((entryId: string) => {
    const index = entries.findIndex(e => e.id === entryId);
    
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
    
    // Clear cached height so it gets remeasured
    entryHeightsRef.current.delete(entryId);
    
    // Recalculate heights after expansion change
    setTimeout(() => {
      if (listRef.current && index >= 0) {
        (listRef.current as any).resetAfterIndex?.(index, true);
      }
      // Force remeasurement after animation
      setTimeout(() => {
        const element = rowRefsRef.current.get(entryId);
        if (element) {
          const height = element.offsetHeight;
          if (height > 0) {
            entryHeightsRef.current.set(entryId, height);
            if (listRef.current) {
              (listRef.current as any).resetAfterIndex?.(index, true);
            }
          }
        }
      }, 350); // Wait for animation to complete
    }, 0);
  }, [entries, listRef]);

  const handleResize = useCallback((size: { height: number; width: number }) => {
    setListHeight(size.height);
    // Recalculate all row heights when container resizes
    if (listRef.current) {
      (listRef.current as any).resetAfterIndex?.(0, true);
    }
  }, [listRef]);

  useEffect(() => {
    if (shouldAutoScroll && listRef.current && entries.length > 0) {
      listRef.current.scrollToRow({ index: 0, align: 'start' });
    }
  }, [entries.length, shouldAutoScroll, listRef]);

  // Set up scroll listener on the container to detect scroll-to-top for refresh (fallback)
  useEffect(() => {
    if (!containerRef.current || !onRefresh) return;

    const container = containerRef.current;
    let scrollTimeout: NodeJS.Timeout;

    const handleScroll = () => {
      // Clear any existing timeout
      clearTimeout(scrollTimeout);
      
      // Check if scrolled to top (within 5px) and not dragging
      if (container.scrollTop <= 5 && !isRefreshing.current && !isDragging.current) {
        // Debounce: wait 100ms to ensure user stopped scrolling
        scrollTimeout = setTimeout(() => {
          if (container.scrollTop <= 5 && !isRefreshing.current && !isDragging.current) {
            isRefreshing.current = true;
            onRefresh().finally(() => {
              // Reset after a delay to prevent multiple triggers
              setTimeout(() => {
                isRefreshing.current = false;
              }, 1500);
            });
          }
        }, 100);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, [onRefresh]);

  // Keep all entries expanded by default, adding new entries to expanded set
  useEffect(() => {
    setExpandedEntries((prev) => {
      const entryIds = new Set(entries.map((e) => e.id));
      const newExpanded = new Set(prev);
      // Remove entries that no longer exist
      [...newExpanded].forEach(id => {
        if (!entryIds.has(id)) {
          newExpanded.delete(id);
          entryHeightsRef.current.delete(id); // Clear cached height
          rowRefsRef.current.delete(id); // Clear ref
        }
      });
      // Add all new entries to expanded set
      entries.forEach(entry => {
        if (!newExpanded.has(entry.id)) {
          newExpanded.add(entry.id);
          // Clear cached height for new entries so they get remeasured
          entryHeightsRef.current.delete(entry.id);
        }
      });
      return newExpanded;
    });
    
    // Clear all cached heights when entries change significantly
    // This ensures fresh measurements for updated content
    if (listRef.current) {
      (listRef.current as any).resetAfterIndex?.(0, true);
    }
  }, [entries, listRef]);

  // Auto-refresh when there are processing entries (poll every 5 seconds)
  useEffect(() => {
    const hasProcessing = entries.some((e) => {
      const context = e.context || {};
      const recordingState = (context.recordingState as string) || 'completed';
      return recordingState === 'processing';
    });
    
    if (!hasProcessing || !onRefresh) {
      return;
    }

    // Poll for updates every 5 seconds when processing
    const interval = setInterval(() => {
      onRefresh();
    }, 5000);

    return () => clearInterval(interval);
  }, [entries, onRefresh]);

  // Pull-to-refresh gesture handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !onRefresh) return;
    
    const container = containerRef.current;
    // Only start drag if at the top of the scroll
    if (container.scrollTop <= 10) {
      dragStartY.current = e.clientY;
      dragStartScrollTop.current = container.scrollTop;
      isDragging.current = true;
      setIsPulling(true);
    }
  }, [onRefresh]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    
    const container = containerRef.current;
    const deltaY = e.clientY - dragStartY.current;
    
    // Only allow pulling down (positive deltaY)
    if (deltaY > 0 && container.scrollTop <= 10) {
      // Prevent default scrolling
      e.preventDefault();
      
      // Calculate pull distance with resistance (ease out)
      const resistance = 0.5; // Makes it harder to pull further
      const distance = Math.min(deltaY * resistance, PULL_THRESHOLD * 1.5);
      setPullDistance(distance);
    } else if (deltaY <= 0) {
      // If dragging up, cancel pull
      isDragging.current = false;
      setIsPulling(false);
      setPullDistance(0);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    
    isDragging.current = false;
    setIsPulling(false);
    
    // Trigger refresh if pulled far enough
    if (pullDistance >= PULL_THRESHOLD && onRefresh && !isRefreshing.current) {
      isRefreshing.current = true;
      onRefresh().finally(() => {
        setTimeout(() => {
          isRefreshing.current = false;
          setPullDistance(0);
        }, 500);
      });
    } else {
      // Animate back to 0
      setPullDistance(0);
    }
  }, [pullDistance, onRefresh]);

  // Set up mouse event listeners for pull-to-refresh
  useEffect(() => {
    if (!isPulling) return;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPulling, handleMouseMove, handleMouseUp]);

  const handleRowsRendered = useCallback(
    ({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) => {
      if (startIndex > 0) setShouldAutoScroll(false);

      if (onLoadMore && !loading && entries.length > 0) {
        const threshold = entries.length - 10;
        if (stopIndex >= threshold && lastLoadMoreIndex.current < stopIndex) {
          lastLoadMoreIndex.current = stopIndex;
          onLoadMore();
        }
      }
    },
    [entries.length, onLoadMore, loading]
  );

  // Ref callback to measure row heights
  const rowRefCallback = useCallback((entryId: string, index: number) => {
    return (element: HTMLDivElement | null) => {
      if (element) {
        rowRefsRef.current.set(entryId, element);
        
        // Measure height after render
        const measure = () => {
          const height = element.offsetHeight;
          if (height > 0) {
            const currentHeight = entryHeightsRef.current.get(entryId);
            // Only update if height changed significantly
            if (!currentHeight || Math.abs(currentHeight - height) > 1) {
              entryHeightsRef.current.set(entryId, height);
              // Trigger height recalculation for this row
              if (listRef.current) {
                (listRef.current as any).resetAfterIndex?.(index, true);
              }
            }
          }
        };
        
        // Measure after render completes
        requestAnimationFrame(() => {
          setTimeout(measure, 0);
        });
      } else {
        rowRefsRef.current.delete(entryId);
      }
    };
  }, [listRef]);

  // Measure all visible rows after render
  useEffect(() => {
    const measureAllHeights = () => {
      let needsUpdate = false;
      
      rowRefsRef.current.forEach((element, entryId) => {
        if (element && element.offsetHeight > 0) {
          const height = element.offsetHeight;
          const currentHeight = entryHeightsRef.current.get(entryId);
          // Update if height changed significantly (more than 2px to avoid constant updates)
          if (!currentHeight || Math.abs(currentHeight - height) > 2) {
            entryHeightsRef.current.set(entryId, height);
            needsUpdate = true;
          }
        }
      });
      
      if (needsUpdate && listRef.current) {
        (listRef.current as any).resetAfterIndex?.(0, true);
      }
    };
    
    // Measure after entries or expanded state changes
    // Use multiple timeouts to catch different render phases
    const timeout1 = setTimeout(() => {
      requestAnimationFrame(measureAllHeights);
    }, 50);
    
    const timeout2 = setTimeout(() => {
      requestAnimationFrame(measureAllHeights);
    }, 200);
    
    return () => {
      clearTimeout(timeout1);
      clearTimeout(timeout2);
    };
  }, [entries, expandedEntries, listRef]);

  const Row = useCallback(
    (props: { index: number; style: React.CSSProperties } & RowProps): React.ReactElement => {
      const { index, style } = props;
      const entry = entries[index];
      if (!entry) return <div style={style} />;

      const isExpanded = expandedEntries.has(entry.id);
      
      // Get height - use measured if available, otherwise estimate
      const height = entryHeightsRef.current.get(entry.id) || getRowHeight(index);

      // Ensure style includes the exact height to prevent spacing issues
      const rowStyle: React.CSSProperties = {
        ...style,
        height: height,
        margin: 0, // No additional margins - spacing is in container
        padding: 0, // No additional padding
      };

      return (
        <div ref={rowRefCallback(entry.id, index)} style={rowStyle}>
          <FeedEntry
            entry={entry}
            onCopy={onCopy}
            onDelete={onDelete}
            isExpanded={isExpanded}
            onExpandToggle={() => handleExpandToggle(entry.id)}
          />
        </div>
      );
    },
    [entries, onCopy, onDelete, expandedEntries, handleExpandToggle, getRowHeight, rowRefCallback]
  );

  const getRowProps = useCallback(
    (index: number): RowProps => {
      const entry = entries[index];
      if (!entry) {
        return { entry: entries[0] || { id: '', text: '', timestamp: 0 }, onCopy, onDelete, isExpanded: false };
      }
      return {
        entry,
        onCopy,
        onDelete,
        isExpanded: expandedEntries.has(entry.id),
        onExpandToggle: () => handleExpandToggle(entry.id),
      };
    },
    [entries, onCopy, onDelete, expandedEntries, handleExpandToggle]
  );

  if (entries.length === 0) {
    return (
      <div className="feed-container" ref={containerRef}>
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

  const pullProgress = Math.min(pullDistance / PULL_THRESHOLD, 1);
  const shouldTrigger = pullDistance >= PULL_THRESHOLD;

  return (
    <div 
      className="feed-container" 
      ref={containerRef}
      onMouseDown={handleMouseDown}
      style={{ position: 'relative' }}
    >
      {/* Pull-to-refresh indicator */}
      {isPulling && pullDistance > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `${Math.min(pullDistance, PULL_THRESHOLD)}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 1000,
            transform: `translateY(${pullDistance}px)`,
            transition: isDragging.current ? 'none' : 'transform 0.3s ease-out',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
              opacity: pullProgress,
            }}
          >
            {shouldTrigger ? (
              <>
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    border: '2px solid rgba(255, 255, 255, 0.6)',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.6s linear infinite',
                  }}
                />
                <span style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.8)' }}>
                  Release to refresh
                </span>
              </>
            ) : (
              <>
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    border: '2px solid rgba(255, 255, 255, 0.4)',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    transform: `rotate(${pullProgress * 360}deg)`,
                    transition: 'transform 0.1s ease-out',
                  }}
                />
                <span style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
                  Pull to refresh
                </span>
              </>
            )}
          </div>
        </div>
      )}
      
      <List<RowProps>
        listRef={listRef}
        defaultHeight={listHeight}
        rowCount={entries.length}
        rowHeight={getRowHeight}
        rowComponent={Row}
        rowProps={getRowProps as any}
        onRowsRendered={handleRowsRendered}
        onResize={handleResize}
        style={{ 
          overflowX: 'hidden', 
          height: '100%',
          transform: isPulling ? `translateY(${Math.min(pullDistance, PULL_THRESHOLD)}px)` : 'translateY(0)',
          transition: isDragging.current ? 'none' : 'transform 0.3s ease-out',
        }}
      />
      {loading && (
        <div style={{ padding: '12px', textAlign: 'center', fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
          Loading more entries...
        </div>
      )}
      
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
