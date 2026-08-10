import { EVENTS } from '../events/bus';

/**
 * Streaming update handler factories extracted from useSubtitles.
 *
 * Each factory returns a fresh, per-call `onStreamingUpdate` handler with its own
 * throttling state. Behavior is byte-for-byte identical to the original inline
 * closures that lived in generateSubtitles.
 */

/**
 * Progressive-merge streaming handler for single-segment processing.
 *
 * Merges streaming subtitles into the existing timeline (filtering out subtitles
 * that overlap the segment), throttling merges and undo/redo captures.
 */
export const createSegmentStreamingHandler = (segment, setSubtitlesData) => {
    // Create a throttled version of the streaming update handler
    let lastMergeTime = 0;
    let pendingUpdate = null;
    let updateTimer = null;
    const MERGE_THROTTLE_MS = 500; // Throttle merges to once every 500ms
    const CAPTURE_THROTTLE_MS = 2000; // Capture undo state less frequently
    let lastCaptureTime = 0;

    return (streamingSubtitles, isStreaming, chunkInfo) => {
        // Real-time subtitle updates during streaming
        if (streamingSubtitles && streamingSubtitles.length > 0) {
            // debugLog(`[Subtitle Generation] Streaming update: ${streamingSubtitles.length} subtitles`);

            const now = Date.now();
            const timeSinceMerge = now - lastMergeTime;
            const timeSinceCapture = now - lastCaptureTime;

            // Store the pending update
            pendingUpdate = { streamingSubtitles, isStreaming, chunkInfo };

            // Clear any existing timer
            if (updateTimer) {
                clearTimeout(updateTimer);
            }

            // Throttle the merge operations
            if (timeSinceMerge >= MERGE_THROTTLE_MS) {
                // Enough time has passed, perform the merge immediately
                lastMergeTime = now;

                // Only capture state for undo/redo occasionally, not on every merge
                if (timeSinceCapture >= CAPTURE_THROTTLE_MS) {
                    lastCaptureTime = now;
                    window.dispatchEvent(new CustomEvent(EVENTS.CAPTURE_BEFORE_MERGE, {
                        detail: {
                            type: 'progressive-merge',
                            source: 'streaming-update',
                            segment: segment
                        }
                    }));
                }

                // CRITICAL FIX: Merge streaming subtitles with existing timeline
                // Get current subtitles and filter out those in the segment range
                setSubtitlesData(current => {
                    const existingSubtitles = current || [];

                    // Filter out existing subtitles that overlap with this segment
                    const nonOverlappingSubtitles = existingSubtitles.filter(sub => {
                        // Keep subtitles that are completely outside the segment boundaries
                        return sub.end <= segment.start || sub.start >= segment.end;
                    });

                    // Merge: existing non-overlapping + new streaming subtitles
                    const mergedStreamingSubtitles = [...nonOverlappingSubtitles, ...streamingSubtitles]
                        .sort((a, b) => a.start - b.start);

                    return mergedStreamingSubtitles;
                });

                // Status updates are handled by realtimeProcessor
                // Only show completion message when streaming ends (handled elsewhere)
            } else {
                // Schedule the update for later
                const delay = MERGE_THROTTLE_MS - timeSinceMerge;
                updateTimer = setTimeout(() => {
                    if (pendingUpdate) {
                        const { streamingSubtitles: pending } = pendingUpdate;
                        lastMergeTime = Date.now();

                        // Check if we should capture state
                        if (Date.now() - lastCaptureTime >= CAPTURE_THROTTLE_MS) {
                            lastCaptureTime = Date.now();
                            window.dispatchEvent(new CustomEvent(EVENTS.CAPTURE_BEFORE_MERGE, {
                                detail: {
                                    type: 'progressive-merge',
                                    source: 'streaming-update',
                                    segment: segment
                                }
                            }));
                        }

                        // CRITICAL FIX: Merge streaming subtitles with existing timeline
                        setSubtitlesData(current => {
                            const existingSubtitles = current || [];

                            // Filter out existing subtitles that overlap with this segment
                            const nonOverlappingSubtitles = existingSubtitles.filter(sub => {
                                // Keep subtitles that are completely outside the segment boundaries
                                return sub.end <= segment.start || sub.start >= segment.end;
                            });

                            // Merge: existing non-overlapping + new streaming subtitles
                            const mergedStreamingSubtitles = [...nonOverlappingSubtitles, ...pending]
                                .sort((a, b) => a.start - b.start);

                            return mergedStreamingSubtitles;
                        });

                        // Status updates are handled by realtimeProcessor
                        // Only show completion message when streaming ends (handled elsewhere)

                        pendingUpdate = null;
                    }
                }, delay);
            }
        }
    };
};

/**
 * Full-media streaming handler: replaces the entire subtitle list progressively,
 * throttled, with a streaming status message.
 */
export const createFullMediaStreamingHandler = (setSubtitlesData, setStatus) => {
    // Throttled updates: replace entire subtitle list progressively
    let lastUpdate = 0;
    let timer = null;
    const THROTTLE_MS = 400;
    return (streamingSubtitles, isStreaming) => {
        if (!streamingSubtitles) return;
        const now = Date.now();
        const doUpdate = () => {
            lastUpdate = Date.now();
            setSubtitlesData(streamingSubtitles);
            if (isStreaming) {
                setStatus({ message: `Streaming... ${streamingSubtitles.length} subtitles`, type: 'loading' });
            }
        };
        if (now - lastUpdate >= THROTTLE_MS) {
            doUpdate();
        } else {
            clearTimeout(timer);
            timer = setTimeout(doUpdate, THROTTLE_MS - (now - lastUpdate));
        }
    };
};
