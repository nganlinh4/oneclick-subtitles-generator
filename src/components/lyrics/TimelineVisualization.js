import React, { useEffect, useCallback, useRef, useState } from 'react';
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
  
  // Handle processing animation
  useEffect(() => {
    if (isProcessingSegment) {
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
  }, [isProcessingSegment]);

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
        console.log('[Timeline] Parallel processing ranges set:', ranges);
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
    const segmentData = {
      selectedSegment: effectiveSelected,
      isDraggingSegment,
      dragStartTime,
      dragCurrentTime,
      isProcessing: isProcessingSegment,
      animationTime,
      newSegments: newSegments, // Pass new segments for animation
      processingRanges: processingRanges
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
  }, [lyrics, currentTime, duration, getTimeRange, panOffset, getVisibleRangeWithTempOffset, timeFormat, selectedSegment, isDraggingSegment, dragStartTime, dragCurrentTime, isProcessingSegment, animationTime, newSegments, actionBarRange, hiddenActionBarRange]);
  
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

  // Add keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
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
        
        console.log('[Timeline] Ctrl+A pressed - selecting entire video range');
        
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
        
        console.log('[Timeline] Ctrl+A selection:', startTime.toFixed(2), '-', endTime.toFixed(2), 's');
        
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
          if (checkForSubtitles(startTime, endTime)) {
            // Show action bar instead of opening modal
            setActionBarRange({ start: startTime, end: endTime });
            setHiddenActionBarRange({ start: startTime, end: endTime });
          } else {
            // Open video processing modal for entire range
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
        console.log('[Timeline] Right-click on selected segment - opening video processing modal');
        // Trigger the segment selection callback to open the modal
        onSegmentSelect(selectedSegment);
      }
    }
  };

  // Enable Delete key to trigger clear-in-range when action bar is visible
  useEffect(() => {
    if (!actionBarRange) return;
    const onKeyDown = (e) => {
      if (e.key === 'Delete') {
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
    // Check both hiddenActionBarRange and selectedSegment
    if (!hiddenActionBarRange && !actionBarRange && !selectedSegment) return;
    
    const canvas = timelineRef.current;
    const effectiveDuration = duration || 60;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const timeRange = getTimeRange();
    const timePerPixel = (timeRange.end - timeRange.start) / canvas.clientWidth;
    const hoverTime = Math.max(0, Math.min(effectiveDuration, timeRange.start + (relativeX * timePerPixel)));
    
    // Check if hovering within the hidden action bar range
    const range = hiddenActionBarRange || actionBarRange;
    if (range && hoverTime >= range.start && hoverTime <= range.end) {
      // Show the action bar if it was hidden
      if (hiddenActionBarRange && !actionBarRange) {
        setActionBarRange(hiddenActionBarRange);
      }
    }
    
    // Check if hovering within the persistent selectedSegment (from subtitle generation)
    if (selectedSegment && !actionBarRange && 
        hoverTime >= selectedSegment.start && hoverTime <= selectedSegment.end) {
      // Check if there are subtitles in this segment
      if (hasSubtitlesInRange(selectedSegment.start, selectedSegment.end)) {
        // Show action bar for the selected segment
        setActionBarRange(selectedSegment);
        setHiddenActionBarRange(selectedSegment);
      }
    }
  }, [hiddenActionBarRange, actionBarRange, selectedSegment, duration, getTimeRange, hasSubtitlesInRange]);

  // Add mouse move listener for hover detection
  useEffect(() => {
    if (hiddenActionBarRange || actionBarRange || selectedSegment) {
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
  const handlePointerDown = (clientX, clientY, isTouch = false) => {
    const startTime = pixelToTime(clientX);
    const startX = clientX;
    let hasMoved = false;
    let dragThreshold = isTouch ? 10 : 5; // pixels - higher threshold for touch to avoid accidental drags

    console.log(`[Timeline] ${isTouch ? 'Touch' : 'Mouse'} down at time:`, startTime.toFixed(2), 's');

    // Initialize drag state for segment selection (if enabled)
    if (onSegmentSelect) {
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
        console.log(`[Timeline] ${isTouch ? 'Touch' : 'Mouse'} drag detected - creating segment`);

        // Mark that dragging has been done in this session
        setHasDraggedInSession(true);

        if (dragStartRef.current !== null && dragCurrentRef.current !== null) {
          const start = Math.min(dragStartRef.current, dragCurrentRef.current);
          const end = Math.max(dragStartRef.current, dragCurrentRef.current);

          // Only create segment if there's a meaningful duration (at least 1 second)
          if (end - start >= 1) {
            console.log('[Timeline] Selection:', start.toFixed(2), '-', end.toFixed(2), 's');
            if (hasSubtitlesInRange(start, end)) {
              // Show action bar instead of opening modal
              setActionBarRange({ start, end });
              setHiddenActionBarRange({ start, end });
            } else {
              onSegmentSelect({ start, end });
            }
          } else {
            console.log('[Timeline] Segment too short, ignoring');
          }
        }
      } else if (!hasMoved) {
        // This was a tap/click - handle timeline seeking
        const clickTime = pixelToTime(upClientX);
        console.log(`[Timeline] ${isTouch ? 'Tap' : 'Click'} detected - seeking to:`, clickTime.toFixed(2), 's');
        
        // Check if tap/click is inside any active range
        const activeRange = actionBarRange || hiddenActionBarRange || selectedSegment;
        const isInsideRange = activeRange && 
          clickTime >= activeRange.start && 
          clickTime <= activeRange.end;
        
        if (isInsideRange) {
          // Tap/click inside range - set flag to prevent hiding
          isClickingInsideRef.current = true;
          
          // Ensure action bar is shown
          if (!actionBarRange && activeRange) {
            if (hasSubtitlesInRange(activeRange.start, activeRange.end)) {
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

  return (
    <div className="timeline-container" style={{ position: 'relative' }}>
      {/* Range action header placed vertically above the timeline canvas */}
      {actionBarRange && (() => {
        const canvas = timelineRef.current;
        const { start: visStart, end: visEnd } = getTimeRange();
        const width = canvas?.clientWidth || 1;
        const toPx = (t) => ((t - visStart) / Math.max(0.0001, (visEnd - visStart))) * width;
        const leftPx = Math.max(0, Math.min(width, toPx(actionBarRange.start)));
        const rightPx = Math.max(0, Math.min(width, toPx(actionBarRange.end)));
        const barLeft = Math.min(leftPx, rightPx) + moveDragOffsetPx;
        const barWidth = Math.max(24, Math.abs(rightPx - leftPx));
        const timePerPx = (visEnd - visStart) / Math.max(1, width);

        const handleMoveMouseDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startOffset = moveDragOffsetPx;
          const startRange = actionBarRange;
          if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);
          const onMove = (me) => {
            const px = startOffset + (me.clientX - startX);
            setMoveDragOffsetPx(px);
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const deltaSeconds = moveDragOffsetPx * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
              onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };

        // Touch equivalent for moving range on mobile
        const handleMoveTouchStart = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const touch = e.touches && e.touches[0];
          if (!touch) return;
          const startX = touch.clientX;
          const startOffset = moveDragOffsetPx;
          const startRange = actionBarRange;
          if (onBeginMoveRange && startRange) onBeginMoveRange(startRange.start, startRange.end);

          const onMove = (te) => {
            const t = (te.touches && te.touches[0]) || (te.changedTouches && te.changedTouches[0]);
            if (!t) return;
            const px = startOffset + (t.clientX - startX);
            setMoveDragOffsetPx(px);
            const deltaSeconds = px * timePerPx;
            rangePreviewDeltaRef.current = deltaSeconds;
            onPreviewMoveRange && onPreviewMoveRange(deltaSeconds);
            te.preventDefault();
          };

          const onUp = () => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            document.removeEventListener('touchcancel', onUp);
            const deltaSeconds = moveDragOffsetPx * timePerPx;
            if (onCommitMoveRange) onCommitMoveRange();
            else if (onMoveRange && Math.abs(deltaSeconds) > 0.001)
              onMoveRange(actionBarRange.start, actionBarRange.end, deltaSeconds);
            setMoveDragOffsetPx(0);
            rangePreviewDeltaRef.current = 0;
            setActionBarRange(null);
            setHiddenActionBarRange(null);
          };

          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend', onUp);
          document.addEventListener('touchcancel', onUp);
        };

        const overlayRoot = document.getElementById('timeline-header-overlays-root');
        const actionBarRef = { current: null };
        let rafId;

        const updatePosition = () => {
          const canvasBounds = canvas?.getBoundingClientRect();
          if (actionBarRef.current && canvasBounds) {
            actionBarRef.current.style.top = `${(canvasBounds.top || 0) - 36}px`;
            actionBarRef.current.style.left = `${(canvasBounds.left || 0) + barLeft}px`;
            actionBarRef.current.style.width = `${barWidth}px`;
          }
          rafId = requestAnimationFrame(updatePosition);
        };
        // Start continuous updates while the bar is visible
        rafId = requestAnimationFrame(updatePosition);

        const overlay = (
          <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
            <div
              ref={(el) => (actionBarRef.current = el)}
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
                pointerEvents: 'auto'
              }}
              onMouseLeave={() => {
                // Don't hide if we're clicking inside the range
                if (isClickingInsideRef.current) {
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
            >
              <button
                className="btn-base btn-primary btn-small"
                onClick={(e) => {
                  e.stopPropagation();
                  onSegmentSelect && onSegmentSelect(actionBarRange);
                  setActionBarRange(null);
                  setHiddenActionBarRange(null);
                }}
              >
                {t('timeline.generateReplace', 'Regenerate subtitles')}
              </button>
              <button
                className="btn-base btn-primary btn-small"
                title={t('timeline.clearInRangeWithShortcut', 'Clear subtitles in range (Del)')}
                onClick={(e) => {
                  e.stopPropagation();
                  onClearRange && onClearRange(actionBarRange.start, actionBarRange.end);
                  setActionBarRange(null);
                  setHiddenActionBarRange(null);
                }}
                style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" aria-hidden style={{ color: 'var(--md-on-primary)' }}>
                  <path fill="currentColor" d="M320-160q-33 0-56.5-23.5T240-240v-520h-80v-80h200v-40h240v40h200v80h-80v520q0 33-23.5 56.5T640-160H320Zm80-160h80v-360h-80v360Zm160 0h80v-360h-80v360Z"/>
                </svg>
              </button>
              <button
                className="btn-base btn-primary btn-small"
                title={t('timeline.moveRange', 'Drag to move subtitles in range')}
                onMouseDown={handleMoveMouseDown}
                onTouchStart={handleMoveTouchStart}
                style={{ width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: '50%', cursor: 'grab', touchAction: 'none' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" aria-hidden style={{ color: 'var(--md-on-primary)' }}>
                  <path fill="currentColor" d="m294-415 33 34q20 19 19 44.5T326-292q-18 18-44.18 18T238-292L96-433q-9-9.4-14.5-21.2-5.5-11.8-5.5-25 0-12.2 5.5-24.5T96-524l140-141q17.64-18 43.82-18T325-665q19 18 19 44.67 0 26.66-19 45.33l-30 31h370l-33-33q-20-18-18.5-44t21.5-44q18-18 44.18-18T723-665l141 141q9 9.4 14.5 21.2 5.5 11.8 5.5 24 0 13.2-5.5 25T864-433L723-292q-17.64 18-43.32 18T635-292q-20-19-20.5-45.17Q614-363.33 633-382l32-33H294Z"/>
                </svg>
              </button>
            </div>
          </div>
        );

        // Cleanup RAF when unmounting the overlay
        setTimeout(() => {
          const cleanup = () => rafId && cancelAnimationFrame(rafId);
          // Schedule after portal mount; parent hides overlay by setting actionBarRange to null
          cleanup.__keep = true;
          return cleanup;
        }, 0);

        return overlayRoot ? createPortal(overlay, overlayRoot) : null;

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
            : onSegmentSelect
              ? 'crosshair'
              : 'pointer',
          touchAction: onSegmentSelect ? 'none' : 'auto' // Disable touch gestures when range selection is enabled
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="48px"
            viewBox="0 -960 960 960"
            width="48px"
            fill="currentColor"
            style={{
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
            <path d="M445-80q-29 0-56-12t-45-35L143-383q-7-9-7-20t8-19l4-4q14-15 34.5-18.5T221-438l99 53v-365q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v415q0 17-14.5 25.5t-29.5.5l-100-53 156 198q10 12 23.76 18 13.76 6 29.24 6h205q38 0 64-26t26-64v-170q0-25.5-17.25-42.75T680-460H490q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32 8.62-8.5 21.37-8.5h190q50 0 85 35t35 85v170q0 63-43.5 106.5T650-80H445Zm43-250Zm-16.7-320q-13.3 0-21.8-8.63-8.5-8.62-8.5-21.37 0-1.5 4-15 7-12 11-26t4-29.48Q460-796 427.88-828q-32.12-32-78-32T272-827.92q-32 32.09-32 77.92 0 15 4 29t11 26q2 3 3 6.5t1 8.5q0 12.75-8.58 21.37-8.58 8.63-21.84 8.63-8.58 0-15.58-4t-11.17-11.84Q191-685 185.5-706.25q-5.5-21.25-5.5-44.2 0-70.55 49.73-120.05Q279.45-920 350-920t120.27 49.5Q520-821 520-750.31q0 22.99-5.7 44.28-5.71 21.29-16.3 40.03-4 8-11.04 12-7.05 4-15.66 4Z"/>
          </svg>
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

              // Mark this as a manual interaction to prevent auto-scroll interference
              lastManualPanTime.current = performance.now();

              const handleMouseMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                const videoElement = document.querySelector('video');
                const realTimeCurrentTime = videoElement && !isNaN(videoElement.currentTime)
                  ? videoElement.currentTime
                  : currentTime;
                if (duration && setPanOffset) {
                  const maxLyricTime = lyrics.length > 0
                    ? Math.max(...lyrics.map(lyric => lyric.end))
                    : duration;
                  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;
                  const newVisibleDuration = timelineEnd / newZoom;
                  const halfVisibleDuration = newVisibleDuration / 2;
                  const newPanOffset = Math.max(0, Math.min(
                    realTimeCurrentTime - halfVisibleDuration,
                    timelineEnd - newVisibleDuration
                  ));
                  currentZoomRef.current = newZoom;
                  setPanOffset(newPanOffset);
                }
                setZoom(newZoom);
              };

              const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
              };

              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchStart={(e) => {
              const touch = e.touches && e.touches[0];
              if (!touch) return;
              const startX = touch.clientX;
              const startZoom = zoom;
              lastManualPanTime.current = performance.now();

              const handleTouchMove = (te) => {
                const t = (te.touches && te.touches[0]) || (te.changedTouches && te.changedTouches[0]);
                if (!t) return;
                const deltaX = t.clientX - startX;
                const newZoom = Math.max(1, Math.min(200, startZoom + (deltaX * 0.05)));
                const videoElement = document.querySelector('video');
                const realTimeCurrentTime = videoElement && !isNaN(videoElement.currentTime)
                  ? videoElement.currentTime
                  : currentTime;
                if (duration && setPanOffset) {
                  const maxLyricTime = lyrics.length > 0
                    ? Math.max(...lyrics.map(lyric => lyric.end))
                    : duration;
                  const timelineEnd = Math.max(maxLyricTime, duration) * 1.05;
                  const newVisibleDuration = timelineEnd / newZoom;
                  const halfVisibleDuration = newVisibleDuration / 2;
                  const newPanOffset = Math.max(0, Math.min(
                    realTimeCurrentTime - halfVisibleDuration,
                    timelineEnd - newVisibleDuration
                  ));
                  currentZoomRef.current = newZoom;
                  setPanOffset(newPanOffset);
                }
                setZoom(newZoom);
                te.preventDefault();
                te.stopPropagation();
              };

              const handleTouchEnd = () => {
                document.removeEventListener('touchmove', handleTouchMove);
                document.removeEventListener('touchend', handleTouchEnd);
                document.removeEventListener('touchcancel', handleTouchEnd);
              };

              document.addEventListener('touchmove', handleTouchMove, { passive: false });
              document.addEventListener('touchend', handleTouchEnd);
              document.addEventListener('touchcancel', handleTouchEnd);
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