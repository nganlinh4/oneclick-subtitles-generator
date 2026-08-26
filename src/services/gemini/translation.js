/**
 * Translation functionality for Gemini API
 */

import i18n from '../../i18n/i18n';
import { createTranslationSchema } from '../../utils/schemaUtils';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import { formatSubtitles, formatSubtitlesWithChain } from './translationChainFormatter';
import { PartialTranslationError, translateSubtitlesByChunks } from './translationChunkProcessor';
import { processTranslationResponse } from './translationResponseParser';
import { buildTranslationPrompt } from './translationPromptBuilder';
import { buildTranslatedSubtitles } from './translationSubtitleBuilder';
import { DEFAULT_TRANSLATION_MODEL_ID } from '../../config/geminiModels';
import {
    createTranslationAbortError,
    normalizeRunnableLanguageChain,
} from '../../utils/translationOwnership';

const canonicalSourceId = (subtitle, index) => {
    if (typeof subtitle?.originalId === 'string' && subtitle.originalId.length > 0) {
        return subtitle.originalId;
    }
    const rawId = subtitle?.id ?? subtitle?.subtitle_id;
    if (typeof rawId === 'string' && rawId.length > 0) return `string:${rawId}`;
    if (Number.isSafeInteger(rawId)) return `number:${rawId}`;
    return `ordinal:${index}`;
};

const captureSourceRows = (subtitles) => {
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
        throw new TypeError('No subtitles to translate');
    }
    const sourceIds = new Set();
    return Object.freeze(subtitles.map((subtitle, index) => {
        if (!subtitle || typeof subtitle !== 'object'
            || typeof subtitle.text !== 'string'
            || !Number.isFinite(subtitle.start)
            || !Number.isFinite(subtitle.end)
            || subtitle.start < 0
            || subtitle.end < subtitle.start) {
            throw new TypeError('Translation source rows are invalid');
        }
        const originalId = canonicalSourceId(subtitle, index);
        if (sourceIds.has(originalId)) {
            throw new TypeError('Translation source row IDs must be unique');
        }
        sourceIds.add(originalId);
        return Object.freeze({
            ...(subtitle.id !== undefined ? { id: subtitle.id } : {}),
            ...(subtitle.subtitle_id !== undefined ? { subtitle_id: subtitle.subtitle_id } : {}),
            start: subtitle.start,
            end: subtitle.end,
            text: subtitle.text,
            ...(subtitle.startTime !== undefined ? { startTime: subtitle.startTime } : {}),
            ...(subtitle.endTime !== undefined ? { endTime: subtitle.endTime } : {}),
            originalId,
            sourceOrder: Number.isSafeInteger(subtitle.sourceOrder)
                ? subtitle.sourceOrder
                : index,
        });
    }));
};

const requestedLanguageIds = (targetLanguage) => {
    const values = Array.isArray(targetLanguage) ? targetLanguage : [targetLanguage];
    const ids = values.map((value) => {
        if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
            throw new TypeError('Translation language IDs must be non-blank strings');
        }
        return value;
    });
    const folded = ids.map((id) => id.toLocaleLowerCase('en-US'));
    if (new Set(folded).size !== ids.length) {
        throw new TypeError('Translation language IDs must be unique');
    }
    return Object.freeze(ids);
};

const deliveryForResult = (result) => {
    if (typeof result?.acknowledge !== 'function') return null;
    return Object.freeze({
        jobId: result.job?.id ?? null,
        deliveryId: result.deliveryId ?? null,
        acknowledge: result.acknowledge,
    });
};

const completeTranslationResult = (rows, deliveries) => Object.freeze({
    status: 'complete',
    rows: Object.freeze([...rows]),
    deliveries: Object.freeze([...deliveries]),
});

