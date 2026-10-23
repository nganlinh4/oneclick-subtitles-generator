import { useState, useCallback, useEffect, useRef } from 'react';
import { EVENTS, subscribe } from '../events/bus';
import { useQuotaCountdown } from './useQuotaCountdown';
import { useSubtitlesRetryGeneration } from './useSubtitlesRetryGeneration';
import { useNativeSubtitleHydration } from './useNativeSubtitleHydration';
import * as userSubtitlesStore from '../utils/userSubtitlesStore';
import { runSubtitleGeneration } from './runSubtitleGeneration';

// Required-effective async boundary: the lifecycle orchestrator must stay out of the entry chunk.
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');

export const useSubtitles = (t) => {
    const [subtitlesData, setSubtitlesDataState] = useState(null);
    const subtitlesRevisionRef = useRef(0);
    const setSubtitlesData = useCallback((value) => {
        subtitlesRevisionRef.current += 1;
        setSubtitlesDataState(value);
    }, []);
    // A status publication is an event as well as the latest durable value. Keeping an explicit
    // identity lets presentation surfaces consume it once without clearing workflow state, and it
    // still distinguishes two legitimate later publications with identical message/type payloads.
    const [statusPublication, setStatusPublication] = useState(() => ({
        eventId: 0,
        value: { message: '', type: '' },
    }));
    const status = statusPublication.value;
    const statusEventId = statusPublication.eventId;
    const setStatus = useCallback((nextStatus) => {
        setStatusPublication((current) => ({
            eventId: current.eventId + 1,
            value: typeof nextStatus === 'function'
                ? nextStatus(current.value)
                : nextStatus,
        }));
    }, []);
    const [isGenerating, setIsGenerating] = useState(false);
    const currentSourceFileRef = useRef(null);
    const generationPresentationOwnerRef = useRef(null);

    useNativeSubtitleHydration({ setSubtitlesData, revisionRef: subtitlesRevisionRef, t });

    useEffect(() => {
        let subscribe = null;
        try {
            subscribe = userSubtitlesStore?.subscribeCurrentCacheId;
        } catch {
            subscribe = null;
        }
        if (typeof subscribe !== 'function') return undefined;
        const unsubscribe = subscribe((cacheId, previousCacheId) => {
            if (previousCacheId && cacheId !== previousCacheId) {
                generationPresentationOwnerRef.current = null;
            }
        });
        return () => unsubscribe?.();
    }, []);

    // Countdown updater for quota exceeded with retry seconds
    const startQuotaCountdown = useQuotaCountdown({ t, setStatus, isGenerating });

    // Listen for abort events
    useEffect(() => {
        const handleAbort = () => {
            setIsGenerating(false);
            // Update status
            setStatus({ message: t('output.requestsAborted', 'All Gemini requests have been aborted'), type: 'info' });
        };

        // Subscribe via EventBus helper
        const unsubscribe = subscribe(EVENTS.GEMINI_REQUESTS_ABORTED, () => handleAbort());
        return () => unsubscribe();
    }, [setStatus, t]);

    const generateSubtitles = useCallback((input, inputType, apiKeysSet, options = {}) => (
        runSubtitleGeneration({
            t,
            setStatus,
            setSubtitlesData,
            setIsGenerating,
            startQuotaCountdown,
            generationPresentationOwnerRef,
            currentSourceFileRef,
            loadLifecycleOrchestrator,
        }, input, inputType, apiKeysSet, options)
    ), [t, startQuotaCountdown, setStatus, setSubtitlesData]);

    const { retryGeneration } = useSubtitlesRetryGeneration({
        t,
        setStatus,
        setIsGenerating,
        setSubtitlesData,
        currentSourceFileRef
    });

    return {
        subtitlesData,
        setSubtitlesData,
        status,
        statusEventId,
        setStatus,
        isGenerating,
        generateSubtitles,
        retryGeneration
    };
};

export default useSubtitles;
