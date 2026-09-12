import { useEffect, useRef, useState } from 'react';

import { EVENTS, subscribe } from '../../events/bus';

// Streaming data changes React state; the render coordinator owns the animation clock.
export const useTimelineStreamingState = ({ lyrics }) => {
    // Track new segments for animation (only during streaming)
    const [newSegments, setNewSegments] = useState(new Map());
    const [isStreamingActive, setIsStreamingActive] = useState(false);
    const previousLyricsRef = useRef([]);

    // Track segment processing start times (for delayed segment processing)
    const [segmentProcessingStartTimes, setSegmentProcessingStartTimes] = useState(new Map()); // key: "start-end", value: { actualStartTime, delaySeconds }

    const [processingRanges, setProcessingRanges] = useState([]);
    const completionTimer = useRef(null);

    // Listen for streaming events and processing ranges
    useEffect(() => {
        const handleStreamingStart = (_event) => {
            clearTimeout(completionTimer.current);
            completionTimer.current = null;
            setIsStreamingActive(true);
        };

        const handleSegmentDelay = (e) => {
            // Handle segment processing delay information
            if (e.detail && e.detail.processingDelay && e.detail.segments) {
                const delaySeconds = e.detail.processingDelay;
                const segments = e.detail.segments;
                const startTimes = new Map();
                const now = performance.now();

                segments.forEach((segment, index) => {
                    const key = `${segment.start}-${segment.end}`;
                    startTimes.set(key, {
                        actualStartTime: now + (index * delaySeconds * 1000),
                        delaySeconds: delaySeconds,
                        segmentIndex: index
                    });
                });

                setSegmentProcessingStartTimes(startTimes);
            }
        };

        const handleProcessingRanges = (e) => {
            const ranges = (e.detail && e.detail.ranges) || [];
            setProcessingRanges(ranges);
        };

        const handleStreamingComplete = () => {
            // Keep animations active for a bit after streaming completes
            clearTimeout(completionTimer.current);
            completionTimer.current = setTimeout(() => {
                completionTimer.current = null;
                setIsStreamingActive(false);
                setNewSegments(new Map());
                setProcessingRanges([]);
                setSegmentProcessingStartTimes(new Map());
            }, 1000);
        };

        // Listen for custom streaming events via EventBus
        const un1 = subscribe(EVENTS.STREAMING_UPDATE, handleStreamingStart);
        const un2 = subscribe(EVENTS.STREAMING_COMPLETE, handleStreamingComplete);
        const un3 = subscribe(EVENTS.SAVE_AFTER_STREAMING, handleStreamingComplete);
        const un4 = subscribe(EVENTS.PROCESSING_RANGES, handleProcessingRanges);

        // Also listen for direct segment delay events from parallelStreamingCoordinator
        const handleDirectSegmentDelay = (e) => {
            handleSegmentDelay(e);
        };
        window.addEventListener('streaming-segment-delay', handleDirectSegmentDelay);

        return () => {
            clearTimeout(completionTimer.current);
            un1(); un2(); un3(); un4();
            window.removeEventListener('streaming-segment-delay', handleDirectSegmentDelay);
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

        // Exact start/end/text identity, without scanning all previous cues for every new cue.
        // Nested maps avoid delimiter collisions in arbitrary subtitle text.
        const previousIndex = new Map();
        previousLyrics.forEach(({ start, end, text }) => {
            if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(text)) return;
            if (!previousIndex.has(start)) previousIndex.set(start, new Map());
            const byEnd = previousIndex.get(start);
            if (!byEnd.has(end)) byEnd.set(end, new Set());
            byEnd.get(end).add(text);
        });

        // Find segments that are new (not in previous lyrics)
        lyrics.forEach(lyric => {
            const isNew = !previousIndex.get(lyric.start)?.get(lyric.end)?.has(lyric.text);

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

    return {
        newSegments,
        setNewSegments,
        isStreamingActive,
        segmentProcessingStartTimes,
        processingRanges,
        setProcessingRanges
    };
};