const appendIdentityContract = (prompt, languageIds, sourceRows) => `${prompt}

MANDATORY IDENTITY CONTRACT (this overrides any conflicting output-format instruction above):
- Return only one JSON object matching the supplied response schema.
- schemaVersion must be 1.
- Emit each requested languageId exactly once, in this exact order: ${JSON.stringify(languageIds)}.
- For every language, emit every source row exactly once, in this exact order.
- Copy sourceId and original exactly; never translate, normalize, omit, duplicate, or reorder them.
- translated must contain non-blank provider-produced text. Never substitute a language label or source text for a missing translation.
Authoritative source rows: ${JSON.stringify(sourceRows.map((row) => ({
    sourceId: row.originalId,
    original: row.text,
})))}`;

/**
 * Translate subtitles to different language(s) while preserving timing
 * @param {Array} subtitles - Subtitles to translate
 * @param {string|Array} targetLanguage - Target language(s)
 * @param {string} model - Gemini model to use
 * @param {string|null} customPrompt - Custom prompt for translation
 * @param {number} splitDuration - Duration in minutes for each chunk (0 = no split)
 * @param {boolean} includeRules - Whether to include transcription rules in the prompt
 * @param {string|null} delimiter - Delimiter to use for multiple languages
 * @param {boolean} useParentheses - Whether to use parentheses for the second language
 *                                  For 2 languages, both delimiter and brackets can be used together
 *                                  For 3+ languages, only delimiter is used
 * @param {Object} bracketStyle - Optional bracket style { open, close }
 * @param {Array} chainItems - Optional chain items for chain-based formatting
 * @returns {Promise<Array>} - Array of translated subtitles
 */
