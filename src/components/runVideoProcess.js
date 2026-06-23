import { showInfoToast } from '../utils/toastUtils';
import { buildOutsideContextText, getSelectedPromptText } from './videoProcessingOptionsHelpers';
import { getEngineType } from '../services/engines/transcriptionEngineRegistry';

/**
 * Read a video file's duration via a throwaway <video> element, with a 2s cap.
 * Resolves 0 on any failure so callers can fall back gracefully.
 */
const readVideoDuration = (videoFile) => {
    if (!videoFile) return Promise.resolve(0);
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => resolve(video.duration || 0);
        video.onerror = () => resolve(0);
        setTimeout(() => resolve(0), 2000); // 2 second timeout
        video.src = URL.createObjectURL(videoFile);
    });
};

/**
 * Assemble the processing options from current modal state and invoke onProcess.
 *
 * Mirrors the original modal's submit handler exactly: audio + Gemini-new auto-
 * expands the range to the whole video, outside-context text is persisted just
 * before processing, parallel splitting is disabled for retry/audio cases, and
 * retry-from-cache forces the old method with a single request window.
 */
const runVideoProcess = async ({
    selectedSegment,
    isUploading,
    videoFile,
    inlineExtraction,
    isVercelMode,
    retryLock,
    onSelectedSegmentChange,
    useOutsideResultsContext,
    outsideContext,
    fps,
    mediaResolution,
    selectedModel,
    displayTokens,
    realTokenCount,
    selectedPromptPreset,
    customLanguage,
    useTranscriptionRules,
    method,
    asrMaxDurationPerRequest,
    maxDurationPerRequest,
    segmentProcessingDelay,
    autoSplitSubtitles,
    maxWordsPerSubtitle,
    asrStrategy,
    asrMaxChars,
    asrMaxWords,
    asrPreserveSentences,
    asrLanguage,
    t,
    onProcess,
}) => {
    if (!selectedSegment || isUploading) return;

    let currentSegment = selectedSegment;

    // Check for audio + Gemini New method condition and adjust segment
    if (videoFile?.type?.startsWith('audio/') && !inlineExtraction) {
        const duration = await readVideoDuration(videoFile);
        if (duration > 0) {
            currentSegment = { start: 0, end: duration };
            if (onSelectedSegmentChange) {
                onSelectedSegmentChange(currentSegment);
            }
            // Show toast notification
            showInfoToast(t('processing.audioRangeAdjusted', 'Audio processing using Gemini new method will auto adjust your range to the whole video'));
        }
    }

    // Persist outside-context text just before processing (user-provided flow reads it in promptManagement)
    try {
        const ctxText = buildOutsideContextText(useOutsideResultsContext, outsideContext);
        if (useOutsideResultsContext && ctxText) {
            localStorage.setItem('video_processing_outside_context_text', ctxText);
            localStorage.setItem('video_processing_use_outside_context', 'true');
        } else {
            localStorage.removeItem('video_processing_outside_context_text');
            // keep the toggle key accurate
            localStorage.setItem('video_processing_use_outside_context', 'false');
        }
    } catch { }

    // Determine if parallel processing should be disabled (infinite duration)
    const shouldDisableParallelProcessing = (() => {
        if (retryLock) return true;
        if (videoFile?.type?.startsWith('audio/')) {
            // In Vercel mode, disable parallel processing for all audio
            if (isVercelMode) return true;
            // In non-Vercel mode, disable parallel processing for audio with new method
            if (!inlineExtraction) return true;
        }
        return false;
    })();

    const options = {
        fps,
        mediaResolution,
        model: selectedModel,
        segment: currentSegment,
        estimatedTokens: displayTokens,
        realTokenCount,
        customPrompt: getSelectedPromptText(), // Include the selected prompt
        promptPreset: selectedPromptPreset,
        customLanguage: selectedPromptPreset === 'translate-directly' ? customLanguage : undefined,
        useTranscriptionRules, // Include the transcription rules setting
        maxDurationPerRequest: shouldDisableParallelProcessing
            ? 999999999 // Very large value to prevent splitting (infinite duration)
            : (getEngineType(method) === 'asr' ? asrMaxDurationPerRequest : maxDurationPerRequest) * 60, // Convert to seconds
        segmentProcessingDelay, // Delay between segment requests (in seconds)
        autoSplitSubtitles,
        maxWordsPerSubtitle,
        inlineExtraction,
        method,
        // Local ASR engine options (segmentation + optional forced language)
        asrStrategy,
        asrMaxChars,
        asrMaxWords: asrStrategy === 'sentence' && asrPreserveSentences ? -1 : asrMaxWords,
        asrLanguage,
        videoFile // Include the video file to ensure it's available
    };

    // In retry-from-cache mode, force old method and prevent further splitting
    if (retryLock) {
        options.inlineExtraction = true;
        // Ensure no parallel splitting: set window >= exact segment length
        const segLenExact = Math.max(0, (selectedSegment?.end || 0) - (selectedSegment?.start || 0));
        const segLenCeil = Math.max(1, Math.ceil(segLenExact + 0.001)); // avoid float rounding to smaller int
        options.maxDurationPerRequest = segLenCeil; // seconds (>= duration) → single request
        options.retryFromCache = true;
    }

    onProcess(options);
};

export default runVideoProcess;
