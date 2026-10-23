import { showInfoToast } from '../utils/toastUtils';
import { buildOutsideContextText, getSelectedPromptText } from './videoProcessingOptionsHelpers';
import { getEngineType } from '../services/engines/transcriptionEngineRegistry';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { createPromptContext } from './videoProcessingPreferences';
import { getTranscriptionRulesSync } from '../utils/transcriptionRulesStore';

/**
 * Read a video file's duration via a throwaway <video> element, with a 2s cap.
 * Resolves 0 on any failure so callers can fall back gracefully.
 */
const readVideoDuration = (videoFile) => {
    if (!videoFile) return Promise.resolve(0);
    if (isNativeMediaDescriptor(videoFile)) {
        return inspectMediaPipelineAsset(videoFile.assetId)
            .then((inspection) => (
                Number.isInteger(inspection?.durationUs) && inspection.durationUs > 0
                    ? inspection.durationUs / 1_000_000
                    : 0
            ))
            .catch(() => 0);
    }
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
 * Audio + Gemini-new auto-expands the range to the whole video, the run's prompt
 * inputs (including outside-range context) travel as an immutable promptContext,
 * parallel splitting is disabled for retry/audio cases, and retry-from-cache
 * forces the old method with a single request window.
 */
const runVideoProcess = async ({
    selectedSegment,
    isUploading,
    videoFile,
    inlineExtraction,
    retryLock,
    onSelectedSegmentChange,
    useOutsideResultsContext,
    outsideContext,
    fps,
    audioOnly = false,
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
    transcribeOptions = {},
}) => {
    if (!selectedSegment || isUploading) return;

    // The native engine owns audio extraction, windowing, and word-to-cue projection.
    // Do not leak the prompt/video transport settings from another selected method.
    if (['gemini-transcribe', 'gemini-transcribe-live'].includes(method) && !retryLock) {
        const model = method === 'gemini-transcribe-live'
            ? 'gemini-3.5-transcribe-live'
            : 'gemini-3.5-transcribe';
        return onProcess({
            method,
            engine: model,
            model,
            audioOnly: true,
            inlineExtraction: false,
            segment: selectedSegment,
            videoFile,
            windowDurationSecs: transcribeOptions.windowDurationSecs ?? 600,
            maxDurationPerRequest: transcribeOptions.windowDurationSecs ?? 600,
            languageHints: transcribeOptions.languageHints ?? [],
            diarization: method === 'gemini-transcribe' && transcribeOptions.diarization === true,
            bypassCache: true,
        });
    }

    let currentSegment = selectedSegment;

    // Check for audio + Gemini New method condition and adjust segment
    if (!isNativeMediaDescriptor(videoFile) && videoFile?.type?.startsWith('audio/') && !inlineExtraction) {
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

    // The run's prompt inputs travel with the request; the user's stored choices are untouched.
    const promptContext = createPromptContext({
        presetId: selectedPromptPreset,
        customLanguage,
        useTranscriptionRules,
        transcriptionRules: useTranscriptionRules ? getTranscriptionRulesSync() : null,
        outsideContextText: buildOutsideContextText(useOutsideResultsContext, outsideContext),
    });

    // Determine if parallel processing should be disabled (infinite duration)
    const shouldDisableParallelProcessing = (() => {
        if (retryLock) return true;
        if (isNativeMediaDescriptor(videoFile)) return false;
        // Audio with the new (Files API) method is sent as a single request.
        return Boolean(videoFile?.type?.startsWith('audio/')) && !inlineExtraction;
    })();

    const options = {
        audioOnly,
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
        promptContext,
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