const translateSubtitles = async (subtitles, targetLanguage, model = DEFAULT_TRANSLATION_MODEL_ID, customPrompt = null, splitDuration = 0, includeRules = false, delimiter = ' ', useParentheses = false, bracketStyle = null, chainItems = null, fileContext = null, preserveOriginalSubtitlesMap = false, ownership = {}, inheritedDeliverySink = null) => {
    const localController = ownership.signal ? null : new AbortController();
    const signal = ownership.signal ?? localController.signal;
    const assertOwned = typeof ownership.assertOwned === 'function'
        ? ownership.assertOwned
        : async () => {};
    const publishOwnedStatus = typeof ownership.publishStatus === 'function'
        ? ownership.publishStatus
        : async () => {};
    const assertBoundary = async () => {
        if (signal.aborted) throw createTranslationAbortError();
        await assertOwned();
        if (signal.aborted) throw createTranslationAbortError();
    };
    const publishStatus = async (message) => {
        await assertBoundary();
        await publishOwnedStatus(message);
        await assertBoundary();
        try {
            window.dispatchEvent(new CustomEvent('translation-status', {
                detail: {
                    message,
                    ...(ownership.statusOwner ?? {}),
                }
            }));
        } catch {
            // Status notifications are compatibility-only and cannot own the run.
        }
        await assertBoundary();
    };
    await assertBoundary();

    const sourceSubtitles = captureSourceRows(subtitles);
    const deliverySink = inheritedDeliverySink ?? [];

    // Check if we're in format mode (empty target languages array)
    const isFormatMode = Array.isArray(targetLanguage) && targetLanguage.length === 0;

    const languageIds = isFormatMode ? Object.freeze([]) : requestedLanguageIds(targetLanguage);
    const runnableChainItems = isFormatMode && Array.isArray(chainItems)
        ? normalizeRunnableLanguageChain(chainItems, { formatOnly: true })
        : chainItems;
    if (isFormatMode && Array.isArray(runnableChainItems) && runnableChainItems.some((item) => (
        item?.type === 'language' && !item.isOriginal
    ))) {
        throw new TypeError('Format-only translation cannot fabricate a target-language value');
    }

    // Determine if we're doing multi-language translation
    const isMultiLanguage = !isFormatMode && Array.isArray(targetLanguage) && targetLanguage.length > 0;

    // Store the target language(s) for reference (except in format mode)
    if (!isFormatMode) {
        await assertBoundary();
        try {
            localStorage.setItem('translation_target_language', isMultiLanguage ? JSON.stringify(targetLanguage) : targetLanguage);
        } catch {
            // Compatibility metadata cannot own the translation run.
        }
    }

    // Get bracket style if using parentheses in single language mode and no custom style was provided
    if (!bracketStyle && useParentheses) {
        try {
            const savedStyle = localStorage.getItem('bracketStyle');
            if (savedStyle) {
                bracketStyle = { open: JSON.parse(savedStyle)[0], close: JSON.parse(savedStyle)[1] };
            } else {
                bracketStyle = { open: '(', close: ')' };
            }
        } catch (error) {
            console.warn('Error loading bracket style:', error);
            bracketStyle = { open: '(', close: ')' };
        }
    }

    // Native translation preserves timing from its typed input and must not copy project subtitles
    // into durable WebView storage. Browser compatibility still uses the legacy parser map. Replace
    // it for every top-level browser translation; recursive chunk calls keep the complete map.
    if (!preserveOriginalSubtitlesMap) {
        if (isDesktopRuntime()) {
            try {
                localStorage.removeItem('original_subtitles_map');
            } catch {
                // Compatibility metadata cannot own the translation run.
            }
        } else {
            const originalSubtitlesMap = {};
            sourceSubtitles.forEach((sub, index) => {
                // Ensure each subtitle has a unique ID
                const id = sub.id || index + 1;
                // Store the subtitle with its ID and index for reference
                originalSubtitlesMap[id] = {
                    ...sub,
                    id: id,  // Ensure ID is set
                    index: index  // Store the index for order-based matching
                };
            });

            try {
                localStorage.setItem('original_subtitles_map', JSON.stringify(originalSubtitlesMap));
            } catch {
                // Compatibility metadata cannot own the translation run.
            }
        }
    }

    // If in format mode, we don't need to call the API, just format the subtitles
    if (isFormatMode) {

        // Dispatch event to update UI with status
        const message = i18n.t('translation.formattingSubtitles', 'Formatting {{count}} subtitles', {
            count: sourceSubtitles.length
        });
        await publishStatus(message);

        // Format the subtitles with the chain items if provided, otherwise use the specified delimiter and bracket style
        const formatted = runnableChainItems
            ? formatSubtitlesWithChain(sourceSubtitles, runnableChainItems)
            : formatSubtitles(sourceSubtitles, delimiter, useParentheses, bracketStyle);
        await assertBoundary();
        return completeTranslationResult(formatted, deliverySink);
    }

    // If splitDuration is specified and not 0, split subtitles into chunks based on duration
    if (splitDuration > 0) {

        // Dispatch event to update UI with status
        const baseMessage = i18n.t('translation.splittingSubtitles', 'Splitting {{count}} subtitles into chunks of {{duration}} minutes', {
            count: sourceSubtitles.length,
            duration: splitDuration
        });
        const message = fileContext ? `[${fileContext}] ${baseMessage}` : baseMessage;
        await publishStatus(message);

        const restTime = Number.isSafeInteger(ownership.restTime) && ownership.restTime >= 0
            ? ownership.restTime
            : parseInt(localStorage.getItem('translation_rest_time') || '0');
        const translateChunk = async (
            chunkSubtitles,
            chunkTargetLanguage,
            chunkModel,
            chunkPrompt,
            chunkSplitDuration,
            chunkIncludeRules,
            chunkDelimiter,
            chunkUseParentheses,
            chunkBracketStyle,
            chunkChainItems
        ) => {
            const outcome = await translateSubtitles(
                chunkSubtitles,
                chunkTargetLanguage,
                chunkModel,
                chunkPrompt,
                chunkSplitDuration,
                chunkIncludeRules,
                chunkDelimiter,
                chunkUseParentheses,
                chunkBracketStyle,
                chunkChainItems,
                fileContext,
                true,
                ownership,
                deliverySink
            );
            return outcome.rows;
        };
        const translated = await translateSubtitlesByChunks(
            sourceSubtitles,
            targetLanguage,
            model,
            customPrompt,
            splitDuration,
            includeRules,
            delimiter,
            useParentheses,
            bracketStyle,
            chainItems,
            restTime,
            fileContext,
            translateChunk,
            { signal, assertOwned, publishStatus }
        );
        await assertBoundary();
        return completeTranslationResult(translated, deliverySink);
    }

    // The exact rows are appended once in the identity contract below. Feeding them through the
    // legacy prompt placeholder as well would duplicate the largest request payload.
    const subtitleText = '[Use the authoritative source rows in the identity contract below.]';

    // Create the prompt for translation (custom/default + optional transcription rules)
    const translationPrompt = appendIdentityContract(buildTranslationPrompt({
        subtitleText,
        targetLanguage,
        isMultiLanguage,
        customPrompt,
        includeRules
    }), languageIds, sourceSubtitles);

    try {
        const responseSchema = createTranslationSchema({
            languageIds: [...languageIds],
            sourceIds: sourceSubtitles.map((subtitle) => subtitle.originalId),
        });

        const executeTranslationRequest = async (prompt) => {
            await assertBoundary();
            const thinking = getThinkingBudget(model);
            const result = await runNativeGeminiText({
                task: 'translate',
                model,
                prompt,
                responseJsonSchema: responseSchema,
                ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
                signal,
            });
            const delivery = deliveryForResult(result);
            if (delivery) deliverySink.push(delivery);
            // A provider is allowed to settle despite abort; ownership is authoritative.
            await assertBoundary();
            return {
                candidates: [{ content: { parts: [{ text: result.text }] } }],
            };
        };

        const parseContext = {
            languageIds,
            sourceRows: sourceSubtitles.map((subtitle) => Object.freeze({
                sourceId: subtitle.originalId,
                text: subtitle.text,
            })),
        };
        const maxRetries = 2;
        let providerResult = null;
        let validationError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const prompt = attempt === 0
                ? translationPrompt
                : appendIdentityContract(
                    'RETRY REQUEST: The previous response violated the mandatory identity contract. Translate every authoritative source row again.',
                    languageIds,
                    sourceSubtitles
                );
            const data = await executeTranslationRequest(prompt);
            await assertBoundary();
            try {
                providerResult = processTranslationResponse(data, parseContext);
                validationError = null;
                break;
            } catch (error) {
                if (error?.code !== 'invalidTranslationResponse') throw error;
                validationError = error;
                if (attempt < maxRetries) {
                    console.warn(`Translation identity mismatch. Retrying (${attempt + 1}/${maxRetries})...`);
                }
            }
        }
        if (providerResult === null) throw validationError;

        const translatedSubtitles = buildTranslatedSubtitles({
            subtitles: sourceSubtitles,
            providerResult,
            languageIds,
            chainItems,
            delimiter,
            useParentheses,
            bracketStyle,
        });

        await assertBoundary();
        return completeTranslationResult(translatedSubtitles, deliverySink);
    } catch (error) {
        if (error instanceof PartialTranslationError) {
            error.result = Object.freeze({
                status: 'partial',
                rows: error.completedSubtitles,
                deliveries: Object.freeze([...deliverySink]),
            });
        }
        // Check if this is an AbortError
        if (error.name === 'AbortError' || error.code === 'translationAborted') {
            throw createTranslationAbortError();
        } else {
            console.error('Translation error:', error);
            throw error;
        }
    }
};

// Compatibility export. Translation cancellation is now owned by the hook's run controller.
const cancelTranslation = (controller = null) => {
    if (!controller || typeof controller.abort !== 'function') return false;
    controller.abort(createTranslationAbortError());
    return true;
};

// Export the functions
export { translateSubtitles, cancelTranslation };
