/**
 * Language detection functionality for Gemini API
 */

import { createLanguageDetectionSchema } from '../../utils/schemaUtils';
import i18n from '../../i18n/i18n';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { DEFAULT_FAST_TEXT_MODEL_ID } from '../../config/geminiModels';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import {
    acknowledgeProjectSubtitleLanguage,
    captureProjectSubtitleLanguage,
    loadProjectSubtitleLanguage,
    normalizeProjectLanguageResult,
    persistProjectSubtitleLanguage,
} from '../../platform/projectSubtitleLanguageStore';

const dispatchDetectionError = (error, source) => {
    const message = error instanceof Error ? error.message : String(error);
    window.dispatchEvent(new CustomEvent('language-detection-error', {
        detail: { error: message, source }
    }));
};

const publishDetection = (result, source) => {
    window.dispatchEvent(new CustomEvent('language-detection-complete', {
        detail: { result, source }
    }));
    return result;
};

/**
 * Detect language of text using Gemini API
 * @param {Array} subtitles - Array of subtitles to detect language from
 * @param {string} source - Source of subtitles ('original' or 'translated')
 * @param {string} model - Gemini model to use
 * @returns {Promise<Object|null>} - Valid language detection result, or null on refusal
 */
export const detectSubtitleLanguage = async (subtitles, source = 'original', model = DEFAULT_FAST_TEXT_MODEL_ID) => {
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
        dispatchDetectionError(new Error('No subtitles are available for language detection'), source);
        return null;
    }

    try {
        const restored = await loadProjectSubtitleLanguage({
            sourceType: source,
            subtitles,
        });
        if (restored !== null) return publishDetection(restored.result, source);

        const context = await captureProjectSubtitleLanguage({
            sourceType: source,
            subtitles,
        });
        // Take the first 3 subtitles for language detection
        const sampleSubtitles = subtitles.slice(0, 3);
        if (sampleSubtitles.some((subtitle) => (
            !subtitle
            || typeof subtitle !== 'object'
            || typeof subtitle.text !== 'string'
        ))) {
            throw new Error('Subtitles are malformed for language detection');
        }
        const sampleText = sampleSubtitles.map(subtitle => subtitle.text.trim()).filter(Boolean).join('\n');
        if (sampleText.length === 0) {
            throw new Error('Subtitle text is empty for language detection');
        }

        // Create the prompt for language detection
        const detectionPrompt = `Analyze the following text and determine its language. Identify the primary language and any secondary languages if present.

Text to analyze:
"""
${sampleText}
"""`;

        const responseSchema = createLanguageDetectionSchema();

        // Dispatch event to update UI with status
        window.dispatchEvent(new CustomEvent('language-detection-status', {
            detail: {
                message: i18n.t('narration.detectingLanguage', 'Detecting language...'),
                source: source
            }
        }));

        const thinking = getThinkingBudget(model);
        const nativeResult = await runNativeGeminiText({
            task: 'analyzeSubtitles',
            model,
            prompt: detectionPrompt,
            responseJsonSchema: responseSchema,
            ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
            projectId: context.projectId,
            expectedProjectStateVersion: context.projectStateVersion,
        });
        if (typeof nativeResult?.text !== 'string'
            || typeof nativeResult?.acknowledge !== 'function'
            || typeof nativeResult?.job?.id !== 'string'
            || typeof nativeResult?.deliveryId !== 'string') {
            throw new Error('Language detection returned no structured result');
        }
        let decoded;
        try {
            decoded = JSON.parse(nativeResult.text);
        } catch {
            throw new Error('Language detection returned malformed JSON');
        }
        const result = normalizeProjectLanguageResult(decoded);
        const receipt = await persistProjectSubtitleLanguage(context, {
            result,
            job: nativeResult.job,
            deliveryId: nativeResult.deliveryId,
            acknowledge: nativeResult.acknowledge,
        });
        const record = await acknowledgeProjectSubtitleLanguage(receipt);
        return publishDetection(record.result, source);
    } catch (error) {
        console.error('Error detecting language:', error);

        dispatchDetectionError(error, source);
        return null;
    }
};

/**
 * Get appropriate narration model for a language
 * This is a synchronous fallback function that doesn't check actual availability
 * @param {string|Array} languageCode - ISO 639-1 language code or array of codes
 * @returns {string} - Model ID for the language
 */
export const getNarrationModelForLanguage = (languageCode) => {
    // Default to base model
    let modelId = 'f5tts-v1-base';

    // If we have an array of language codes, use the first one that has a specific model
    if (Array.isArray(languageCode) && languageCode.length > 0) {
        // Priority languages that have specific models
        const priorityLanguages = ['vi', 'zh', 'en', 'ko', 'ja'];

        // Try to find a priority language in the array
        for (const lang of priorityLanguages) {
            if (languageCode.includes(lang)) {
                return getNarrationModelForLanguage(lang);
            }
        }

        // If no priority language found, use the first language in the array
        return getNarrationModelForLanguage(languageCode[0]);
    }

    // Map language codes to appropriate models
    // This is a simplified mapping that doesn't check actual availability
    switch (languageCode) {
        case 'zh':
            modelId = 'f5tts-v1-base'; // Chinese is well-supported by base model
            break;
        case 'en':
            modelId = 'f5tts-v1-base'; // English is well-supported by base model
            break;
        case 'vi':
            modelId = 'erax-smile-unixsex-f5'; // Vietnamese model
            break;
        case 'ko':
            modelId = 'f5tts-v1-base'; // Korean - fallback to base model
            break;
        case 'ja':
            modelId = 'f5tts-v1-base'; // Japanese - fallback to base model
            break;
        default:
            // For other languages, use the base model
            modelId = 'f5tts-v1-base';
    }

    return modelId;
};
