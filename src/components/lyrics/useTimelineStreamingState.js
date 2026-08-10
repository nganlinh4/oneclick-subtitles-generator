import { useEffect, useRef, useState } from 'react';

import { EVENTS, subscribe } from '../../events/bus';

// Owns the timeline's streaming/animation state and the two effects that feed
// it: the event-bus listeners (streaming start/complete, processing ranges,
// per-segment delay) and the new-segment tracker that flags freshly arrived
// lyrics for the pop-in animation. The RAF loops that actually drive the
// animations live in the host (they depend on renderTimeline / retry state),
// so the refs and setters are returned for the host to use.
export const useTimelineStreamingState = ({ lyrics }) => {
    // Animation state for processing
    const [animationTime, setAnimationTime] = useState(0);
    const processingAnimationRef = useRef(null);

    // Track new segments for animation (only during streaming)
    const [newSegments, setNewSegments] = useState(new Map());
    const [isStreamingActive, setIsStreamingActive] = useState(false);
    const previousLyricsRef = useRef([]);
    const newSegmentAnimationRef = useRef(null);

    // Track segment processing start times (for delayed segment processing)
    const [segmentProcessingStartTimes, setSegmentProcessingStartTimes] = useState(new Map()); // key: "start-end", value: { actualStartTime, delaySeconds }

    const [processingRanges, setProcessingRanges] = useState([]);

    // Listen for streaming events and processing ranges
    useEffect(() => {
        const handleStreamingStart = (_event) => {
            // console.log('[Timeline] Streaming started - enabling segment animations');
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

                console.log('[Timeline] Received segment delay info for', segments.length, 'segments with', delaySeconds, 'second delay');
                setSegmentProcessingStartTimes(startTimes);
            }
        };

        const handleProcessingRanges = (e) => {
            const ranges = (e.detail && e.detail.ranges) || [];
            setProcessingRanges(ranges);
        };

        const handleStreamingComplete = () => {
            // console.log('[Timeline] Streaming complete - disabling segment animations');
            // Keep animations active for a bit after streaming completes
            setTimeout(() => {
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

    return {
        animationTime,
        setAnimationTime,
        processingAnimationRef,
        newSegments,
        setNewSegments,
        isStreamingActive,
        newSegmentAnimationRef,
        segmentProcessingStartTimes,
        processingRanges,
        setProcessingRanges
    };
};
