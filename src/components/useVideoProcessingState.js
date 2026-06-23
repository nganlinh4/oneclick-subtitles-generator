import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { showInfoToast } from '../utils/toastUtils';
import { useEngineStatus } from '../hooks/useEngineStatus';
import useModalHeight from './useModalHeight';
import useTokenCounting from './useTokenCounting';
import useStartupMode from './useStartupMode';
import useAsrOptions from './useAsrOptions';
import { getEngineDescriptor, isAsr } from '../services/engines/transcriptionEngineRegistry';
import useTranscriptionRulesAvailability from './useTranscriptionRulesAvailability';
import runVideoProcess from './runVideoProcess';
import {
    buildResolutionOptions,
    buildModelOptions,
    buildPromptPresetOptions,
    buildOutsideContextText,
    computeOutsideContext,
    getSelectedPromptText,
} from './videoProcessingOptionsHelpers';

/**
 * Owns all state, persistence, and derived values for the video processing modal.
 *
 * Extracted from VideoProcessingOptionsModal so the component file stays focused on
 * rendering. Behaviour is preserved verbatim: every piece of state, localStorage
 * sync effect, availability check, and option builder lives here and is returned to
 * the component, which only wires the results into JSX.
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
}) => {
    const { t } = useTranslation();

    // Vercel vs local startup mode (seeded + synced from localStorage)
    const { isVercelMode } = useStartupMode();

    // Per-engine availability (polled) — drives the registry's availability checks.
    const engineStatus = useEngineStatus();

    // Processing method: 'new' (Files API), 'old' (inline), 'nvidia-parakeet'
    const [method, setMethod] = useState(() => {
        const saved = localStorage.getItem('video_processing_method');
        return saved || 'new';
    });

    // First-time method selection overlay
    const [showMethodSelection, setShowMethodSelection] = useState(() => {
        const seen = localStorage.getItem('has_seen_transcription_method_selection');
        return !seen;
    });

    // Back-compat flag for old/new methods
    const [inlineExtraction, setInlineExtraction] = useState(() => {
        // If opened via retry, force old method immediately to avoid any flash of the new method
        const retryMode = sessionStorage.getItem('processing_modal_open_reason') === 'retry-offline';
        const saved = localStorage.getItem('video_processing_inline_extraction');
        return retryMode ? true : (saved === 'true');
    });

    // The current method's descriptor + its availability, and the active local-ASR engine (the selected
    // one, or Parakeet as a stable default while a Gemini method is selected).
    const descriptor = getEngineDescriptor(method) || getEngineDescriptor('new');
    const engineAvailable = descriptor.availability({ engineStatus, isVercelMode });
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

    // Reset to the default method if the selected ASR engine isn't available (covers Parakeet AND every
    // catalog engine going offline). Wait for the first status poll so a saved method isn't reset on load.
    useEffect(() => {
        if (isAsr(method) && !engineStatus.loading && !engineAvailable) {
            setMethod('new');
        }
    }, [engineAvailable, engineStatus.loading, method]);

    // Prevent old method selection in Vercel mode
    useEffect(() => {
        if (isVercelMode && method === 'old') {
            setMethod('new');
        }
    }, [isVercelMode]);

    // Processing options state with localStorage persistence
    const [fps, setFps] = useState(() => {
        const saved = localStorage.getItem('video_processing_fps');
        return saved ? parseFloat(saved) : 0.25; // Default to 0.25 FPS for efficiency
    });
    const [mediaResolution, setMediaResolution] = useState(() => {
        const saved = localStorage.getItem('video_processing_media_resolution');
        return saved || 'low'; // Default to low resolution for efficiency
    });
    const [selectedModel, setSelectedModel] = useState(() => {
        const saved = localStorage.getItem('video_processing_model');
        return saved || 'gemini-2.5-flash';
    });
    const [selectedPromptPreset, setSelectedPromptPreset] = useState(() => {
        // SIMPLE: Just use what's saved in localStorage, always
        const saved = localStorage.getItem('video_processing_prompt_preset');
        return saved || 'settings'; // Default to "Prompt from Settings"
    });

    // Check if user has provided subtitles
    const hasUserProvidedSubtitles = useUserProvidedSubtitles && userProvidedSubtitles && userProvidedSubtitles.trim() !== '';

    const [customLanguage, setCustomLanguage] = useState(() => {
        const saved = localStorage.getItem('video_processing_custom_language');
        return saved || '';
    });
    const [useTranscriptionRules, setUseTranscriptionRules] = useState(() => {
        const saved = localStorage.getItem('video_processing_use_transcription_rules');
        // Default to false - switch is OFF unless explicitly turned on
        return saved !== null ? saved === 'true' : false;
    });
    const transcriptionRulesAvailable = useTranscriptionRulesAvailability(useTranscriptionRules, setUseTranscriptionRules);

    // New: Outside results context toggle state (default ON unless explicitly disabled)
    const [useOutsideResultsContext, setUseOutsideResultsContext] = useState(() => {
        const saved = localStorage.getItem('video_processing_use_outside_context');
        return saved !== 'false';
    });
    const [outsideContextAvailable, setOutsideContextAvailable] = useState(false);

    // Outside context range (1-20, 21 = Unlimited)
    const [outsideContextRange, setOutsideContextRange] = useState(() => {
        const saved = localStorage.getItem('video_processing_outside_context_range');
        const num = saved ? parseInt(saved, 10) : 5;
        return Number.isFinite(num) ? num : 5;
    });

    // Maximum duration per request (in minutes) for parallel processing
    const [maxDurationPerRequest, setMaxDurationPerRequest] = useState(() => {
        const saved = localStorage.getItem('video_processing_max_duration');
        return saved ? parseInt(saved, 10) : 10; // Default to 10 minutes for Gemini
    });

    // Delay between segment processing (in seconds) for Gemini
    const [segmentProcessingDelay, setSegmentProcessingDelay] = useState(() => {
        const saved = localStorage.getItem('segment_processing_delay');
        return saved ? parseInt(saved, 10) : 0; // Default to 0 (all at once)
    });

    // Auto-split subtitles settings (synced with Settings modal)
    const [autoSplitSubtitles, setAutoSplitSubtitles] = useState(() => {
        // Use the same key as Settings modal for consistency
        const saved = localStorage.getItem('show_favorite_max_length');
        // Default to true (enabled) if not previously saved
        return saved !== null ? saved === 'true' : true;
    });

    // Track previous auto-split setting when switching to timing generation
    const [previousAutoSplitSetting, setPreviousAutoSplitSetting] = useState(() => {
        const saved = localStorage.getItem('show_favorite_max_length');
        return saved !== null ? saved === 'true' : true;
    });

    // Track if we're currently in timing generation mode
    const [isInTimingGenerationMode, setIsInTimingGenerationMode] = useState(false);

    // Custom setter for auto-split that handles timing generation mode
    const handleAutoSplitToggle = useCallback((newValue) => {
        if (isInTimingGenerationMode) {
            // If we're in timing generation mode, we still allow manual toggling
            // but we need to update the previous setting so when we exit timing generation,
            // we restore to the user's manual choice
            setPreviousAutoSplitSetting(newValue);
            console.log('[VideoProcessingModal] Manual auto-split toggle in timing generation mode - updated saved state to:', newValue);
        }
        setAutoSplitSubtitles(newValue);
    }, [isInTimingGenerationMode]);

    // Complex logic for timing generation preset and auto-split interaction
    useEffect(() => {
        // Track when we're switching to timing generation
        const isTimingGeneration = selectedPromptPreset === 'timing-generation';
        const wasTimingGeneration = isInTimingGenerationMode;

        if (isTimingGeneration && !wasTimingGeneration) {
            // Switching TO timing generation - save current auto-split state and disable it
            setPreviousAutoSplitSetting(autoSplitSubtitles);
            setAutoSplitSubtitles(false);
            setIsInTimingGenerationMode(true);
            console.log('[VideoProcessingModal] Switched to timing generation - saved auto-split state:', autoSplitSubtitles, 'and disabled it');
        } else if (!isTimingGeneration && wasTimingGeneration) {
            // Switching FROM timing generation - restore previous auto-split state
            setAutoSplitSubtitles(previousAutoSplitSetting);
            setIsInTimingGenerationMode(false);
            console.log('[VideoProcessingModal] Switched from timing generation - restored auto-split state:', previousAutoSplitSetting);
        }
    }, [selectedPromptPreset, autoSplitSubtitles, isInTimingGenerationMode, previousAutoSplitSetting]);

    // Auto-select timing generation preset when subtitles are added (but preserve the above logic)
    useEffect(() => {
        if (isOpen && hasUserProvidedSubtitles) {
            setSelectedPromptPreset('timing-generation');
        }
    }, [isOpen, hasUserProvidedSubtitles]);

    // If timing-generation is selected but unavailable, fall back to 'settings' and restore auto-split
    useEffect(() => {
        if (isOpen && !hasUserProvidedSubtitles && selectedPromptPreset === 'timing-generation') {
            // If we're leaving timing generation due to no subtitles, restore auto-split state
            if (isInTimingGenerationMode) {
                setAutoSplitSubtitles(previousAutoSplitSetting);
                setIsInTimingGenerationMode(false);
            }
            setSelectedPromptPreset('settings');
        }
    }, [isOpen, hasUserProvidedSubtitles, selectedPromptPreset, isInTimingGenerationMode, previousAutoSplitSetting]);

    // Reset timing generation mode when modal closes
    useEffect(() => {
        if (!isOpen) {
            setIsInTimingGenerationMode(false);
        }
    }, [isOpen]);

    const [maxWordsPerSubtitle, setMaxWordsPerSubtitle] = useState(() => {
        const saved = localStorage.getItem('video_processing_max_words');
        return saved ? parseInt(saved, 10) : 12;
    });

    const [customGeminiModels, setCustomGeminiModels] = useState([]);

    // Compute outside-range subtitles context (limited to nearby lines)
    // When opened via retry-from-cache, lock certain controls and force old method
    const [retryLock, setRetryLock] = useState(() => (sessionStorage.getItem('processing_modal_open_reason') === 'retry-offline'));
    const openedInitRef = useRef(false);

    // Initialize lock/reason exactly once per open, even under React StrictMode
    useEffect(() => {
        if (isOpen && !openedInitRef.current) {
            const reason = sessionStorage.getItem('processing_modal_open_reason') || 'unknown';
            const lock = (reason === 'retry-offline');
            setRetryLock(lock);
            if (lock) setInlineExtraction(true);
            openedInitRef.current = true;
        }
    }, [isOpen]);

    // Only clear flags when the modal closes
    useEffect(() => {
        if (!isOpen) {
            openedInitRef.current = false;
            try {
                sessionStorage.removeItem('processing_modal_open_with_retry');
                sessionStorage.removeItem('processing_modal_cached_url');
                sessionStorage.removeItem('processing_modal_open_reason');
            } catch { }
            setRetryLock(false);
        }
    }, [isOpen]);

    const outsideContext = useMemo(
        () => computeOutsideContext(subtitlesData, selectedSegment, outsideContextRange),
        [subtitlesData, selectedSegment, outsideContextRange]
    );
    // Persist range changes
    useEffect(() => {
        const val = outsideContextRange === 21 ? 21 : Math.max(1, Math.min(20, Number(outsideContextRange) || 5));
        localStorage.setItem('video_processing_outside_context_range', String(val));
    }, [outsideContextRange]);

    // Persist max duration per request
    useEffect(() => {
        localStorage.setItem('video_processing_max_duration', maxDurationPerRequest.toString());
    }, [maxDurationPerRequest]);

    // Persist segment processing delay
    useEffect(() => {
        localStorage.setItem('segment_processing_delay', segmentProcessingDelay.toString());
    }, [segmentProcessingDelay]);

    // Persist auto-split settings (synced with Settings modal)
    useEffect(() => {
        localStorage.setItem('show_favorite_max_length', autoSplitSubtitles.toString());
    }, [autoSplitSubtitles]);

    useEffect(() => {
        localStorage.setItem('video_processing_max_words', maxWordsPerSubtitle.toString());
    }, [maxWordsPerSubtitle]);


    // Keep availability and persisted toggle in sync
    useEffect(() => {
        setOutsideContextAvailable(outsideContext.available);
        if (!outsideContext.available && useOutsideResultsContext) {
            setUseOutsideResultsContext(false);
        }
    }, [outsideContext.available]);

    useEffect(() => {
        localStorage.setItem('video_processing_use_outside_context', useOutsideResultsContext ? 'true' : 'false');
    }, [useOutsideResultsContext]);

    const resolutionOptions = buildResolutionOptions(t);
    const modelOptions = buildModelOptions(t, customGeminiModels);


    // Ensure a valid selectable model is chosen whenever the current selection becomes disabled
    useEffect(() => {
        if (!isOpen) return;
        const currentIsDisabled = modelOptions?.some(o => o.value === selectedModel && o.disabled);
        if (currentIsDisabled) {
            // Prefer 2.5 Flash if available, otherwise first non-disabled option
            const preferred = modelOptions.find(o => o.value === 'gemini-2.5-flash' && !o.disabled) ||
                modelOptions.find(o => !o.disabled);
            if (preferred && preferred.value !== selectedModel) {
                setSelectedModel(preferred.value);
            }
        }
    }, [isOpen, selectedModel, modelOptions]);

    // Listen for storage changes to sync auto-split setting
    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'show_favorite_max_length') {
                const newValue = e.newValue === 'true';
                setAutoSplitSubtitles(newValue);
            } else if (e.key === 'video_processing_max_words') {
                const newValue = parseInt(e.newValue, 10) || 10;
                setMaxWordsPerSubtitle(newValue);
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);

    // Load custom models on component mount
    useEffect(() => {
        const loadCustomModels = () => {
            try {
                const savedCustomModels = localStorage.getItem('custom_gemini_models');
                if (savedCustomModels) {
                    setCustomGeminiModels(JSON.parse(savedCustomModels));
                }
            } catch (error) {
                console.error('Error loading custom models:', error);
            }
        };

        loadCustomModels();
    }, []);

    // Auto-adjust FPS when Gemini 2.5 Pro is selected
    useEffect(() => {
        // Check if Gemini 2.5 Pro is selected and FPS is less than 1
        if (selectedModel === 'gemini-2.5-pro' && fps < 1) {
            console.log('[VideoProcessingModal] Gemini 2.5 Pro selected with low FPS, adjusting to 1 FPS for compatibility');
            setFps(1); // Set to minimum 1 FPS for Gemini 2.5 Pro
        }
    }, [selectedModel]); // Only run when model changes

    // Persist processing options to localStorage
    useEffect(() => {
        localStorage.setItem('video_processing_fps', fps.toString());
    }, [fps]);

    useEffect(() => {
        localStorage.setItem('video_processing_media_resolution', mediaResolution);
    }, [mediaResolution]);

    useEffect(() => {
        localStorage.setItem('video_processing_model', selectedModel);
    }, [selectedModel]);

    useEffect(() => {
        // Always persist user preset selections to localStorage
        // This ensures user changes in Rules Editor are maintained
        localStorage.setItem('video_processing_prompt_preset', selectedPromptPreset);
    }, [selectedPromptPreset]);

    // Persist method selection
    useEffect(() => {
        localStorage.setItem('video_processing_method', method);
        // Keep inlineExtraction in sync when user toggles between new/old methods via the dropdown
        if (method === 'new') {
            setInlineExtraction(false);
            localStorage.setItem('video_processing_inline_extraction', 'false');
        } else if (method === 'old') {
            setInlineExtraction(true);
            localStorage.setItem('video_processing_inline_extraction', 'true');
        }
    }, [method]);

    useEffect(() => {
        localStorage.setItem('video_processing_custom_language', customLanguage);
    }, [customLanguage]);

    useEffect(() => {
        localStorage.setItem('video_processing_use_transcription_rules', useTranscriptionRules.toString());
    }, [useTranscriptionRules]);

    // Dispatch toast notification for upload status
    useEffect(() => {
        if (isUploading) {
            showInfoToast(t('processing.uploading', 'Uploading video...'));
        }
    }, [isUploading, t]);

    // Prompt-preset options (closes over t + subtitles availability for the panel)
    const getPromptPresetOptions = () => buildPromptPresetOptions(t, hasUserProvidedSubtitles);

    // Outside-range context text, shared by token counting + submit
    const getOutsideContextText = () => buildOutsideContextText(useOutsideResultsContext, outsideContext);

    // Real + estimated token counting (Gemini countTokens API with estimation fallback)
    const { realTokenCount, displayTokens, isCountingTokens } = useTokenCounting({
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
        // mode flags + current method descriptor/availability
        isVercelMode,
        descriptor,
        engineAvailable,
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
