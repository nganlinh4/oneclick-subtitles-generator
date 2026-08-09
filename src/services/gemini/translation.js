/**
 * Translation functionality for Gemini API
 */

import i18n from '../../i18n/i18n';
import { createTranslationSchema, addResponseSchema } from '../../utils/schemaUtils';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { createRequestController, removeRequestController, abortAllRequests } from './requestManagement';
import { formatSubtitles, formatSubtitlesWithChain } from './translationChainFormatter';
import { translateSubtitlesByChunks } from './translationChunkProcessor';
import { processTranslationResponse } from './translationResponseParser';
import { buildTranslationPrompt, buildRetryPrompt } from './translationPromptBuilder';
import { buildTranslatedSubtitles } from './translationSubtitleBuilder';
import { fetchWithKeyRotation } from './withKeyRotation';
import { DEFAULT_TRANSLATION_MODEL_ID } from '../../config/geminiModels';

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
const translateSubtitles = async (subtitles, targetLanguage, model = DEFAULT_TRANSLATION_MODEL_ID, customPrompt = null, splitDuration = 0, includeRules = false, delimiter = ' ', useParentheses = false, bracketStyle = null, chainItems = null, fileContext = null) => {
    // Check if we're in format mode (empty target languages array)
    const isFormatMode = Array.isArray(targetLanguage) && targetLanguage.length === 0;

    // Determine if we're doing multi-language translation
    const isMultiLanguage = !isFormatMode && Array.isArray(targetLanguage) && targetLanguage.length > 0;

    // Log chain items if provided
    if (chainItems) {

    }

    // Store the target language(s) for reference (except in format mode)
    if (!isFormatMode) {
        localStorage.setItem('translation_target_language', isMultiLanguage ? JSON.stringify(targetLanguage) : targetLanguage);
    }

    if (!subtitles || subtitles.length === 0) {
        throw new Error('No subtitles to translate');
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

    // Create a map of original subtitles with their IDs for reference
    // Only create and store the map if we're not in a chunked translation (splitDuration=0)
    // This prevents overwriting the complete map when processing individual chunks
    if (splitDuration === 0 && !localStorage.getItem('original_subtitles_map')) {
        const originalSubtitlesMap = {};
        subtitles.forEach((sub, index) => {
            // Ensure each subtitle has a unique ID
            const id = sub.id || index + 1;
            // Store the subtitle with its ID and index for reference
            originalSubtitlesMap[id] = {
                ...sub,
                id: id,  // Ensure ID is set
                index: index  // Store the index for order-based matching
            };
        });

        // Store the original subtitles map in localStorage for reference

        localStorage.setItem('original_subtitles_map', JSON.stringify(originalSubtitlesMap));
    } else if (splitDuration === 0) {

    }

    // If in format mode, we don't need to call the API, just format the subtitles
    if (isFormatMode) {

        // Dispatch event to update UI with status
        const message = i18n.t('translation.formattingSubtitles', 'Formatting {{count}} subtitles', {
            count: subtitles.length
        });
        window.dispatchEvent(new CustomEvent('translation-status', {
            detail: { message }
        }));

        // Format the subtitles with the chain items if provided, otherwise use the specified delimiter and bracket style
        return chainItems
            ? formatSubtitlesWithChain(subtitles, chainItems)
            : formatSubtitles(subtitles, delimiter, useParentheses, bracketStyle);
    }

    // If splitDuration is specified and not 0, split subtitles into chunks based on duration
    if (splitDuration > 0) {

        // Dispatch event to update UI with status
        const baseMessage = i18n.t('translation.splittingSubtitles', 'Splitting {{count}} subtitles into chunks of {{duration}} minutes', {
            count: subtitles.length,
            duration: splitDuration
        });
        const message = fileContext ? `[${fileContext}] ${baseMessage}` : baseMessage;
        window.dispatchEvent(new CustomEvent('translation-status', {
            detail: { message }
        }));

        // Get rest time from localStorage if available
        const restTime = parseInt(localStorage.getItem('translation_rest_time') || '0');
        if (restTime > 0) {

        }

        return await translateSubtitlesByChunks(subtitles, targetLanguage, model, customPrompt, splitDuration, includeRules, delimiter, useParentheses, bracketStyle, chainItems, restTime, fileContext);
    }

    // Format subtitles as text lines for Gemini (text only, no timestamps, no numbering)
    const subtitleText = subtitles.map(sub => sub.text).join('\n');

    // Create the prompt for translation (custom/default + optional transcription rules)
    const translationPrompt = buildTranslationPrompt({
        subtitleText,
        targetLanguage,
        isMultiLanguage,
        customPrompt,
        includeRules
    });

    // Create a unique ID for this request
    const { requestId, signal } = createRequestController();

    try {
        // Build the API URL for the given key (key supplied by the rotation wrapper).
        // Use the model parameter passed to the function
        // This allows for model selection specific to translation
        const buildApiUrl = (apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Create request data with structured output
        let requestData = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: translationPrompt }
                    ]
                }
            ]
        };

        // Always use structured output
        requestData = addResponseSchema(requestData, createTranslationSchema(isMultiLanguage));

        // Add thinking configuration if supported by the model
        requestData = addThinkingConfig(requestData, model);


        const response = await fetchWithKeyRotation((apiKey) =>
            fetch(buildApiUrl(apiKey), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData),
                signal: signal
            })
        );

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();

        // Loop-invariant context shared by every response-parsing call
        const parseContext = { isMultiLanguage, useParentheses, delimiter, bracketStyle, chainItems, subtitles };

        // Process the translation response
        let translatedTexts = [];
        let retryCount = 0;
        const maxRetries = 10;

        // Try to process the response
        translatedTexts = processTranslationResponse(data, parseContext);

        // Check if we have the correct number of translations
        while (translatedTexts.length !== subtitles.length && retryCount < maxRetries) {
            console.warn(`Translation count mismatch: got ${translatedTexts.length}, expected ${subtitles.length}. Retrying (${retryCount + 1}/${maxRetries})...`);
            retryCount++;

            try {
                // Create a more specific retry prompt that includes the original subtitle text
                // This ensures proper mapping between input and output
                const retryPrompt = buildRetryPrompt({
                    subtitles,
                    targetLanguage,
                    isMultiLanguage,
                    translatedCount: translatedTexts.length
                });

                // Use the same request structure as the original request
                const retryRequestData = {
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: retryPrompt }
                            ]
                        }
                    ]
                };

                // Always use structured output for retries too
                const schemaRequestData = addResponseSchema(retryRequestData, createTranslationSchema(isMultiLanguage));

                const retryResponse = await fetchWithKeyRotation((apiKey) =>
                    fetch(buildApiUrl(apiKey), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(schemaRequestData),
                        signal: signal
                    })
                );

                if (!retryResponse.ok) {
                    throw new Error(`Retry failed with status ${retryResponse.status}`);
                }

                const retryData = await retryResponse.json();
                translatedTexts = processTranslationResponse(retryData, parseContext);
            } catch (retryError) {
                console.error('Translation retry failed:', retryError);
                break; // Exit the retry loop if the API call fails
            }
        }

        // If we still don't have the right number of translations after all retries
        if (translatedTexts.length !== subtitles.length) {
            console.error(`Failed to get the correct number of translations after ${maxRetries} retries. Got ${translatedTexts.length}, expected ${subtitles.length}.`);
            throw new Error(`Translation failed: received ${translatedTexts.length} translations but expected ${subtitles.length}. Please try again.`);
        }

        // Create translated subtitles by combining original timing with translated text
        const translatedSubtitles = buildTranslatedSubtitles({
            subtitles,
            translatedTexts,
            chainItems,
            targetLanguage
        });


        if (translatedSubtitles.length > 0) {


        }

        // Remove this controller from the map after successful response
        removeRequestController(requestId);
        return translatedSubtitles;
    } catch (error) {
        // Check if this is an AbortError
        if (error.name === 'AbortError') {

            throw new Error('Translation request was aborted');
        } else {
            console.error('Translation error:', error);
            // Remove this controller from the map on error
            if (requestId) {
                removeRequestController(requestId);
            }
            throw error;
        }
    }
};

// Function to cancel translation
const cancelTranslation = () => {

    // Use the abortAllRequests function from requestManagement.js
    // This will abort all active controllers and set the processingForceStopped flag
    const aborted = abortAllRequests();

    return aborted;
};

// Export the functions
export { translateSubtitles, cancelTranslation };
