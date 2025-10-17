import React, { useEffect, useLayoutEffect, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// Import utility modules
import { getVisibleTimeRange, calculateVisibleTimeRange } from './utils/TimelineCalculations';
import { drawTimeline } from './utils/TimelineDrawing';
import { centerTimelineOnTime as centerTimeOnTime, handleTimelineClick as handleClick, animateZoom as animateZoomTo } from './utils/TimelineInteractions';

// Import volume visualizer
import VolumeVisualizer from './VolumeVisualizer';

// Import optimized video streaming utilities
import { clearUnusedChunks } from '../../utils/optimizedVideoStreaming';

// Import LiquidGlass component
import LiquidGlass from '../common/LiquidGlass';

// import { showWarningToast } from '../../utils/toastUtils';

const TimelineVisualization = ({
  lyrics,
  currentTime,
  duration,
  onTimelineClick,
  zoom,
  setZoom,
  panOffset,
  setPanOffset,
  centerOnTime, // Prop to center the view on a specific time
  timeFormat = 'seconds', // Prop to control time display format
  videoSource, // Video source URL for audio analysis
  showWaveformLongVideos = false, // Whether to show waveform for videos longer than 30 minutes
  onSegmentSelect, // Callback for when a segment is selected via drag
  selectedSegment = null, // Currently selected segment { start, end }
  isProcessingSegment = false, // New prop to indicate if processing is active
  onClearRange = null, // Clear subtitles inside selected range
  onMoveRange = null, // Move subtitles inside selected range by delta (legacy, optional)
  onBeginMoveRange = null, // Start live move preview
  onPreviewMoveRange = null, // Update live move preview with delta seconds
  onCommitMoveRange = null, // Commit the live move on mouse up
  onCancelMoveRange = null, // Cancel live move preview
  onSelectedRangeChange = null // Callback to notify parent of selected range changes
}) => {
  const { t } = useTranslation();

  const durationRef = useRef(0);

  // Segment selection state
  const [isDraggingSegment, setIsDraggingSegment] = useState(false);
  const [dragStartTime, setDragStartTime] = useState(null);
  const [dragCurrentTime, setDragCurrentTime] = useState(null);
  const dragStartRef = useRef(null);
  const dragCurrentRef = useRef(null);
  const isDraggingRef = useRef(false);

  // Track if dragging has been done in this session
  const [hasDraggedInSession, setHasDraggedInSession] = useState(false);
  const [showDragHint, setShowDragHint] = useState(false);
  const dragHintAnimationRef = useRef(null);
  const [dragHintAnimationTime, setDragHintAnimationTime] = useState(0);

  // Animation state for processing
  const [animationTime, setAnimationTime] = useState(0);
  const processingAnimationRef = useRef(null);

  // Track new segments for animation (only during streaming)
  const [newSegments, setNewSegments] = useState(new Map());
  const [isStreamingActive, setIsStreamingActive] = useState(false);
  const previousLyricsRef = useRef([]);
  const newSegmentAnimationRef = useRef(null);

  // Processing animation effect moved below (after retryingOfflineKeys is declared) to avoid TDZ


  // Handle drag hint animation - show when segment selection is enabled but no dragging has been done
  useEffect(() => {
    if (onSegmentSelect && !hasDraggedInSession) {
      // Start showing the hint after a short delay
      const showTimer = setTimeout(() => {
        setShowDragHint(true);

        const startTime = performance.now();
        const animate = () => {
          const elapsed = performance.now() - startTime;
          setDragHintAnimationTime(elapsed);
          dragHintAnimationRef.current = requestAnimationFrame(animate);
        };

        dragHintAnimationRef.current = requestAnimationFrame(animate);
      }, 2000); // Show hint after 2 seconds

      return () => {
        clearTimeout(showTimer);
        if (dragHintAnimationRef.current) {
          cancelAnimationFrame(dragHintAnimationRef.current);
        }
      };
    } else {
      // Hide hint and stop animation
      setShowDragHint(false);
      if (dragHintAnimationRef.current) {
        cancelAnimationFrame(dragHintAnimationRef.current);
      }
    }
  }, [onSegmentSelect, hasDraggedInSession]);

  // Listen for streaming events and processing ranges
  useEffect(() => {
    const handleStreamingStart = () => {
      // console.log('[Timeline] Streaming started - enabling segment animations');
      setIsStreamingActive(true);
    };

    const handleProcessingRanges = (e) => {
      const ranges = (e.detail && e.detail.ranges) || [];
      setProcessingRanges(ranges);
      if (ranges.length > 1) {

      }
    };

    const handleStreamingComplete = () => {
      // console.log('[Timeline] Streaming complete - disabling segment animations');
      // Keep animations active for a bit after streaming completes
      setTimeout(() => {
        setIsStreamingActive(false);
        setNewSegments(new Map());
        setProcessingRanges([]);
      }, 1000);
    };

    // Listen for custom streaming events
    window.addEventListener('streaming-update', handleStreamingStart);
    window.addEventListener('streaming-complete', handleStreamingComplete);
    window.addEventListener('save-after-streaming', handleStreamingComplete);
    window.addEventListener('processing-ranges', handleProcessingRanges);

    return () => {
      window.removeEventListener('streaming-update', handleStreamingStart);
      window.removeEventListener('streaming-complete', handleStreamingComplete);
      window.removeEventListener('save-after-streaming', handleStreamingComplete);
      window.removeEventListener('processing-ranges', handleProcessingRanges);
    };
  }, []);

  // Track new segments only during streaming
  useEffect(() => {
    // Only track changes if streaming is active
    if (!isStreamingActive) {
      previousLyricsRef.current = [...lyrics];
      return;
    }

    const previousLyrics = previousLyricsRef.current;
    const newSegmentMap = new Map();

    // Find segments that are new (not in previous lyrics)
    lyrics.forEach(lyric => {
      const isNew = !previousLyrics.some(prev =>
        prev.start === lyric.start &&
        prev.end === lyric.end &&
        prev.text === lyric.text
      );

      if (isNew) {
        // Mark this segment as new with current timestamp
        newSegmentMap.set(`${lyric.start}-${lyric.end}`, {
          startTime: performance.now(),
          lyric: lyric
        });
      }
    });

    // Merge with existing new segments (keep animations running)
    if (newSegmentMap.size > 0) {
      setNewSegments(prevMap => {
        const mergedMap = new Map(prevMap);

        // Add new segments
        newSegmentMap.forEach((value, key) => {
          if (!mergedMap.has(key)) {
            mergedMap.set(key, value);
          }
        });

        // Remove segments that have finished animating (after 800ms)
        const now = performance.now();
        mergedMap.forEach((value, key) => {
          if (now - value.startTime > 800) {
            mergedMap.delete(key);
          }
        });

        return mergedMap;
      });
    }

    // Update previous lyrics reference
    previousLyricsRef.current = [...lyrics];
  }, [lyrics, isStreamingActive]);

  // Calculate minimum zoom level - now always return 1 to allow 100% zoom
  const calculateMinZoom = (duration) => {
    return 1; // Always allow 100% zoom (showing entire timeline)
  };

  // Get current video duration from the video element
  useEffect(() => {
    const videoElement = document.querySelector('video');
    if (videoElement) {
      const updateDuration = () => {
        if (videoElement.duration && !isNaN(videoElement.duration)) {
          durationRef.current = videoElement.duration;

          // No longer enforce minimum zoom level
          // Allow users to zoom out to 100% for any video duration
        }
      };

      // Update duration when metadata is loaded
      videoElement.addEventListener('loadedmetadata', updateDuration);

      // Check if duration is already available
      if (videoElement.duration && !isNaN(videoElement.duration)) {
        updateDuration();
      }

      return () => {
        videoElement.removeEventListener('loadedmetadata', updateDuration);
      };
    }
  }, [zoom, setZoom]);

  // Update durationRef when video metadata is loaded
  useEffect(() => {
    const videoElement = document.querySelector('video');
    if (videoElement && videoElement.duration && !isNaN(videoElement.duration)) {
      durationRef.current = videoElement.duration;
    }
  }, []);



  const timelineRef = useRef(null);
  const lastTimeRef = useRef(0);
  const animationFrameRef = useRef(null);
  // Initialize currentZoomRef with the correct zoom level
  const currentZoomRef = useRef(zoom);

  // Update currentZoomRef immediately when zoom prop changes
  useEffect(() => {
    // Use zoom directly without minimum restriction
    currentZoomRef.current = zoom;
  }, [zoom, duration]);
  const autoScrollRef = useRef(null);
  const isScrollingRef = useRef(false);
  const canvasWidthRef = useRef(0);

  // Track the last time the user manually interacted with the timeline
  const lastManualPanTime = useRef(0);

  // Flag to completely disable auto-scrolling
  const disableAutoScroll = useRef(false);

  // Debug counter to track state updates
  const debugCounter = useRef(0);
  // Refs to manage smooth zoom-drag with strict playhead-centering
  const zoomDragRafRef = useRef(null);
  const zoomDragActiveRef = useRef(false);
  const zoomDragLastXRef = useRef(0);

  // Track the last computed pan during zoom drag so we can commit it on release
  const lastComputedPanRef = useRef(panOffset);




  // No longer need to enforce minimum zoom
  // Users can zoom out to see the entire timeline

  // Calculate visible time range - simplified without zoom centering logic
  const getTimeRange = useCallback(() => {
    const { start, end, total: timelineEnd, effectiveZoom } = getVisibleTimeRange(lyrics, duration, panOffset, zoom, currentZoomRef.current);

    // Update currentZoomRef to match effective zoom
    currentZoomRef.current = effectiveZoom;

    return { start, end, total: timelineEnd };
  }, [lyrics, duration, panOffset, zoom]);

  // Store the playhead position before zooming
  // This effect is no longer needed since we removed the playhead animation
  useEffect(() => {
    // No-op - we've removed the playhead animation
  }, []);

  // Function to center the timeline view on a specific time
  const centerTimelineOnTime = useCallback((time) => {
    centerTimeOnTime(
      time,
      lyrics,
      duration,
      currentZoomRef.current,
      setPanOffset,
      lastManualPanTime
    );
  }, [lyrics, duration, setPanOffset]);

  // Watch for centerOnTime prop changes
  useEffect(() => {
    if (centerOnTime !== undefined && centerOnTime !== null) {

      centerTimelineOnTime(centerOnTime);
    }
  }, [centerOnTime, centerTimelineOnTime]);

  // Helper function to calculate visible time range with a temporary pan offset
  // This avoids creating a dependency on the state panOffset during active panning
  const getVisibleRangeWithTempOffset = useCallback((tempPanOffset) => {
    return calculateVisibleTimeRange(lyrics, duration, tempPanOffset, currentZoomRef.current);
  }, [lyrics, duration]);

  const [processingRanges, setProcessingRanges] = useState([]);

  // Store the last selected range to show action bar when it includes existing subtitles
  const [actionBarRange, setActionBarRange] = useState(null); // { start, end }
  const [moveDragOffsetPx, setMoveDragOffsetPx] = useState(0);
  const rangePreviewDeltaRef = useRef(0); // seconds delta during move drag
  const [hiddenActionBarRange, setHiddenActionBarRange] = useState(null); // Store range when action bar is hidden

  const isRangeMoveDraggingRef = useRef(false);
  const moveDragOffsetPxRef = useRef(0);

  // Offline segments lingering after processing (for quick retry from cached cuts)
  const [offlineSegments, setOfflineSegments] = useState([]); // [{ start, end, url, name }]
  const [hoveredOfflineRange, setHoveredOfflineRange] = useState(null);
  // Track which offline ranges are currently retrying (keys: "start-end")
  const [retryingOfflineKeys, setRetryingOfflineKeys] = useState([]);

  // Subtle, non-intrusive inline notices (no toast)
  const [clearInfoVisible, setClearInfoVisible] = useState(false);
  const [warnOfflineDragVisible, setWarnOfflineDragVisible] = useState(false);


  // Handle processing animation (streaming or retry) — placed after retryingOfflineKeys to avoid TDZ
  useEffect(() => {
    const anyProcessing = isProcessingSegment || (retryingOfflineKeys && retryingOfflineKeys.length > 0) || isStreamingActive;
    if (anyProcessing) {
      const startTime = performance.now();
      const animate = () => {
        const elapsed = performance.now() - startTime;
        setAnimationTime(elapsed);
        processingAnimationRef.current = requestAnimationFrame(animate);
      };
      processingAnimationRef.current = requestAnimationFrame(animate);
      return () => {
        if (processingAnimationRef.current) {
          cancelAnimationFrame(processingAnimationRef.current);
        }
      };
    } else {
      // Reset animation when processing stops
      setAnimationTime(0);
      if (processingAnimationRef.current) {
        cancelAnimationFrame(processingAnimationRef.current);
      }
    }
  }, [isProcessingSegment, retryingOfflineKeys, isStreamingActive]);

  // Load offline segments for current video; on a fresh session, do not restore stale state
  useEffect(() => {
    const SESSION_FLAG = 'session_offline_loaded_v1';
    const isFreshSession = !sessionStorage.getItem(SESSION_FLAG);

    const loadOrResetOffline = () => {
      try {
        const videoKey = localStorage.getItem('current_file_cache_id')
          || localStorage.getItem('current_file_url')
          || localStorage.getItem('current_video_url');

        // On a brand-new session, clear cached offline segments for current video to avoid stuck UI
        if (isFreshSession && videoKey) {
          try {
            const raw0 = localStorage.getItem('offline_segments_cache');
            const cache0 = raw0 ? JSON.parse(raw0) : {};
            if (cache0[videoKey]) {
              delete cache0[videoKey];
              localStorage.setItem('offline_segments_cache', JSON.stringify(cache0));
            }
          } catch {}
          setOfflineSegments([]);
          sessionStorage.setItem(SESSION_FLAG, '1');
          return; // don't load any list on first session restore
        }

        // Normal path: load existing offline segments for this video (if any)
        const raw = localStorage.getItem('offline_segments_cache');
        const cache = raw ? JSON.parse(raw) : {};
        const list = (videoKey && Array.isArray(cache[videoKey])) ? cache[videoKey] : [];
        setOfflineSegments(list);
      } catch {}
    };

    loadOrResetOffline();

    // Update when a new offline segment is cached
    const onCached = (e) => {
      const { start, end, url, name } = (e && e.detail) || {};
      if (typeof start !== 'number' || typeof end !== 'number' || !url) return;
      setOfflineSegments(prev => {
        const exists = prev.some(r => Math.abs(r.start - start) < 1e-6 && Math.abs(r.end - end) < 1e-6);
        if (exists) return prev;
        return [...prev, { start, end, url, name }];
      });
    };
    window.addEventListener('offline-segment-cached', onCached);

    return () => window.removeEventListener('offline-segment-cached', onCached);
  }, []);

  // Clear all offline segments: remove cache and delete files on server (fire-and-forget)
  const handleClearOfflineSegments = useCallback(() => {
    try {
      const urls = (offlineSegments || []).map(r => r.url).filter(Boolean);
      if (urls.length > 0) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1500); // don't let UI wait on Windows file locks
          // Fire and forget - do not await
          fetch('http://localhost:3031/api/delete-videos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls }),
            signal: controller.signal
          })
            .catch((e) => {
              console.warn('[Timeline] Failed to call delete-videos (non-blocking):', e);
            })
            .finally(() => clearTimeout(timeoutId));
        } catch (e) {
          console.warn('[Timeline] Failed to initiate delete-videos (non-blocking):', e);
        }
      }

      // Clear local cache for current video immediately so UI never gets stuck
      try {
        const videoKey = localStorage.getItem('current_file_cache_id')
          || localStorage.getItem('current_file_url')
          || localStorage.getItem('current_video_url');
        if (videoKey) {
          const raw = localStorage.getItem('offline_segments_cache');
          const cache = raw ? JSON.parse(raw) : {};
          if (cache[videoKey]) {
            delete cache[videoKey];
            localStorage.setItem('offline_segments_cache', JSON.stringify(cache));
          }
        }
      } catch {}

      // Update UI state regardless of backend outcome
      setOfflineSegments([]);
      setHoveredOfflineRange(null);
      try { window.dispatchEvent(new CustomEvent('offline-segments-cleared')); } catch {}

      // Show a subtle inline confirmation instead of a toast
      setClearInfoVisible(true);
      try { setTimeout(() => setClearInfoVisible(false), 4000); } catch {}
    } catch (e) {
      console.error('[Timeline] Error clearing offline segments (UI proceeded):', e);
      // Even on unexpected errors, keep UI consistent
      setOfflineSegments([]);
      setHoveredOfflineRange(null);
    }
  }, [offlineSegments, t]);

  // Retry an offline range: open processing modal with locked settings
  const handleRetryOfflineRange = useCallback((range) => {
    if (!range) return;
    try {
      // Mark open reason as retry so the modal locks specific controls
      sessionStorage.setItem('processing_modal_open_reason', 'retry-offline');
      if (range.url) {
        sessionStorage.setItem('processing_modal_cached_url', range.url);
      }

      // Mark this specific offline range as "retrying" so the timeline animates only this segment
      const key = `${range.start}-${range.end}`;
      setRetryingOfflineKeys(prev => (prev && prev.includes(key)) ? prev : [...(prev || []), key]);

      // Open the processing options modal for this range
      if (onSegmentSelect) {
        onSegmentSelect({ start: range.start, end: range.end });
      } else if (range.url) {
        // Fallback to original behavior if modal cannot be opened
        window.dispatchEvent(new CustomEvent('retry-segment-from-cache', {
          detail: { start: range.start, end: range.end, url: range.url }
        }));
      }
    } catch (e) {
      console.error('[Timeline] Failed to initiate retry from cache:', e);
    }
  }, [onSegmentSelect]);

  // Clear loading state when retry completes (success or failure)
  useEffect(() => {
    const onStreamingComplete = (e) => {
      const seg = e && e.detail && e.detail.segment;
      if (seg && typeof seg.start === 'number' && typeof seg.end === 'number') {
        const key = `${seg.start}-${seg.end}`;
        setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
      }
    };
    const onRetryComplete = (e) => {
      const d = e && e.detail;
      if (d && typeof d.start === 'number' && typeof d.end === 'number') {
        const key = `${d.start}-${d.end}`;
        setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
      }
    };
    window.addEventListener('streaming-complete', onStreamingComplete);
    window.addEventListener('retry-segment-from-cache-complete', onRetryComplete);
    return () => {
      window.removeEventListener('streaming-complete', onStreamingComplete);
      window.removeEventListener('retry-segment-from-cache-complete', onRetryComplete);
    };
  }, []);
  // Clear any segment-specific retry animations if user force-stops all requests
  useEffect(() => {
    const onAborted = () => {
      setRetryingOfflineKeys([]);
    };
    window.addEventListener('gemini-requests-aborted', onAborted);
    return () => window.removeEventListener('gemini-requests-aborted', onAborted);
  }, []);


  // Stop retry animation if the processing modal is closed without confirming (cancelled)
  useEffect(() => {
    const onRetryModalClosed = (e) => {
      const d = e && e.detail;
      if (d && typeof d.start === 'number' && typeof d.end === 'number' && (d.confirmed === false)) {
        const key = `${d.start}-${d.end}`;
        setRetryingOfflineKeys(prev => prev.filter(k => k !== key));
      }
    };
    window.addEventListener('retry-offline-modal-closed', onRetryModalClosed);
    return () => {
      window.removeEventListener('retry-offline-modal-closed', onRetryModalClosed);
    };
  }, []);


  const isClickingInsideRef = useRef(false); // Track if we're clicking inside the range

  // Notify parent component when selected range changes
  useEffect(() => {
    if (onSelectedRangeChange) {
      // Report the active range (either actionBarRange or hiddenActionBarRange)
      const activeRange = actionBarRange || hiddenActionBarRange || selectedSegment;
      onSelectedRangeChange(activeRange);
    }
  }, [actionBarRange, hiddenActionBarRange, selectedSegment, onSelectedRangeChange]);

  // Draw the timeline visualization with optimizations
  const renderTimeline = useCallback((tempPanOffset = null) => {
    const canvas = timelineRef.current;
    if (!canvas) return;

    // Use a default duration if none is provided (for debugging)
    const effectiveDuration = duration || 60; // Default to 60 seconds for testing

    canvasWidthRef.current = canvas.clientWidth;

    // Use the provided temporary pan offset during active panning, or the state value
    const effectivePanOffset = tempPanOffset !== null ? tempPanOffset : panOffset;

    // Get visible time range with the effective pan offset
    const visibleTimeRange = tempPanOffset !== null
      ? getVisibleRangeWithTempOffset(effectivePanOffset)
      : getTimeRange();

    // Prepare segment data for drawing
    // Show selection for both actionBarRange and hiddenActionBarRange
    const activeRange = actionBarRange || hiddenActionBarRange;
    const effectiveSelected = activeRange
      ? { start: activeRange.start + (rangePreviewDeltaRef.current || 0), end: activeRange.end + (rangePreviewDeltaRef.current || 0) }
      : selectedSegment;
    // Reuse streaming parallel highlighting style by feeding offline segments
    // Build retry key set
    const retryKeySet = new Set(retryingOfflineKeys || []);
    const { start: visStart, end: visEnd } = visibleTimeRange;

    // Only consider offline ranges that are visible to reduce draw cost
    const offlineVisible = (offlineSegments || []).filter(r => (r.end > visStart && r.start < visEnd));

    // Determine if any animation should run (global clock)
    const isAnimating = !!isProcessingSegment || retryKeySet.size > 0;

    // Include only the retried offline ranges during animation; otherwise include all visible offline ranges as static
    const offlineRangesForDraw = offlineVisible.map((r, idx) => {
      const key = `${r.start}-${r.end}`;
      const animate = retryKeySet.has(key);
      if (isAnimating && !animate) return null; // skip static ranges during animation frames to avoid lag
      return { start: r.start, end: r.end, index: (processingRanges?.length || 0) + idx, animate };
    }).filter(Boolean);

    // If a retry is active, show only the retried offline cut(s) as processing; otherwise use normal processingRanges
    const combinedProcessingRanges = (retryKeySet.size > 0)
      ? offlineRangesForDraw
      : (Array.isArray(processingRanges) ? [...processingRanges, ...offlineRangesForDraw] : offlineRangesForDraw);

    // Selected band animates only if: (a) a normal processing run is on, or (b) it exactly matches the retried range
    const selectedIsProcessing = (retryKeySet.size > 0)
      ? (effectiveSelected && retryKeySet.has(`${effectiveSelected.start}-${effectiveSelected.end}`))
      : !!isProcessingSegment;

    const segmentData = {
      selectedSegment: effectiveSelected,
      isDraggingSegment,
      dragStartTime,
      dragCurrentTime,
      isProcessing: isAnimating, // used by processingRanges; selected animation gated separately
      selectedIsProcessing,
      animationTime,
      newSegments: newSegments, // Pass new segments for animation
      processingRanges: combinedProcessingRanges
    };

    // Draw the timeline
    drawTimeline(
      canvas,
      effectiveDuration,
      lyrics,
      currentTime,
      {
        ...visibleTimeRange,
        // Keep a slight top padding (time markers), do not cover segments
        topPadding: 25

      },
      effectivePanOffset,
      tempPanOffset !== null, // isActivePanning
      timeFormat,
      segmentData
    );


  }, [lyrics, currentTime, duration, getTimeRange, panOffset, getVisibleRangeWithTempOffset, timeFormat, selectedSegment, isDraggingSegment, dragStartTime, dragCurrentTime, isProcessingSegment, animationTime, newSegments, actionBarRange, hiddenActionBarRange, offlineSegments, hoveredOfflineRange, retryingOfflineKeys]);

  // Animate new segments - must be after renderTimeline definition
  useEffect(() => {
    if (newSegments.size > 0) {
      const animate = () => {
        const now = performance.now();
        let hasActiveAnimations = false;

        // Check if any animations are still active (800ms duration)
        newSegments.forEach((value) => {
          if (now - value.startTime < 800) {
            hasActiveAnimations = true;
          }
        });

        if (hasActiveAnimations) {
          // Trigger re-render to update animations
          renderTimeline();
          newSegmentAnimationRef.current = requestAnimationFrame(animate);
        } else {
          // Clean up finished animations
          setNewSegments(prevMap => {
            const cleanedMap = new Map();
            const now = performance.now();
            prevMap.forEach((value, key) => {
              if (now - value.startTime < 800) {
                cleanedMap.set(key, value);
              }
            });
            return cleanedMap;
          });
        }
      };

      newSegmentAnimationRef.current = requestAnimationFrame(animate);

      return () => {
        if (newSegmentAnimationRef.current) {
          cancelAnimationFrame(newSegmentAnimationRef.current);
        }
      };
    }
  }, [newSegments, renderTimeline]);

  // Listen for immediate waveform setting changes - must be after renderTimeline definition
  useEffect(() => {
    const handleWaveformLongVideosChange = () => {
      // Force re-render when the setting changes
      if (timelineRef.current) {
        renderTimeline();
      }
    };

    window.addEventListener('waveformLongVideosChanged', handleWaveformLongVideosChange);
    return () => {
      window.removeEventListener('waveformLongVideosChanged', handleWaveformLongVideosChange);
    };
  }, [renderTimeline]);

  // Simple zoom update for programmatic changes (non-user initiated)
  useEffect(() => {
    if (zoom !== currentZoomRef.current) {
      // Just update zoom without centering for programmatic changes
      // User-initiated zoom centering is handled directly in the mouse move handler
      currentZoomRef.current = zoom;
      renderTimeline();
    }
  }, [zoom, renderTimeline]);





  // Clean up animation frame on unmount
  useEffect(() => {
    // Store the ref value in a variable that won't change
    const animationFrameRef2 = animationFrameRef;
    const dragHintAnimationRef2 = dragHintAnimationRef;

    return () => {
      const animationFrame = animationFrameRef2.current;
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }

      const dragHintAnimation = dragHintAnimationRef2.current;
      if (dragHintAnimation) {
        cancelAnimationFrame(dragHintAnimation);

      }
    };
  }, []);

  // Initialize and handle canvas resize
  useEffect(() => {
    if (timelineRef.current) {
      const canvas = timelineRef.current;
      const container = canvas.parentElement;

      const resizeCanvas = () => {
        if (!container) return;

        // Use requestAnimationFrame to ensure layout is complete
        requestAnimationFrame(() => {
          const rect = container.getBoundingClientRect();

          // Set CSS style dimensions to match container
          canvas.style.width = `${rect.width}px`;
          canvas.style.height = '50px';

          // The actual canvas dimensions will be set by TimelineDrawing.js
          // based on clientWidth/clientHeight and DPR
          renderTimeline();
        });
      };

      // Use ResizeObserver for more accurate container size changes
      const resizeObserver = new ResizeObserver(() => {
        resizeCanvas();
      });

      // Observe the container for size changes
      resizeObserver.observe(container);

      // Also listen to window resize as fallback
      window.addEventListener('resize', resizeCanvas);

      // Initial resize
      resizeCanvas();

      return () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', resizeCanvas);
      };
    }
  }, [renderTimeline]);


	  // Helper: ignore shortcuts when typing in inputs/textareas/contenteditable editors
	  const isEventFromEditable = (e) => {
	    const el = (e && e.target) || document.activeElement;
	    if (!el || typeof el.closest !== 'function') return false;
	    // Match native inputs and common rich editors
	    return !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .cm-content, .CodeMirror');
	  };

  // Add keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (isEventFromEditable(e)) return;
      // Alt+S to toggle auto-scrolling
      if (e.altKey && e.key === 's') {
        disableAutoScroll.current = !disableAutoScroll.current;


        // Show a temporary message on the canvas
        const canvas = timelineRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const message = `Auto-scrolling ${disableAutoScroll.current ? 'disabled' : 'enabled'}`;

          // Save current state
          ctx.save();

          // Draw message
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.fillRect(10, 10, 200, 30);
          ctx.fillStyle = '#ffffff';
          ctx.font = '14px Arial';
          ctx.fillText(message, 20, 30);

          // Restore state after a delay
          setTimeout(() => {
            ctx.restore();
            renderTimeline();
          }, 1500);
        }
      }

      // Ctrl+A to select entire video range
      if (e.ctrlKey && e.key === 'a' && onSegmentSelect && duration) {
        e.preventDefault(); // Prevent default browser select all



        // Set drag state to simulate range selection from 0 to duration
        const startTime = 0;
        const endTime = duration;

        // Mark that dragging has been done in this session
        setHasDraggedInSession(true);

        // Set drag state to show visual selection
        setIsDraggingSegment(true);
        setDragStartTime(startTime);
        setDragCurrentTime(endTime);
        dragStartRef.current = startTime;
        dragCurrentRef.current = endTime;
        isDraggingRef.current = true;

        // Force re-render to show selection
        renderTimeline();



        // Show selection for 500ms, then open modal
        setTimeout(() => {
          // Clean up drag state
          setIsDraggingSegment(false);
          setDragStartTime(null);
          setDragCurrentTime(null);
          dragStartRef.current = null;
          dragCurrentRef.current = null;
          isDraggingRef.current = false;

          // Helper function to check if there are subtitles in the range
          const checkForSubtitles = (start, end) => {
            if (!lyrics || lyrics.length === 0) return false;
            // Only consider subtitles fully contained within the range
            return lyrics.some(l => l.start >= start && l.end <= end);
          };

          // Check if there are subtitles in the range
          if (offlineSegments.length > 0) {
            // When offline cuts exist, do not trigger the range action bar or open the modal
          } else if (checkForSubtitles(startTime, endTime)) {
            // Show action bar instead of opening modal
            setActionBarRange({ start: startTime, end: endTime });
            setHiddenActionBarRange({ start: startTime, end: endTime });
          } else {
            // Open video processing modal for entire range
            sessionStorage.setItem('processing_modal_open_reason', 'drag-selection');
            onSegmentSelect({ start: startTime, end: endTime });
          }
        }, 500); // 0.5 second delay to show blue highlight
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [renderTimeline, onSegmentSelect, duration, lyrics]);


  // Body-level retry overlay layer (imperative, immune to canvas animation re-renders)
  const retryOverlayContainerRef = useRef(null);
  const retryOverlayWrapperRef = useRef(null);
  const retryOverlayButtonRef = useRef(null);
  const currentHoverRef = useRef(null);
  const retryingKeysRef = useRef([]);
  const retryHandlerRef = useRef(null);

  useEffect(() => { retryingKeysRef.current = retryingOfflineKeys || []; }, [retryingOfflineKeys]);
  useEffect(() => { retryHandlerRef.current = handleRetryOfflineRange; }, [handleRetryOfflineRange]);

  // Create the overlay layer once
  useEffect(() => {
    if (retryOverlayContainerRef.current) return;
    const container = document.createElement('div');
    Object.assign(container.style, { position: 'fixed', inset: '0px', pointerEvents: 'none', zIndex: '9000' });

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, { position: 'absolute', top: '0px', left: '0px', visibility: 'hidden', pointerEvents: 'none' });

    const btn = document.createElement('button');
    btn.className = 'btn-base btn-primary btn-small';
    btn.title = t('timeline.retryFromCache', 'Retry this cut (reuse cached clip)');
    Object.assign(btn.style, { width: '30px', height: '30px', minWidth: '30px', padding: '0px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hover = currentHoverRef.current; if (!hover) return;
      const key = `${hover.start}-${hover.end}`;
      if (retryingKeysRef.current.includes(key)) return;
      if (retryHandlerRef.current) retryHandlerRef.current(hover);
    });
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size: 16px; color: var(--md-on-primary);">refresh</span>';

    wrapper.appendChild(btn);
    container.appendChild(wrapper);
    document.body.appendChild(container);

    retryOverlayContainerRef.current = container;
    retryOverlayWrapperRef.current = wrapper;
    retryOverlayButtonRef.current = btn;

    return () => {
      try { btn.remove(); wrapper.remove(); container.remove(); } catch {}
      retryOverlayContainerRef.current = null;
      retryOverlayWrapperRef.current = null;
      retryOverlayButtonRef.current = null;
    };
  }, [t]);

  // Update overlay position/visibility when hover or view changes (ignore animation ticks)
  useEffect(() => {
    currentHoverRef.current = hoveredOfflineRange;
    const wrapper = retryOverlayWrapperRef.current;
    const btn = retryOverlayButtonRef.current;
    const canvas = timelineRef.current;
    if (!wrapper || !btn || !canvas) return;

    const hover = hoveredOfflineRange;
    if (!hover) {
      wrapper.style.visibility = 'hidden';
      wrapper.style.pointerEvents = 'none';
      return;
    }

    const key = `${hover.start}-${hover.end}`;
    if ((retryingOfflineKeys || []).includes(key)) {
      wrapper.style.visibility = 'hidden';
      wrapper.style.pointerEvents = 'none';
      return;
    }

    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 0;
    const bounds = canvas.getBoundingClientRect();
    const { start: visStart, end: visEnd } = getTimeRange();
    const toPx = (t) => ((t - visStart) / Math.max(0.0001, (visEnd - visStart))) * width;
    const mid = (hover.start + hover.end) / 2;
    const timeMarkerSpace = 25;
    const availableHeight = Math.max(0, height - timeMarkerSpace);
    const centerY = timeMarkerSpace + (availableHeight / 2);
    const xPx = Math.max(0, Math.min(width, toPx(mid)));

    wrapper.style.left = `${bounds.left + xPx - 18}px`;
    wrapper.style.top = `${bounds.top + centerY - 18}px`;
    wrapper.style.visibility = 'visible';
    wrapper.style.pointerEvents = 'none';
    btn.style.pointerEvents = 'auto';
  }, [hoveredOfflineRange, panOffset, zoom, lyrics, getTimeRange, retryingOfflineKeys]);
  // Auto-hide retry overlay on any page/ancestor scroll or window resize
  useEffect(() => {
    const hideOverlay = () => {
      const wrapper = retryOverlayWrapperRef.current;
      if (wrapper) {
        wrapper.style.visibility = 'hidden';
        wrapper.style.pointerEvents = 'none';
      }
    };
    window.addEventListener('scroll', hideOverlay, true);
    window.addEventListener('resize', hideOverlay);
    return () => {
      window.removeEventListener('scroll', hideOverlay, true);
      window.removeEventListener('resize', hideOverlay);
    };
  }, []);


  // Handle timeline updates
  useEffect(() => {
    if (timelineRef.current && (lyrics.length > 0 || onSegmentSelect)) {
      lastTimeRef.current = currentTime;
      renderTimeline();

      // For long videos, optimize memory usage by clearing unused chunks
      if (duration > 1800 && videoSource) { // 30 minutes
        // Clear unused video chunks to free up memory
        clearUnusedChunks(videoSource, currentTime, duration);
      }
    }
  }, [lyrics, currentTime, duration, zoom, panOffset, renderTimeline, videoSource, onSegmentSelect]);

  // Initial render when component mounts or when segment selection is enabled
  useEffect(() => {
    if (timelineRef.current && onSegmentSelect) {
      renderTimeline();
    }
  }, [onSegmentSelect, renderTimeline]);

  // Re-render when drag state changes to show visual feedback
  useEffect(() => {
    if (timelineRef.current && (isDraggingSegment || dragStartTime !== null || dragCurrentTime !== null)) {
      renderTimeline();
    }
  }, [isDraggingSegment, dragStartTime, dragCurrentTime, renderTimeline]);



  // Ensure playhead stays visible by auto-scrolling, but only when absolutely necessary
  useEffect(() => {
    // COMPLETELY DISABLE auto-scroll if:
    // 1. No duration set yet
    // 2. Recently manually interacted with (within last 5 seconds)
    // 3. User has explicitly disabled it
    if (!duration ||
        (performance.now() - lastManualPanTime.current < 5000) ||
        disableAutoScroll.current) {
      return;
    }

    // Only auto-scroll when the playhead is COMPLETELY outside the visible area
    const { start: visibleStart, end: visibleEnd, total: timelineEnd } = getTimeRange();
    if (!isScrollingRef.current &&
        (currentTime < visibleStart || currentTime > visibleEnd) &&
        Math.abs(currentTime - visibleStart) > 5 && // Must be significantly outside
        Math.abs(currentTime - visibleEnd) > 5) {   // Must be significantly outside

      isScrollingRef.current = true;
      debugCounter.current++;


      // Use current zoom directly without minimum restriction
      const effectiveZoom = currentZoomRef.current;

      // Calculate visible duration based on zoom
      const totalVisibleDuration = timelineEnd / effectiveZoom;
      const halfVisibleDuration = totalVisibleDuration / 2;

      // Center the view on the current time
      const targetOffset = Math.max(0, Math.min(currentTime - halfVisibleDuration, timelineEnd - totalVisibleDuration));

      // Don't scroll if we're already close to the target
      if (Math.abs(targetOffset - panOffset) < 1) {
        isScrollingRef.current = false;
        return;
      }

      // Cancel any existing animation
      if (autoScrollRef.current) {
        cancelAnimationFrame(autoScrollRef.current);
      }

      // Set the pan offset directly without animation to avoid shaking
  // Clear all offline segments: remove cache and delete files on server

      // This creates a clean jump to the new position without any transition








      setPanOffset(targetOffset);

      // Release the scrolling lock immediately
      setTimeout(() => {
        isScrollingRef.current = false;

      }, 50);
    }

    // Store the ref value in a variable that won't change
    const autoScrollRef2 = autoScrollRef;

    return () => {
      const autoScroll = autoScrollRef2.current;
      if (autoScroll) {
        cancelAnimationFrame(autoScroll);
      }
    };
  }, [currentTime, duration, getTimeRange, panOffset, setPanOffset]);
  // Convert pixel position to time
  const pixelToTime = (pixelX) => {
    const canvas = timelineRef.current;
    const effectiveDuration = duration || 60;
    if (!canvas) return 0;

    const rect = canvas.getBoundingClientRect();
    const relativeX = pixelX - rect.left;
    const timeRange = getTimeRange();
    const timePerPixel = (timeRange.end - timeRange.start) / canvas.clientWidth;

    return Math.max(0, Math.min(effectiveDuration, timeRange.start + (relativeX * timePerPixel)));
  };

  // Handle right-click on selected segment
  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if we have a selected segment and the click is within its bounds
    if (selectedSegment && onSegmentSelect) {
      const clickTime = pixelToTime(e.clientX);

      // Check if the click is within the selected segment range
      if (clickTime >= selectedSegment.start && clickTime <= selectedSegment.end) {

        sessionStorage.setItem('processing_modal_open_reason', 'context-menu');
        // Trigger the segment selection callback to open the modal
        onSegmentSelect(selectedSegment);
      }
    }
  };

  // Enable Delete/Backspace keys to trigger clear-in-range when action bar is visible
  useEffect(() => {
    if (!actionBarRange) return;
    const onKeyDown = (e) => {
      if (isEventFromEditable(e)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (onClearRange) {
          onClearRange(actionBarRange.start, actionBarRange.end);
          setActionBarRange(null);
          setHiddenActionBarRange(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionBarRange, onClearRange]);

  const hasSubtitlesInRange = useCallback((start, end) => {
    if (!lyrics || lyrics.length === 0) return false;
    // Only consider subtitles fully contained within the range
    return lyrics.some(l => l.start >= start && l.end <= end);
  }, [lyrics]);

  // Handle mouse move to detect hovering over the hidden range or selectedSegment
  const handleMouseMoveForRange = useCallback((e) => {
    // During a move-drag of the action bar, ignore canvas hover logic entirely
    if (isRangeMoveDraggingRef.current) return;
    // Check both hiddenActionBarRange and selectedSegment
    if (!hiddenActionBarRange && !actionBarRange && !selectedSegment && (!offlineSegments || offlineSegments.length === 0)) return;

    const canvas = timelineRef.current;
    const effectiveDuration = duration || 60;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const timeRange = getTimeRange();
    const timePerPixel = (timeRange.end - timeRange.start) / canvas.clientWidth;
    const hoverTime = Math.max(0, Math.min(effectiveDuration, timeRange.start + (relativeX * timePerPixel)));

    // Track hovered offline cached range (for refresh UI)
    if (offlineSegments && offlineSegments.length > 0) {
      const hovered = offlineSegments.find(r => hoverTime >= r.start && hoverTime <= r.end);
      setHoveredOfflineRange(hovered || null);
    } else {
      if (hoveredOfflineRange) setHoveredOfflineRange(null);
    }

    // Check if hovering within the hidden action bar range
    const range = hiddenActionBarRange || actionBarRange;
    if (range && hoverTime >= range.start && hoverTime <= range.end) {
      // Show the action bar if it was hidden (only when no offline cuts exist)
      if (hiddenActionBarRange && !actionBarRange && offlineSegments.length === 0) {
        setActionBarRange(hiddenActionBarRange);
      }
    }

    // Check if hovering within the persistent selectedSegment (from subtitle generation)
    if (selectedSegment && !actionBarRange &&
        hoverTime >= selectedSegment.start && hoverTime <= selectedSegment.end) {
      // Check if there are subtitles in this segment
      if (hasSubtitlesInRange(selectedSegment.start, selectedSegment.end) && offlineSegments.length === 0) {
        // Show action bar for the selected segment
        setActionBarRange(selectedSegment);
        setHiddenActionBarRange(selectedSegment);
      }
    }
  }, [hiddenActionBarRange, actionBarRange, selectedSegment, duration, getTimeRange, hasSubtitlesInRange]);

  // Add mouse move listener for hover detection
  useEffect(() => {
    if (hiddenActionBarRange || actionBarRange || selectedSegment || (offlineSegments && offlineSegments.length > 0)) {
      const canvas = timelineRef.current;
      if (canvas) {
        canvas.addEventListener('mousemove', handleMouseMoveForRange);
        return () => {
          canvas.removeEventListener('mousemove', handleMouseMoveForRange);
        };
      }
    }
  }, [handleMouseMoveForRange, hiddenActionBarRange, actionBarRange, selectedSegment]);

  // When selectedSegment changes (e.g., after subtitle generation), prepare for action bar
  useEffect(() => {
    if (selectedSegment && !actionBarRange && !hiddenActionBarRange) {
      // Check if the selected segment has subtitles
      if (hasSubtitlesInRange(selectedSegment.start, selectedSegment.end)) {
        // Pre-set hiddenActionBarRange so hovering will immediately show the action bar
        setHiddenActionBarRange(selectedSegment);
      }
    }
  }, [selectedSegment, actionBarRange, hiddenActionBarRange, hasSubtitlesInRange]);



  // Common logic for handling pointer down (mouse or touch)
  const handlePointerDown = (clientX, _clientY, isTouch = false) => {
    const startTime = pixelToTime(clientX);
    const startX = clientX;
    let hasMoved = false;
    let dragThreshold = isTouch ? 10 : 5; // pixels - higher threshold for touch to avoid accidental drags

    let warned = false;



    // Initialize drag state for segment selection (if enabled) - disabled when offline segments linger
    if (onSegmentSelect && offlineSegments.length === 0) {
      setDragStartTime(startTime);
      setDragCurrentTime(startTime);
      dragStartRef.current = startTime;
      dragCurrentRef.current = startTime;
      // Reset any previous action bar until selection decision
      setActionBarRange(null);
      setHiddenActionBarRange(null);
      setMoveDragOffsetPx(0);
    }



    const handlePointerMove = (moveClientX) => {
      const deltaX = Math.abs(moveClientX - startX);

      // If offline cuts exist, only warn when user starts dragging; allow single-click seeking
      if (offlineSegments.length > 0) {
        if (deltaX > dragThreshold && !warned) {
          setWarnOfflineDragVisible(true);
          try { setTimeout(() => setWarnOfflineDragVisible(false), 3500); } catch {}
          warned = true;
        }
        return;
      }

      // Check if we've moved enough to consider this a drag
      if (deltaX > dragThreshold) {
        hasMoved = true;

        // Only handle drag if segment selection is enabled
        if (onSegmentSelect) {
          if (!isDraggingRef.current) {
            setIsDraggingSegment(true);
            isDraggingRef.current = true;
          }

          const currentTime = pixelToTime(moveClientX);

          // Only update if the time has changed significantly (avoid excessive updates)
          if (Math.abs(currentTime - (dragCurrentRef.current || 0)) > 0.1) {
            setDragCurrentTime(currentTime);
            dragCurrentRef.current = currentTime;
          }
        }
      }
    };

    const handlePointerUp = (upClientX) => {
      if (hasMoved && onSegmentSelect && isDraggingRef.current) {
        // This was a drag - handle segment selection


        // Mark that dragging has been done in this session
        setHasDraggedInSession(true);

        if (dragStartRef.current !== null && dragCurrentRef.current !== null) {
          const start = Math.min(dragStartRef.current, dragCurrentRef.current);
          const end = Math.max(dragStartRef.current, dragCurrentRef.current);

          // Only create segment if there's a meaningful duration (at least 1 second)
          if (end - start >= 1) {

            if (offlineSegments.length > 0) {
              // When offline cuts exist, do not trigger the range action bar or open the modal
            } else if (hasSubtitlesInRange(start, end)) {
              // Show action bar instead of opening modal
              setActionBarRange({ start, end });
              setHiddenActionBarRange({ start, end });
            } else {
              sessionStorage.setItem('processing_modal_open_reason', 'drag-selection');
              onSegmentSelect({ start, end });
            }
          } else {

          }
        }
      } else if (!hasMoved) {
        // This was a tap/click - handle timeline seeking
        const clickTime = pixelToTime(upClientX);


        // Check if tap/click is inside any active range
        const activeRange = actionBarRange || hiddenActionBarRange || selectedSegment;
        const isInsideRange = activeRange &&
          clickTime >= activeRange.start &&
          clickTime <= activeRange.end;

        if (isInsideRange) {
          // Tap/click inside range - set flag to prevent hiding
          isClickingInsideRef.current = true;

          // Ensure action bar is shown (only when no offline cuts exist)
          if (!actionBarRange && activeRange) {
            if (hasSubtitlesInRange(activeRange.start, activeRange.end) && offlineSegments.length === 0) {
              setActionBarRange(activeRange);
              setHiddenActionBarRange(activeRange);
            }
          }

          // Reset flag after a short delay
          setTimeout(() => {
            isClickingInsideRef.current = false;
          }, 100);
        } else {

          // Tap/click outside - clear everything
          setActionBarRange(null);
          setHiddenActionBarRange(null);
        }

        // Always handle tap/click as seek (only for non-touch events)
        if (!isTouch) {
          handleClick(
            { clientX: upClientX },
            timelineRef.current,
            duration,
            onTimelineClick,
            getTimeRange(),
            lastManualPanTime
          );
        } else {
          // For touch events, manually seek to the position
          if (onTimelineClick) {
            onTimelineClick(clickTime);
          }
        }
      }

      // Clean up drag state
      if (onSegmentSelect) {
        setIsDraggingSegment(false);
        setDragStartTime(null);
        setDragCurrentTime(null);
        dragStartRef.current = null;
        dragCurrentRef.current = null;
        isDraggingRef.current = false;
      }
    };

    return { handlePointerMove, handlePointerUp };
  };

  // Handle mouse down - supports both click and drag
  const handleMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const { handlePointerMove, handlePointerUp } = handlePointerDown(e.clientX, e.clientY, false);

    const handleMouseMove = (moveEvent) => {
      handlePointerMove(moveEvent.clientX);
    };

    const handleMouseUp = (upEvent) => {
      handlePointerUp(upEvent.clientX);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Handle touch start - supports both tap and drag for mobile devices
  const handleTouchStart = (e) => {
    // Don't prevent default to allow scrolling if needed
    e.stopPropagation();

    const touch = e.touches[0];
    const { handlePointerMove, handlePointerUp } = handlePointerDown(touch.clientX, touch.clientY, true);

    const handleTouchMove = (moveEvent) => {
      // Prevent scrolling when dragging on timeline
      moveEvent.preventDefault();
      const moveTouch = moveEvent.touches[0];
      handlePointerMove(moveTouch.clientX);
    };

    const handleTouchEnd = (endEvent) => {
      // Use the last known touch position or the touch end position
      const endTouch = endEvent.changedTouches[0];
      handlePointerUp(endTouch.clientX);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
  };

  // Note: Timeline click handling is now integrated into handleMouseDown
  // to support both click-to-seek and drag-to-select functionality

  // Helper overlay component that follows the timeline canvas without leaking rAF
  const OverlayFollower = ({ canvasRef, deps = [], computeStyle, children }) => {
    const containerRef = useRef(null);
    const computeStyleRef = useRef(computeStyle);
    const scheduleRef = useRef(() => {});

    // Always keep latest computeStyle without tearing down listeners
    useEffect(() => { computeStyleRef.current = computeStyle; }, [computeStyle]);

    // Do initial measure before paint to avoid 0,0 flash; keep listeners stable
    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      const el = containerRef.current;
      if (!canvas || !el) return;
      let rafId = 0;
      const update = () => {
        const bounds = canvas.getBoundingClientRect();
        const style = computeStyleRef.current(bounds);
        if (style && el) Object.assign(el.style, style);
        // Only interactable/visible when there is actual child content (e.g., a button)
        const hasChild = !!(el && el.firstElementChild);
        el.style.visibility = hasChild ? 'visible' : 'hidden';
        el.style.pointerEvents = hasChild ? 'auto' : 'none';
      };
      const schedule = () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(update);
      };
      scheduleRef.current = schedule;

      // Initial sync update to avoid flicker
      try { update(); } catch {}

      const ro = new ResizeObserver(schedule);
      ro.observe(canvas);
      window.addEventListener('scroll', schedule, true);
      window.addEventListener('resize', schedule);

      return () => {
        ro.disconnect();
        window.removeEventListener('scroll', schedule, true);
        window.removeEventListener('resize', schedule);
        if (rafId) cancelAnimationFrame(rafId);
        scheduleRef.current = () => {};
      };
    }, [canvasRef]);

    // When deps change (zoom/pan/lyrics/time), just schedule an update; don't teardown
    useEffect(() => { scheduleRef.current(); }, [computeStyle, ...deps]);

    return (
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
        <div ref={containerRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'auto', zIndex: 1000, visibility: 'hidden' }}>
          {children}
        </div>
      </div>
    );
  };

  return (
    <div className="timeline-container" style={{ position: 'relative' }}>
      {/* Clear offline segments button (hidden during processing/retry to avoid blocking) */}
      {offlineSegments.length > 0 && (retryingOfflineKeys.length === 0) && (() => {
        const canvas = timelineRef.current;
        if (!canvas) return null;
        const computeStyle = (bounds) => ({ top: `${(bounds.top || 0) - 36}px`, left: `${(bounds.left || 0) + 8}px` });
        const overlay = (
          <OverlayFollower canvasRef={timelineRef} computeStyle={computeStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn-base btn-tonal btn-small"
                onClick={(e) => { e.stopPropagation(); handleClearOfflineSegments(); }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, minHeight: 24, padding: '0 8px', borderRadius: 12, backgroundColor: 'var(--md-surface-variant)', color: 'var(--md-on-surface-variant)', border: '1px solid var(--md-outline-variant)' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'currentColor' }}>delete_sweep</span>
                {t('timeline.clearOfflineSegments', 'Clear offline segments')}
              </button>
              {clearInfoVisible && (
                <span role="status" aria-live="polite" style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '2px 8px', borderRadius: 10, color: 'var(--md-on-surface-variant)', backgroundColor: 'var(--md-surface-variant)', border: '1px solid var(--md-outline-variant)' }}>
                  {t('timeline.offlineClearNotice', 'Cleared offline segments from UI. Files will be removed in background and may persist briefly due to OS locks.')}
                </span>
              )}
            </div>
          </OverlayFollower>
        );
        return createPortal(overlay, document.body);
      })() }

      {/* Subtle warning when user tries to drag while offline segments exist */}
      {warnOfflineDragVisible && (
        <div style={{ position: 'absolute', top: 6, right: 8, zIndex: 5 }}>
          <span role="status" aria-live="polite" style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '2px 8px', borderRadius: 10, color: 'var(--md-on-surface-variant)', backgroundColor: 'var(--md-surface-variant)', border: '1px solid var(--md-outline-variant)' }}>
            {t('timeline.clearOfflineFirst', 'Please clear offline segments to exit this mode first')}
          </span>
        </div>
      )}

      {/* Hover refresh icon (portal) at colorful bits' vertical center */}
      {/* Retry button is rendered via a dedicated body-level layer, independent of canvas animation */}

      {/* Range action header placed vertically above the timeline canvas */}
      {actionBarRange && (retryingOfflineKeys.length === 0) && (() => {
        const canvas = timelineRef.current;
        const { start: visStart, end: visEnd } = getTimeRange();
        const width = canvas?.clientWidth || 1;
        const toPx = (t) => ((t - visStart) / Math.max(0.0001, (visEnd - visStart))) * width;
        const leftPx = Math.max(0, Math.min(width, toPx(actionBarRange.start)));
        const rightPx = Math.max(0, Math.min(width, toPx(actionBarRange.end)));
        const barLeft = Math.min(leftPx, rightPx) + moveDragOffsetPx;
        const barWidth = Math.max(24, Math.abs(rightPx - leftPx));
        const timePerPx = (visEnd - visStart) / Math.max(1, width);

        // Unified Pointer Events handler (robust on mobile): keeps capture during drag
        const handleMovePointerDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startOffset = moveDragOffsetPx;
          const startRange = actionBarRange;
          isRangeMoveDraggingRef.current = true;
          if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);

          // Try to capture the pointer so move/up keep firing even if finger leaves the button
          try {
            const pid = (e.pointerId != null) ? e.pointerId : (e.nativeEvent && e.nativeEvent.pointerId);
            if (e.currentTarget && e.currentTarget.setPointerCapture && pid != null) {
              e.currentTarget.setPointerCapture(pid);
            }
          } catch {}

          const onMove = (pe) => {
            const px = startOffset + (pe.clientX - startX);
            setMoveDragOffsetPx(px);
            moveDragOffsetPxRef.current = px;
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
            pe.preventDefault();
          };

          const cleanup = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
          };

          const onUp = () => {
            cleanup();
            const deltaSeconds = (moveDragOffsetPxRef.current || 0) * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
              onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            moveDragOffsetPxRef.current = 0;
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
            isRangeMoveDraggingRef.current = false;
          };

          window.addEventListener('pointermove', onMove, { capture: true, passive: false });
          window.addEventListener('pointerup', onUp, { capture: true });
          window.addEventListener('pointercancel', onUp, { capture: true });
        };

        // Fallback mouse-only (desktop) and touch-only (legacy) handlers retained
        const handleMoveMouseDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startOffset = moveDragOffsetPx;
          const startRange = actionBarRange;
          isRangeMoveDraggingRef.current = true;
          if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);
          const onMove = (me) => {
            const px = startOffset + (me.clientX - startX);
            setMoveDragOffsetPx(px);
            moveDragOffsetPxRef.current = px;
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const deltaSeconds = (moveDragOffsetPxRef.current || 0) * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
              onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            moveDragOffsetPxRef.current = 0;
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
            isRangeMoveDraggingRef.current = false;
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };

        const handleMoveTouchStart = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const touch = e.touches && e.touches[0];
          if (!touch) return;
          const startX = touch.clientX;
          const startOffset = moveDragOffsetPx;
          const startRange = actionBarRange;
          isRangeMoveDraggingRef.current = true;
          if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);

          const onMove = (te) => {
            const t = (te.touches && te.touches[0]) || (te.changedTouches && te.changedTouches[0]);
            if (!t) return;
            const px = startOffset + (t.clientX - startX);
            setMoveDragOffsetPx(px);
            moveDragOffsetPxRef.current = px;
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
            te.preventDefault();
          };

          const onUp = () => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            document.removeEventListener('touchcancel', onUp);
            const deltaSeconds = (moveDragOffsetPxRef.current || 0) * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
              onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            moveDragOffsetPxRef.current = 0;
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
            isRangeMoveDraggingRef.current = false;
          };

          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend', onUp);
          document.addEventListener('touchcancel', onUp);
        };

        if (!canvas) return null;
        const computeStyle = (bounds) => ({ top: `${(bounds.top || 0) - 36}px`, left: `${(bounds.left || 0) + Math.max(0, Math.min((canvas?.clientWidth || width) - barWidth, barLeft))}px` });

        const overlay = (
          <OverlayFollower canvasRef={timelineRef} computeStyle={computeStyle} deps={[actionBarRange, moveDragOffsetPx, panOffset, zoom, lyrics]}>
            <div
              className="range-action-bar"
              style={{
                position: 'absolute',
                top: '0px',
                left: '0px',
                width: `${barWidth}px`,
                transform: 'translateX(0)',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4px 6px',
                borderRadius: 12,
                zIndex: 999,
                color: 'var(--md-on-surface)',
                pointerEvents: 'auto',
                touchAction: 'none'
              }}
              onMouseLeave={() => {
                // Don't hide if we're clicking inside the range or currently dragging the move handle
                if (isClickingInsideRef.current || isRangeMoveDraggingRef.current) {
                  return;
                }

                // Hide the action bar when mouse leaves, but keep the range stored
                // If this is for a selectedSegment, we want to be able to show it again
                if (selectedSegment &&
                    actionBarRange.start === selectedSegment.start &&
                    actionBarRange.end === selectedSegment.end) {
                  // For selectedSegment, just hide the bar but keep tracking
                  setHiddenActionBarRange(actionBarRange);
                } else {
                  // For manually selected ranges
                  setHiddenActionBarRange(actionBarRange);
                }
                setActionBarRange(null);
              }}
              onPointerLeave={() => {
                // Same logic as onMouseLeave, but for pointer devices (covers touch pointers too)
                if (isClickingInsideRef.current || isRangeMoveDraggingRef.current) {
                  return;
                }
                if (selectedSegment &&
                    actionBarRange.start === selectedSegment.start &&
                    actionBarRange.end === selectedSegment.end) {
                  setHiddenActionBarRange(actionBarRange);
                } else {
                  setHiddenActionBarRange(actionBarRange);
                }
                setActionBarRange(null);
              }}
            >
              <button
                className="btn-base btn-primary btn-small"
                onClick={(e) => {
                  e.stopPropagation();
                  sessionStorage.setItem('processing_modal_open_reason', 'action-bar-regenerate');
                  onSegmentSelect && onSegmentSelect(actionBarRange);
                  setActionBarRange(null);
                  setHiddenActionBarRange(null);
                }}
              >
                {t('timeline.generateReplace', 'Regenerate subtitles')}
              </button>
              <button
                className="btn-base btn-primary btn-small"
                title={t('timeline.clearInRangeWithShortcut', 'Clear subtitles in range (Del/Backspace)')}
                onClick={(e) => {
                  e.stopPropagation();
                  onClearRange && onClearRange(actionBarRange.start, actionBarRange.end);
                  setActionBarRange(null);
                  setHiddenActionBarRange(null);
                }}
                style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'var(--md-on-primary)' }}>delete</span>
              </button>
              <button
                className="btn-base btn-primary btn-small"
                title={t('timeline.moveRange', 'Drag to move subtitles in range')}
                onPointerDown={handleMovePointerDown}
                style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%', cursor: 'grab', touchAction: 'none' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '18px', color: 'var(--md-on-primary)' }}>drag_indicator</span>
              </button>
            </div>
          </OverlayFollower>
        );

        return createPortal(overlay, document.body);

      })()}

      <canvas
        ref={timelineRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onContextMenu={handleContextMenu}
        className="subtitle-timeline"
        style={{
          cursor: isDraggingSegment
            ? 'ew-resize'
            : (onSegmentSelect && offlineSegments.length === 0)
              ? 'crosshair'
              : 'pointer',
          touchAction: (onSegmentSelect && offlineSegments.length === 0) ? 'none' : 'auto' // Disable touch gestures only when selection is enabled
        }}
      />

      {/* Drag hint animation */}
      {showDragHint && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '40px',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            opacity: (() => {
              const cycleTime = 4000; // 4 seconds per cycle
              const progress = (dragHintAnimationTime % cycleTime) / cycleTime;
              const maxOpacity = 0.9;
              // Smooth fade in at start and fade out at end
              return Math.sin(progress * Math.PI) * maxOpacity;
            })()
          }}
        >
          <span
            className="material-symbols-rounded"
            style={{
              fontSize: '48px',
              color: 'var(--md-on-surface-variant)',
              transform: `translateX(${(() => {
                // Smooth continuous left-to-right only motion over full cycle
                const cycleTime = 4000; // 4 seconds per cycle
                const progress = (dragHintAnimationTime % cycleTime) / cycleTime;

                // Ease in/out for the entire cycle
                const easeInOutCubic = progress < 0.5
                  ? 4 * progress * progress * progress
                  : 1 - Math.pow(-2 * progress + 2, 3) / 2;

                // Move a long distance for clarity
                return easeInOutCubic * 500; // 500px horizontal movement
              })()}px)`,

              transition: 'none',
              filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))'
            }}
          >
            touch_app
          </span>
          <span
            style={{
              color: 'var(--md-on-surface-variant)',
              fontSize: 14,
              fontWeight: 600,
              userSelect: 'none',
              transform: `translateX(${(() => {
                const cycleTime = 4000;
                const progress = (dragHintAnimationTime % cycleTime) / cycleTime;
                const easeInOutCubic = progress < 0.5
                  ? 4 * progress * progress * progress
                  : 1 - Math.pow(-2 * progress + 2, 3) / 2;
                return easeInOutCubic * 500; // match SVG motion
              })()}px)`,
            }}
          >
            {t('lyrics.dragHintOrShortcut', '(or Ctrl+A)')}
          </span>
        </div>
      )}

      {/* Liquid Glass zoom controls in top right corner */}
      {setZoom && (
        <LiquidGlass
          width={80}
          height={32}
          position="absolute"
          top="8px"
          right="8px"
          borderRadius="16px"
          className="content-center theme-primary size-small"
          cursor="ew-resize"
          zIndex={10}
          effectIntensity={0.8}
          effectRadius={0.4}
          effectWidth={0.25}
          effectHeight={0.15}
          animateOnHover={true}
          hoverScale={1.05}
          updateOnMouseMove={true}
          aria-label={t('timeline.dragToZoom', 'Drag to zoom')}
          style={{
            transition: 'transform 0.2s ease, box-shadow 0.2s ease'
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'ew-resize'
            }}
            onMouseDown={(e) => {
              const startX = e.clientX;
              const startZoom = zoom;
              // Hard-disable auto-scroll during zoom drag to avoid any conflicts
              disableAutoScroll.current = true;


              // Mark this as a manual interaction to prevent auto-scroll interference
              lastManualPanTime.current = performance.now();

              // Start RAF-based zoom drag to keep playhead strictly centered
              zoomDragActiveRef.current = true;
              zoomDragLastXRef.current = startX;

              const step = () => {
                if (!zoomDragActiveRef.current) return;
                const x = zoomDragLastXRef.current;
                const deltaX = x - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));

                if (duration && setPanOffset) {
                  const maxLyricTime = lyrics.length > 0
                    ? Math.max(...lyrics.map(lyric => lyric.end))
                    : duration;
                  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;
                  const newVisibleDuration = timelineEnd / newZoom;
                  const halfVisibleDuration = newVisibleDuration / 2;

                  const videoElement = document.querySelector('video');
                  const liveTime = (videoElement && !isNaN(videoElement.currentTime))
                    ? videoElement.currentTime
                    : currentTime;

                  const newPanOffset = Math.max(0, Math.min(
                    liveTime - halfVisibleDuration,
                    timelineEnd - newVisibleDuration
                  ));
                  currentZoomRef.current = newZoom;
                  lastComputedPanRef.current = newPanOffset;

                  // Apply zoom first, then pan to avoid parent reactions overriding pan
                  setZoom(newZoom);
                  setPanOffset(newPanOffset);

                }
                lastManualPanTime.current = performance.now();
                zoomDragRafRef.current = requestAnimationFrame(step);
              };

              const handleMouseMove = (moveEvent) => {
                zoomDragLastXRef.current = moveEvent.clientX;
                lastManualPanTime.current = performance.now();
              };

              const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                // Stop RAF loop
                zoomDragActiveRef.current = false;
                if (zoomDragRafRef.current) cancelAnimationFrame(zoomDragRafRef.current);
                // Finalize to the dragged result view (do NOT recenter to playhead)
                const x = zoomDragLastXRef.current;
                const deltaX = x - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                if (duration && setPanOffset) {
                  // Prefer the latest pan computed during drag
                  const finalPan = (lastComputedPanRef.current ?? panOffset);

                  currentZoomRef.current = newZoom;
                  // Apply zoom first, then pan
                  setZoom(newZoom);
                  setPanOffset(finalPan);
                  setPanOffset(finalPan);
                  disableAutoScroll.current = false;
                } else {
                  // Ensure auto-scroll is re-enabled even if early-return path
                  disableAutoScroll.current = false;

                }
                lastManualPanTime.current = performance.now();
              };

              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
              // Kick off the RAF loop
              zoomDragRafRef.current = requestAnimationFrame(step);
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchStart={(e) => {
              const touch = e.touches && e.touches[0];
              if (!touch) return;
              const startX = touch.clientX;
              const startZoom = zoom;
              lastManualPanTime.current = performance.now();
              // Hard-disable auto-scroll during zoom drag (touch)
              disableAutoScroll.current = true;


              // Start RAF-based zoom drag for touch to keep playhead centered
              zoomDragActiveRef.current = true;
              zoomDragLastXRef.current = startX;

              const step = () => {
                if (!zoomDragActiveRef.current) return;
                const x = zoomDragLastXRef.current;
                const deltaX = x - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));

                if (duration && setPanOffset) {
                  const maxLyricTime = lyrics.length > 0
                    ? Math.max(...lyrics.map(lyric => lyric.end))
                    : duration;
                  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;
                  const newVisibleDuration = timelineEnd / newZoom;
                  const halfVisibleDuration = newVisibleDuration / 2;

                  const videoElement = document.querySelector('video');
                  const liveTime = (videoElement && !isNaN(videoElement.currentTime))
                    ? videoElement.currentTime
                    : currentTime;

                  const newPanOffset = Math.max(0, Math.min(
                    liveTime - halfVisibleDuration,
                    timelineEnd - newVisibleDuration
                  ));
                  currentZoomRef.current = newZoom;
                  lastComputedPanRef.current = newPanOffset;

                  setZoom(newZoom);
                  setPanOffset(newPanOffset);
                  requestAnimationFrame(() => { if (zoomDragActiveRef.current) setPanOffset(newPanOffset); });
                }
                lastManualPanTime.current = performance.now();
                zoomDragRafRef.current = requestAnimationFrame(step);
              };

              const handleTouchMove = (te) => {
                const t = (te.touches && te.touches[0]) || (te.changedTouches && te.changedTouches[0]);
                if (!t) return;
                zoomDragLastXRef.current = t.clientX;
                lastManualPanTime.current = performance.now();
                te.preventDefault();
                te.stopPropagation();
              };

              const handleTouchEnd = () => {
                document.removeEventListener('touchmove', handleTouchMove);
                document.removeEventListener('touchend', handleTouchEnd);
                document.removeEventListener('touchcancel', handleTouchEnd);
                // Stop RAF loop
                zoomDragActiveRef.current = false;
                if (zoomDragRafRef.current) cancelAnimationFrame(zoomDragRafRef.current);
                // Finalize to the dragged result view (do NOT recenter to playhead)
                const x = zoomDragLastXRef.current;
                const deltaX = x - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                if (duration && setPanOffset) {
                  const finalPan = (lastComputedPanRef.current ?? panOffset);

                  currentZoomRef.current = newZoom;
                  setZoom(newZoom);
                  setPanOffset(finalPan);
                  setPanOffset(finalPan);
                  disableAutoScroll.current = false;
                } else {
                  disableAutoScroll.current = false;

                }
                lastManualPanTime.current = performance.now();
              };

              document.addEventListener('touchmove', handleTouchMove, { passive: false });
              document.addEventListener('touchend', handleTouchEnd);
              document.addEventListener('touchcancel', handleTouchEnd);
              // Kick off the RAF loop
              zoomDragRafRef.current = requestAnimationFrame(step);
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <span style={{
              fontSize: '12px',
              fontWeight: '600',
              color: 'var(--md-on-surface)',
              fontFamily: 'JetBrains Mono, monospace',
              userSelect: 'none',
              pointerEvents: 'none'
            }}>
              {Math.round(zoom * 100)}%
            </span>
          </div>
        </LiquidGlass>
      )}

      {(() => {
        const hasKnownDuration = typeof duration === 'number' && duration > 0;
        const effDuration = hasKnownDuration ? duration : (durationRef.current || 0);
        // Mount visualizer when:
        // - duration is known and <= 30min; or
        // - duration is known and > 30min but user enabled; or
        // - duration unknown, but user enabled (so they opted in intentionally)
        const shouldMount = videoSource && (
          (hasKnownDuration && (effDuration <= 1800 || showWaveformLongVideos)) ||
          (!hasKnownDuration && showWaveformLongVideos)
        );
        return shouldMount;
      })() && (
        <VolumeVisualizer
          audioSource={videoSource}
          duration={(typeof duration === 'number' && duration > 0 ? duration : (durationRef.current || 0))}
          visibleTimeRange={getTimeRange()}
          height={30}
        />
      )}
      {!videoSource && (
        <div className="srt-only-timeline-message">
          <span>{t('timeline.srtOnlyMode', 'SRT Only Mode - Timeline visualization based on subtitle timing')}</span>
        </div>
      )}

    </div>
  );
};

export default TimelineVisualization;