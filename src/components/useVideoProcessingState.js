import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { showInfoToast } from '../utils/toastUtils';
import useModalHeight from './useModalHeight';
import useTokenCounting from './useTokenCounting';
import useAsrOptions from './useAsrOptions';
import { getEngineDescriptor, isAsr } from '../services/engines/transcriptionEngineRegistry';
import useTranscriptionRulesAvailability from './useTranscriptionRulesAvailability';
import runVideoProcess from './runVideoProcess';
import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../config/geminiModels';
import {
    buildResolutionOptions,
    buildModelOptions,
    buildPromptPresetOptions,
    buildOutsideContextText,
    computeOutsideContext,
    getSelectedPromptText,
} from './videoProcessingOptionsHelpers';
import {
    effectivePromptPreset,
    isTimingGenerationPreset,
    writeProcessingMethod,
} from './videoProcessingPreferences';
import { readPreference, usePreference } from '../platform/preferences/store';

const firstSelectableModel = (modelOptions, selectedModel) => {
    if (!modelOptions?.some((option) => option.value === selectedModel && option.disabled)) {
        return selectedModel;
    }
    const preferred = modelOptions.find((option) => (
        option.value === DEFAULT_TRANSCRIPTION_MODEL_ID && !option.disabled
    )) || modelOptions.find((option) => !option.disabled);
    return preferred ? preferred.value : selectedModel;
};

/**
 * Owns all state, persistence, and derived values for the video processing modal.
 *
 * Stored choices come from the preference store. Values the modal derives for a run (timing
 * generation forcing auto-split off, context or rules that are unavailable, a disabled model)
 * are computed here and never written back over the user's choices.
 */
