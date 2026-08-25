/**
 * Progressive full-media updates for the legacy browser surface. A terminal callback publishes
 * immediately and cancels any older throttled partial; callers cancel when provider work settles
 * without such a callback so delayed work cannot overwrite a later result or error.
 */
export const createFullMediaStreamingHandler = (
    setSubtitlesData,
    setStatus,
    t = (_key, fallback) => fallback,
    { rollbackRows = null, rollbackPublisher = setSubtitlesData } = {},
) => {
    let lastUpdate = 0;
    let timer = null;
    let settled = false;
    const THROTTLE_MS = 400;

    const cancelPending = () => {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const publish = (streamingSubtitles, isStreaming) => {
        if (settled) return;
        lastUpdate = Date.now();
        setSubtitlesData(streamingSubtitles);
        if (isStreaming) {
            setStatus({ message: t('output.streamingProgress', 'Streaming...'), type: 'loading' });
        }
    };
    const handler = (streamingSubtitles, isStreaming) => {
        if (settled || !Array.isArray(streamingSubtitles)) return;
        if (isStreaming === false) {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            publish(streamingSubtitles, false);
            return;
        }

        const now = Date.now();
        if (now - lastUpdate >= THROTTLE_MS) {
            publish(streamingSubtitles, isStreaming);
        } else {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                publish(streamingSubtitles, isStreaming);
            }, THROTTLE_MS - (now - lastUpdate));
        }
    };

    handler.cancel = cancelPending;
    handler.rollback = () => {
        cancelPending();
        if (Array.isArray(rollbackRows)) rollbackPublisher(rollbackRows);
    };
    return handler;
};
