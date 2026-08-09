import { PROMPT_PRESETS, getUserPromptPresets } from '../services/gemini';
import { GEMINI_MODELS } from '../config/geminiModels';
import { formatTime } from '../utils/timeFormatter';

/**
 * Pure option/text builders for the video processing modal.
 *
 * Extracted from useVideoProcessingState so the hook stays focused on state and
 * effects. Each function takes the values it needs explicitly (no closures over
 * component state), keeping them unit-testable and side-effect free.
 */

/** Resolution choices with their per-frame token costs. */
export const buildResolutionOptions = (t) => ([
    { value: 'low', label: t('processing.lowRes', 'Low (64 tokens/frame)'), tokens: 64 },
    { value: 'medium', label: t('processing.mediumRes', 'Medium (256 tokens/frame)'), tokens: 256 },
]);

/** All selectable Gemini models (built-in + user custom). */
export const buildModelOptions = (t, customGeminiModels) => {
    const builtInModels = [
        ...GEMINI_MODELS.map(m => ({
            value: m.id,
            label: t(m.settingsLabelKey, m.settingsLabelDefault),
            maxTokens: 1048576
        })),
        { value: 'learnlm-2.0-flash-experimental', label: t('settings.learnlm20FlashExperimental', 'LearnLM 2.0 Flash Experimental (Experimental, advanced learning)'), maxTokens: 1048576 },
        { value: 'gemini-robotics-er-1.6-preview', label: t('settings.geminiRoboticsEr16Preview', 'Gemini Robotics ER 1.6 Preview (Robotics Preview)'), maxTokens: 1048576 }
    ];

    const customModels = customGeminiModels.map(model => ({
        value: model.id,
        label: `${model.name} (Custom)`,
        maxTokens: 1048576, // Default token limit for custom models
        isCustom: true
    }));

    return [...builtInModels, ...customModels];
};

/** All prompt-preset options (settings, timing-generation, built-ins, user presets). */
export const buildPromptPresetOptions = (t, hasUserProvidedSubtitles) => {
    const userPresets = getUserPromptPresets();
    const recommendedPresetId = sessionStorage.getItem('current_session_preset_id');

    const options = [
        {
            id: 'settings',
            title: t('processing.promptFromSettings', 'Prompt from Settings'),
            description: t('processing.promptFromSettingsDesc', 'Use the prompt configured in Settings > Prompts'),
            isDefault: true
        }
    ];

    // Add timing generation option (always shown; disabled if no user-provided subtitles)
    options.push({
        id: 'timing-generation',
        title: t('processing.timingGeneration', 'Timing generation (Subtitles added)'),
        description: hasUserProvidedSubtitles
            ? t('processing.timingGenerationDesc', 'Generate timing for your provided subtitles')
            : t('processing.timingGenerationDescDisabled', 'Add subtitles to enable timing generation'),
        isTimingGeneration: true,
        disabled: !hasUserProvidedSubtitles
    });

    // Add regular presets
    options.push(
        ...PROMPT_PRESETS.map(preset => {
            const baseTitle = preset.id === 'general' ? t('settings.presetGeneralPurpose', 'General purpose') :
                preset.id === 'extract-text' ? t('settings.presetExtractText', 'Extract text') :
                    preset.id === 'focus-lyrics' ? t('settings.presetFocusLyrics', 'Focus on Lyrics') :
                        preset.id === 'describe-video' ? t('settings.presetDescribeVideo', 'Describe video') :
                            preset.id === 'translate-directly' ? t('settings.presetTranslateDirectly', 'Translate directly') :
                                preset.id === 'chaptering' ? t('settings.presetChaptering', 'Chaptering') :
                                    preset.id === 'diarize-speakers' ? t('settings.presetIdentifySpeakers', 'Identify Speakers') :
                                        preset.title;

            // Add "(Recommended by analysis)" if this is the recommended preset
            const title = preset.id === recommendedPresetId
                ? `${baseTitle} ${t('processing.recommendedByAnalysis', '(Recommended by analysis)')}`
                : baseTitle;

            return {
                id: preset.id,
                title,
                description: preset.prompt.substring(0, 80) + '...',
                needsLanguage: preset.id === 'translate-directly'
            };
        }),
        ...userPresets.map(preset => ({
            id: preset.id,
            title: preset.title,
            description: preset.prompt.substring(0, 80) + '...',
            isUserPreset: true
        }))
    );

    return options;
};

/**
 * Build outside-range context text (without heading), to reuse for prompt/session.
 * Returns '' when context is unavailable or the toggle is off.
 */
export const buildOutsideContextText = (useOutsideResultsContext, outsideContext) => {
    if (!useOutsideResultsContext || !outsideContext?.available) return '';
    const fmt = (s) => {
        const st = typeof s.start === 'number' ? s.start : 0;
        const en = typeof s.end === 'number' ? s.end : st;
        return `[${formatTime(st, 'hms')} - ${formatTime(en, 'hms')}] ${s.text}`;
    };
    let ctxText = '';
    if (outsideContext.before.length > 0) {
        ctxText += '\n- Context before selected range:\n';
        outsideContext.before.forEach(s => { ctxText += `  * ${fmt(s)}\n`; });
    }
    if (outsideContext.after.length > 0) {
        ctxText += '\n- Context after selected range:\n';
        outsideContext.after.forEach(s => { ctxText += `  * ${fmt(s)}\n`; });
    }
    return ctxText.trim() ? ctxText : '';
};

/**
 * Compute the nearby before/after subtitles outside the selected range.
 * `outsideContextRange` of 21 means unlimited; otherwise it is clamped to 1-20.
 */
export const computeOutsideContext = (subtitlesData, selectedSegment, outsideContextRange) => {
    if (!Array.isArray(subtitlesData) || !selectedSegment) return { available: false, before: [], after: [] };
    const { start, end } = selectedSegment;

    const overlapsStart = (s) => (typeof s.start === 'number' && typeof s.end === 'number' && s.start < start && s.end > start);
    const overlapsEnd = (s) => (typeof s.start === 'number' && typeof s.end === 'number' && s.start < end && s.end > end);

    const beforeAll = subtitlesData.filter(s => {
        const sStart = (typeof s.start === 'number') ? s.start : 0;
        const sEnd = (typeof s.end === 'number') ? s.end : sStart;
        return (sEnd <= start) || overlapsStart(s);
    });

    const afterAll = subtitlesData.filter(s => {
        const sStart = (typeof s.start === 'number') ? s.start : 0;
        return (sStart >= end) || overlapsEnd(s);
    });

    const limit = outsideContextRange === 21 ? Infinity : Math.max(1, Math.min(20, outsideContextRange || 5));
    const before = beforeAll.slice(-limit);
    const after = afterAll.slice(0, limit);
    const available = before.length > 0 || after.length > 0;
    return { available, before, after };
};

/**
 * Placeholder selected-prompt text. The real prompt is resolved later in
 * promptManagement.js based on the preset id stored in localStorage; this kept
 * for backward compatibility with callers that expect a string.
 */
export const getSelectedPromptText = () => '';