const useVideoProcessingState = ({
    isOpen,
    onClose,
    isUploading,
    videoFile,
    userProvidedSubtitles,
    useUserProvidedSubtitles,
    subtitlesData,
    onSelectedSegmentChange,
    selectedSegment,
    onProcess,
    transcribeOptions,
}) => {
    const { t } = useTranslation();

    // Processing method: 'new' (Files API), 'old' (inline), or a local/live engine id.
    const [storedMethod] = usePreference('video_processing_method');
    const method = getEngineDescriptor(storedMethod) ? storedMethod : 'new';
    const setMethod = useCallback((nextMethod) => {
        writeProcessingMethod(
            typeof nextMethod === 'function' ? nextMethod(readPreference('video_processing_method')) : nextMethod
        );
    }, []);
    // The old Gemini method is the inline-extraction one.
    const inlineExtraction = method === 'old';

    // First-time method selection overlay
    const [showMethodSelection, setShowMethodSelection] = useState(
        () => !readPreference('has_seen_transcription_method_selection')
    );

    // The current method's descriptor and the active local-ASR engine (the selected one, or Parakeet
    // as a stable default while a Gemini method is selected).
    const descriptor = getEngineDescriptor(method) || getEngineDescriptor('new');
    const activeAsrEngineId = isAsr(method) ? method : 'nvidia-parakeet';
    const activeAsrDescriptor = getEngineDescriptor(activeAsrEngineId) || {};

    // Generic per-engine ASR options + supported-languages drag-scroll (shared by all local ASR engines).
    const {
        languagesRef,
        strategy: asrStrategy,
        setStrategy: setAsrStrategy,
        maxChars: asrMaxChars,
        setMaxChars: setAsrMaxChars,
        maxWords: asrMaxWords,
        setMaxWords: setAsrMaxWords,
        preserveSentences: asrPreserveSentences,
        setPreserveSentences: setAsrPreserveSentences,
        maxDurationPerRequest: asrMaxDurationPerRequest,
        setMaxDurationPerRequest: setAsrMaxDurationPerRequest,
        language: asrLanguage,
        setLanguage: setAsrLanguage,
    } = useAsrOptions(activeAsrEngineId, {
        hasLanguagesBadges: !!activeAsrDescriptor.supportedLanguagesBadges,
        defaultStrategy: activeAsrDescriptor.defaultStrategy || 'sentence',
    });

    // Smooth modal height transitions (refs + content-change/open effects)
    const { modalRef, contentRef } = useModalHeight(isOpen, method);

    const [audioOnly, setAudioOnly] = usePreference('video_processing_audio_only');
    const [fps, setFps] = usePreference('video_processing_fps');
    const [mediaResolution, setMediaResolution] = usePreference('video_processing_media_resolution');
    const [storedModel, setSelectedModel] = usePreference('video_processing_model');
    const [storedPromptPreset, setStoredPromptPreset] = usePreference('video_processing_prompt_preset');
    const [customLanguage, setCustomLanguage] = usePreference('video_processing_custom_language');
    const [storedUseTranscriptionRules, setUseTranscriptionRules] = usePreference(
        'video_processing_use_transcription_rules'
    );
    const [storedUseOutsideContext, setUseOutsideResultsContext] = usePreference(
        'video_processing_use_outside_context'
    );
    const [outsideContextRange, setOutsideContextRange] = usePreference(
        'video_processing_outside_context_range'
    );
    // Maximum duration per request (minutes) and the delay between segment requests (seconds).
    const [maxDurationPerRequest, setMaxDurationPerRequest] = usePreference('video_processing_max_duration');
    const [segmentProcessingDelay, setSegmentProcessingDelay] = usePreference('segment_processing_delay');
    // Auto-split and its word limit are the Settings modal's own values (native settings).
    const [storedAutoSplit, setStoredAutoSplit] = usePreference('show_favorite_max_length');
    const [maxWordsPerSubtitle, setMaxWordsPerSubtitle] = usePreference('video_processing_max_words');

    const hasUserProvidedSubtitles = Boolean(
        useUserProvidedSubtitles && userProvidedSubtitles && userProvidedSubtitles.trim() !== ''
    );

    // Opening the modal with user-provided subtitles proposes timing generation for this session
    // only; an explicit preset choice replaces the proposal and is the one that gets stored.
    const [proposedPreset, setProposedPreset] = useState(null);
    useEffect(() => {
        setProposedPreset(isOpen && hasUserProvidedSubtitles ? 'timing-generation' : null);
    }, [isOpen, hasUserProvidedSubtitles]);
    const setSelectedPromptPreset = useCallback((preset) => {
        setProposedPreset(null);
        setStoredPromptPreset(preset);
    }, [setStoredPromptPreset]);
    const selectedPromptPreset = effectivePromptPreset(
        proposedPreset ?? storedPromptPreset,
        hasUserProvidedSubtitles,
    );

    // Timing generation keeps the existing cue boundaries, so it runs without auto-split unless
    // the user turns auto-split on again while that preset is selected.
    const timingGeneration = isTimingGenerationPreset(selectedPromptPreset);
    const [autoSplitChosenForTiming, setAutoSplitChosenForTiming] = useState(false);
    useEffect(() => {
        if (!timingGeneration || !isOpen) setAutoSplitChosenForTiming(false);
    }, [timingGeneration, isOpen]);
    const autoSplitSubtitles = timingGeneration && !autoSplitChosenForTiming ? false : storedAutoSplit;
    const handleAutoSplitToggle = useCallback((enabled) => {
        if (timingGeneration) setAutoSplitChosenForTiming(true);
        setStoredAutoSplit(enabled);
    }, [setStoredAutoSplit, timingGeneration]);

    const transcriptionRulesAvailable = useTranscriptionRulesAvailability();
    const useTranscriptionRules = storedUseTranscriptionRules && transcriptionRulesAvailable;

    // The former retry-from-browser-cache mode has no native artifact owner and was removed.
    const retryLock = false;

    // Only clear flags when the modal closes
    useEffect(() => {
        if (!isOpen) {
            try {
                sessionStorage.removeItem('processing_modal_open_with_retry');
                sessionStorage.removeItem('processing_modal_open_reason');
            } catch {
                // Session cleanup remains best effort when storage is unavailable.
            }
        }
    }, [isOpen]);

    const outsideContext = useMemo(
        () => computeOutsideContext(subtitlesData, selectedSegment, outsideContextRange),
        [subtitlesData, selectedSegment, outsideContextRange]
    );
    const outsideContextAvailable = outsideContext.available;
    const useOutsideResultsContext = storedUseOutsideContext && outsideContextAvailable;

    const resolutionOptions = buildResolutionOptions(t);
    const modelOptions = buildModelOptions(t);
    const selectedModel = firstSelectableModel(modelOptions, storedModel);

    // Dispatch toast notification for upload status
    useEffect(() => {
        if (isUploading) {
            showInfoToast(t('processing.uploading', 'Uploading video...'));
        }
    }, [isUploading, t]);

    // Prompt-preset options (closes over t + subtitles availability for the panel)
    const getPromptPresetOptions = () => buildPromptPresetOptions(t, hasUserProvidedSubtitles).map(option => ({
        ...option,
        disabled: option.disabled || ((audioOnly || videoFile?.type?.startsWith('audio/'))
            && ['extract-text', 'describe-video'].includes(option.id)),
    }));

    // Outside-range context text, shared by token counting + submit
    const getOutsideContextText = () => buildOutsideContextText(useOutsideResultsContext, outsideContext);

    // Real + estimated token counting (Gemini countTokens API with estimation fallback)
    const { realTokenCount, displayTokens, isCountingTokens } = useTokenCounting({
        audioOnly,
        isOpen,
        videoFile,
        selectedSegment,
        fps,
        mediaResolution,
        selectedModel,
        selectedPromptPreset,
        customLanguage,
        useTranscriptionRules,
        method,
        maxDurationPerRequest,
        resolutionOptions,
        buildOutsideContextText: getOutsideContextText,
        getSelectedPromptText,
    });

    const selectedModelData = modelOptions.find(m => m.value === selectedModel);
    const isWithinLimit = displayTokens <= (selectedModelData?.maxTokens || 1048576);

    // Handle form submission — delegates to the runVideoProcess builder/dispatcher
    const handleProcess = () => runVideoProcess({
        transcribeOptions,
        audioOnly,
        selectedSegment,
        isUploading,
        videoFile,
        inlineExtraction,
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
    });

    // Handle escape key and outside clicks
    useEffect(() => {
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            return () => document.removeEventListener('keydown', handleEscape);
        } else {
            // Clear recommendation tracking when modal closes
            sessionStorage.removeItem('last_applied_recommendation');
        }
    }, [isOpen, onClose]);

    return {
        // refs
        modalRef,
        contentRef,
        languagesRef,
        // current method descriptor
        descriptor,
        method,
        setMethod,
        showMethodSelection,
        setShowMethodSelection,
        inlineExtraction,
        retryLock,
        // generic ASR options (shared by all local ASR engines)
        asrStrategy,
        setAsrStrategy,
        asrMaxChars,
        setAsrMaxChars,
        asrMaxWords,
        setAsrMaxWords,
        asrPreserveSentences,
        setAsrPreserveSentences,
        asrMaxDurationPerRequest,
        setAsrMaxDurationPerRequest,
        asrLanguage,
        setAsrLanguage,
        // gemini options
        fps,
        setFps,
        mediaResolution,
        setMediaResolution,
        audioOnly,
        setAudioOnly,
        selectedModel,
        setSelectedModel,
        selectedPromptPreset,
        setSelectedPromptPreset,
        customLanguage,
        setCustomLanguage,
        useTranscriptionRules,
        setUseTranscriptionRules,
        transcriptionRulesAvailable,
        useOutsideResultsContext,
        setUseOutsideResultsContext,
        outsideContextAvailable,
        outsideContextRange,
        setOutsideContextRange,
        maxDurationPerRequest,
        setMaxDurationPerRequest,
        segmentProcessingDelay,
        setSegmentProcessingDelay,
        autoSplitSubtitles,
        handleAutoSplitToggle,
        maxWordsPerSubtitle,
        setMaxWordsPerSubtitle,
        // derived
        resolutionOptions,
        modelOptions,
        getPromptPresetOptions,
        selectedModelData,
        isWithinLimit,
        realTokenCount,
        displayTokens,
        isCountingTokens,
        // actions
        handleProcess,
    };
};

export default useVideoProcessingState;
