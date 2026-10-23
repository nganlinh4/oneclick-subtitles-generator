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

const LANGUAGE_SAMPLE_ROWS = 24;
const LANGUAGE_SAMPLE_CHARACTERS = 12_000;

export const representativeSubtitleSample = (subtitles) => {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return '';
    const count = Math.min(LANGUAGE_SAMPLE_ROWS, subtitles.length);
    const indices = count === 1
        ? [0]
        : Array.from({ length: count }, (_, index) => (
            Math.round(index * (subtitles.length - 1) / (count - 1))
        ));
    const rows = [];
    let characters = 0;
    for (const index of [...new Set(indices)]) {
        const text = subtitles[index]?.text;
        if (typeof text !== 'string') throw new Error('Subtitles are malformed for language detection');
        const trimmed = text.trim();
        if (!trimmed) continue;
        const remaining = LANGUAGE_SAMPLE_CHARACTERS - characters;
        if (remaining <= 0) break;
        const bounded = [...trimmed].slice(0, remaining).join('');
        rows.push(bounded);
        characters += [...bounded].length;
    }
    return rows.join('\n');
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
        const sampleText = representativeSubtitleSample(subtitles);
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

