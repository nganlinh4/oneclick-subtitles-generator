import { useCallback } from 'react';
import { callGeminiApi, setProcessingForceStopped } from '../services/geminiService';
import { getVideoDuration, processMediaFile } from '../utils/videoProcessor';
import { getVideoProcessingFps, getMediaResolution } from '../services/configService';
import { persistRetryResultToCache } from './useSubtitlesCaching';
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  isHighIntelligenceModel,
  normalizeMediaModelId
} from '../config/geminiModels';

/**
 * retryGeneration extracted from useSubtitles.
 *
 * Re-runs a full generation (non-segment) with the same media-type branching:
 * long media via processMediaFile, YouTube inline-extraction streaming, or the
 * default Gemini API call. Behavior is byte-for-byte identical to the original
 * inline implementation; shared state setters/refs are threaded via params.
 */
export const useSubtitlesRetryGeneration = ({
    t,
    setStatus,
    setIsGenerating,
    setSubtitlesData,
    currentSourceFileRef
}) => {
    const retryGeneration = useCallback(async (input, inputType, apiKeysSet, options = {}) => {
        const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
        // Extract options
        const { userProvidedSubtitles } = options;
        if (!apiKeysSet.gemini) {
            setStatus({ message: t('errors.apiKeyRequired'), type: 'error' });
            return false;
        }

        // Reset the force stop flag when retrying generation
        setProcessingForceStopped(false);

        setIsGenerating(true);
        setStatus({ message: 'Retrying request to Gemini. This may take a few minutes...', type: 'loading' });

        try {
            let subtitles;

            // Check if this is a long media file (video or audio) that needs special processing
            if (input.type && (input.type.startsWith('video/') || input.type.startsWith('audio/'))) {
                try {
                    const duration = await getVideoDuration(input);
                    // eslint-disable-next-line no-unused-vars
                    const durationMinutes = Math.floor(duration / 60);

                    // Determine if this is a video or audio file
                    const isAudio = input.type.startsWith('audio/');
                    // eslint-disable-next-line no-unused-vars
                    const mediaType = isAudio ? 'audio' : 'video';

                    // Debug log to see the media duration


                    // Use the new smart processing function that chooses between simplified and legacy
                    subtitles = await processMediaFile(input, setStatus, t, { userProvidedSubtitles });
                } catch (error) {
                    console.error('Error checking media duration:', error);
                    // Fallback to normal processing (respect inlineExtraction for non-YouTube)
                    const forceInline = options.inlineExtraction === true && inputType !== 'youtube';
                    subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, ...(forceInline ? { forceInline: true } : {}), runId });
                }
            } else {
                // YouTube flow: video is already downloaded and loaded in the app
                if (options.inlineExtraction === true) {
                    // Try to obtain the already-loaded blob without re-downloading
                    const blobUrl = localStorage.getItem('current_video_url');
                    let ytFile = null;
                    try {
                        if (blobUrl && blobUrl.startsWith('blob:')) {
                            if (typeof window !== 'undefined' && window.__videoBlobMap && window.__videoBlobMap[blobUrl]) {
                                const blob = window.__videoBlobMap[blobUrl];
                                ytFile = new File([blob], 'youtube.mp4', { type: blob.type || 'video/mp4' });
                            } else {
                                // Fetching a blob: URL stays in-memory, not a network download
                                const blob = await fetch(blobUrl).then(r => r.blob());
                                ytFile = new File([blob], 'youtube.mp4', { type: blob.type || 'video/mp4' });
                            }
                        }
                    } catch (e) {
                        console.warn('Inline YouTube: failed to access current blob URL, falling back:', e);
                        // Remember source file for retries
                        currentSourceFileRef.current = ytFile;

                    }

                    if (ytFile) {
                        // Stream full video unconditionally
                        const { getVideoDuration } = await import('../utils/videoProcessing');
                        const { processGeminiSegment } = await import('../services/engines/GeminiAdapter');
                        const duration = await getVideoDuration(ytFile);
                        const fullSegment = { start: 0, end: duration || 0 };
                        // Derive streaming options for YouTube retry
                        const fps = options.fps ?? getVideoProcessingFps();
                        const mediaResolution = options.mediaResolution ?? getMediaResolution();
                        const model = normalizeMediaModelId(
                            options.model ?? localStorage.getItem('gemini_model'),
                            DEFAULT_TRANSCRIPTION_MODEL_ID
                        );

                        subtitles = await processGeminiSegment(
                            ytFile,
                            fullSegment,
                            {
                                fps,
                                mediaResolution,
                                model,
                                userProvidedSubtitles,
                                maxDurationPerRequest: options.maxDurationPerRequest,
                                autoSplitSubtitles: options.autoSplitSubtitles,
                                maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                                forceInline: true,
                                runId
                            },
                            { onStatus: setStatus, onStreamingUpdate: (streamingSubtitles) => setSubtitlesData(streamingSubtitles), t }
                        );
                    } else {
                        // Fallback: proceed without forcing inline (no re-download)
                        subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, runId });
                    }
                } else {
                    // Default YouTube path
                    subtitles = await callGeminiApi(input, inputType, { userProvidedSubtitles, runId });
                }
            }

            setSubtitlesData(subtitles);

            // Cache the new results using unified approach (URL-based vs file-based)
            await persistRetryResultToCache({ input, inputType, subtitles });

            const currentModel = normalizeMediaModelId(
                localStorage.getItem('gemini_model'),
                DEFAULT_TRANSCRIPTION_MODEL_ID
            );
            const isUsingStrongModel = isHighIntelligenceModel(currentModel);

            // Show different success message based on model
            if (isUsingStrongModel && (!subtitles || subtitles.length === 0)) {
                setStatus({ message: t('output.strongModelSuccess'), type: 'warning' });
            } else {
                setStatus({ message: t('output.generationSuccess'), type: 'success' });
            }
            return true;
        } catch (error) {
            console.error('Error regenerating subtitles:', error);

            // Check for specific Gemini API errors
            if (error.message && (
                (error.message.includes('503') && error.message.includes('Service Unavailable')) ||
                error.message.includes('The model is overloaded')
            )) {
                // Use specific 503 error message if it's a 503 error
                const is503Error = error.message.includes('503');
                const errorMessage = is503Error
                    ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
                    : t('errors.geminiOverloaded', 'Strong model tends to get overloaded, please consider using other model and try again, or try lower the segment duration. Or create a new Google Cloud Project and get an API Key.');
                setStatus({ message: errorMessage, type: 'error' });
            } else if (error.message && error.message.toLowerCase().includes('token') && error.message.toLowerCase().includes('exceeds the maximum')) {
                const tokenMatch = error.message.match(/input token count\s*\((\d+)\)\s*exceeds the maximum number of tokens allowed\s*\((\d+)\)/i);
                if (tokenMatch) {
                    const required = tokenMatch[1];
                    const limit = tokenMatch[2];
                    setStatus({ message: t('errors.tokenLimitExceededCounts', 'The video segment is too large for Gemini to process (required {{required}} tokens, limit {{limit}} tokens). Please reduce FPS/quality or shorten each request and try again.', { required, limit }), type: 'error' });
                } else {
                    setStatus({ message: t('errors.tokenLimitExceeded'), type: 'error' });
                }
            } else if (error.message && error.message.includes('File size') && error.message.includes('exceeds the recommended maximum')) {
                // Extract file size and max size from error message
                const sizeMatch = error.message.match(/(\d+)MB\) exceeds the recommended maximum of (\d+)MB/);
                if (sizeMatch && sizeMatch.length >= 3) {
                    const size = sizeMatch[1];
                    const maxSize = sizeMatch[2];
                    setStatus({
                        message: t('errors.fileSizeTooLarge', 'File size ({{size}}MB) exceeds the recommended maximum of {{maxSize}}MB. Please use a smaller file or lower quality video.', { size, maxSize }),
                        type: 'error'
                    });
                } else {
                    setStatus({ message: error.message, type: 'error' });
                }
            } else {
                setStatus({ message: `Error: ${error.message}`, type: 'error' });
            }
            return false;
        } finally {
            setIsGenerating(false);
        }
    }, [t]);

    return { retryGeneration };
};
