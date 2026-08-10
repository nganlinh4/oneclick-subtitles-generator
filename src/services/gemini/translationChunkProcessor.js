/**
 * Chunked translation for the Gemini API.
 * Splits subtitles into duration-based chunks, translates each via the main
 * translateSubtitles function, with per-chunk retries and inter-chunk rest time.
 *
 * The caller supplies the single-chunk translator. Keeping that dependency
 * explicit avoids a translation.js <-> translationChunkProcessor.js cycle.
 */

import { getLanguageCode } from '../../utils/languageUtils';
import i18n from '../../i18n/i18n';
import { getProcessingForceStopped } from './requestManagement';

/**
 * Split subtitles into chunks based on duration and translate each chunk
 * @param {Array} subtitles - Subtitles to translate
 * @param {string|Array} targetLanguage - Target language(s)
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Custom prompt for translation
 * @param {number} splitDuration - Duration in minutes for each chunk
 * @param {boolean} includeRules - Whether to include transcription rules in the prompt
 * @param {string|null} delimiter - Delimiter to use for multiple languages
 * @param {boolean} useParentheses - Whether to use parentheses for the second language
 *                                  For 2 languages, both delimiter and brackets can be used together
 *                                  For 3+ languages, only delimiter is used
 * @param {Object} bracketStyle - Custom bracket style { open, close } for single language mode or dual language mode
 * @param {Array} chainItems - Optional chain items for chain-based formatting
 * @param {number} restTime - Optional rest time in seconds between chunk translations
 * @param {string|null} fileContext - Optional label for status messages
 * @param {Function} translateChunk - Single-chunk translation callback
 * @returns {Promise<Array>} - Array of translated subtitles
 */
const translateSubtitlesByChunks = async (subtitles, targetLanguage, model, customPrompt, splitDuration, includeRules = false, delimiter = ' ', useParentheses = false, bracketStyle = null, chainItems = null, restTime = 0, fileContext = null, translateChunk) => {
    if (typeof translateChunk !== 'function') {
        throw new TypeError('translateSubtitlesByChunks requires a translateChunk callback');
    }

    // Convert splitDuration from minutes to seconds
    const splitDurationSeconds = splitDuration * 60;

    // Group subtitles into chunks based on their timestamps
    const chunks = [];
    let currentChunk = [];
    let chunkStartTime = subtitles[0]?.start || 0;

    subtitles.forEach(subtitle => {
        // If this subtitle would exceed the chunk duration, start a new chunk
        if (subtitle.start - chunkStartTime > splitDurationSeconds) {
            if (currentChunk.length > 0) {
                chunks.push([...currentChunk]);
                currentChunk = [];
                chunkStartTime = subtitle.start;
            }
        }

        currentChunk.push(subtitle);
    });

    // Add the last chunk if it's not empty
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }



    // Dispatch event to update UI with status
    const baseSplitMessage = i18n.t('translation.splitComplete', 'Split {{count}} subtitles into {{chunks}} chunks', {
        count: subtitles.length,
        chunks: chunks.length
    });
    const splitMessage = fileContext ? `[${fileContext}] ${baseSplitMessage}` : baseSplitMessage;
    window.dispatchEvent(new CustomEvent('translation-status', {
        detail: { message: splitMessage }
    }));

    // Translate each chunk
    const translatedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
        // Check if processing has been force stopped
        if (getProcessingForceStopped()) {

            throw new Error('Translation request was aborted');
        }

        const chunk = chunks[i];


        // Dispatch event to update UI with status
        const baseChunkMessage = i18n.t('translation.translatingChunk', 'Translating chunk {{current}}/{{total}} with {{count}} subtitles', {
            current: i + 1,
            total: chunks.length,
            count: chunk.length
        });
        const chunkMessage = fileContext ? `[${fileContext}] ${baseChunkMessage}` : baseChunkMessage;
        window.dispatchEvent(new CustomEvent('translation-status', {
            detail: { message: chunkMessage }
        }));

        try {
            // Call translateSubtitles with the current chunk, but with splitDuration=0 to avoid infinite recursion
            // Pass along all parameters to maintain consistency across chunks
            const translatedChunk = await translateChunk(chunk, targetLanguage, model, customPrompt, 0, includeRules, delimiter, useParentheses, bracketStyle, chainItems);
            translatedChunks.push(translatedChunk);

            // Add rest time between chunks if specified and not the last chunk
            if (restTime > 0 && i < chunks.length - 1) {

                // Dispatch event to update UI with status
                const waitMessage = i18n.t('translation.waitingForNextChunk', 'Waiting {{seconds}} seconds before translating the next chunk...', {
                    seconds: restTime
                });
                window.dispatchEvent(new CustomEvent('translation-status', {
                    detail: { message: waitMessage }
                }));

                // Create a countdown timer
                for (let second = restTime; second > 0; second--) {
                    // Check if processing has been force stopped
                    if (getProcessingForceStopped()) {

                        throw new Error('Translation request was aborted');
                    }

                    // Update the status message with the remaining seconds
                    const countdownMessage = i18n.t('translation.waitingForNextChunk', 'Waiting {{seconds}} seconds before translating the next chunk...', {
                        seconds: second
                    });
                    window.dispatchEvent(new CustomEvent('translation-status', {
                        detail: { message: countdownMessage }
                    }));

                    // Wait for 1 second
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } catch (error) {
            console.error(`Error translating chunk ${i + 1}:`, error);

            // Check if processing has been force stopped before retrying
            if (getProcessingForceStopped()) {

                throw new Error('Translation request was aborted');
            }

            // If this is a count mismatch error, try one more time with a more specific prompt
            if (error.message && error.message.includes('received') && error.message.includes('expected')) {
                try {

                    // Create a more specific retry prompt that includes the original subtitle text with numbers
                    // This ensures proper mapping between input and output for chunks
                    const subtitleTextWithNumbers = chunk.map((sub, index) => `${index + 1}. ${sub.text}`).join('\n');

                    let chunkRetryPrompt;
                    const isMultiLang = Array.isArray(targetLanguage) && targetLanguage.length > 0;

                    if (isMultiLang) {
                        const languageList = targetLanguage.join(', ');
                        chunkRetryPrompt = `CHUNK RETRY: Translate the following ${chunk.length} numbered subtitle texts to these languages: ${languageList}.

CRITICAL: You must return exactly ${chunk.length} translations for each language, maintaining the exact same order as the numbered list below.

${subtitleTextWithNumbers}

Return your response in JSON format with exactly ${chunk.length} entries for each language.`;
                    } else {
                        chunkRetryPrompt = `CHUNK RETRY: Translate the following ${chunk.length} numbered subtitle texts to ${targetLanguage}.

CRITICAL: You must return exactly ${chunk.length} translations, maintaining the exact same order as the numbered list below.

${subtitleTextWithNumbers}

Return your response in JSON format with exactly ${chunk.length} entries.`;
                    }

                    // Call translateSubtitles with the improved retry prompt
                    // Pass along all parameters to maintain consistency across chunks
                    const translatedChunk = await translateChunk(chunk, targetLanguage, model, chunkRetryPrompt, 0, includeRules, delimiter, useParentheses, bracketStyle);
                    translatedChunks.push(translatedChunk);
                    continue;
                } catch (retryError) {
                    // Check if this is an abort error
                    if (retryError.name === 'AbortError' || retryError.message.includes('aborted')) {

                        throw retryError; // Re-throw to stop the entire process
                    }
                    console.error(`Retry for chunk ${i + 1} also failed:`, retryError);
                }
            }

            // If all retries fail, add the original subtitles to maintain the structure
            translatedChunks.push(chunk.map(sub => {
                // Get the original text with a failure indicator
                const translatedText = `[Translation failed] ${sub.text}`;

                // For chain-based formatting, create a translation map with failure indicators
                let finalText = translatedText;

                // Apply language chain formatting if chain items are provided
                if (chainItems && chainItems.length > 0) {


                    // Create a translation map for failed translations
                    // This will map each non-original language in the chain to a failure message
                    const translationMap = {
                        'original': sub.text
                    };

                    // Add failure messages for each non-original language in the chain
                    const targetLanguages = chainItems
                        .filter(item => item.type === 'language' && !item.isOriginal)
                        .map(item => item.value);

                    targetLanguages.forEach(lang => {
                        if (lang && lang.trim() !== '') {
                            translationMap[lang] = `[Translation failed] ${sub.text}`;
                        }
                    });

                    // Build the formatted text by walking through the chain
                    let formattedText = '';

                    for (let j = 0; j < chainItems.length; j++) {
                        const item = chainItems[j];

                        if (item.type === 'language') {
                            if (item.isOriginal) {
                                // Add the original text
                                formattedText += sub.text;
                            } else {
                                // Get the language name
                                const langName = item.value;

                                // Get the failure message for this language
                                const failureMessage = translationMap[langName] || `[Translation failed] ${sub.text}`;
                                formattedText += failureMessage;
                            }
                        } else if (item.type === 'delimiter') {
                            // Add the delimiter directly
                            formattedText += item.value || '';
                        }
                    }

                    finalText = formattedText;
                }

                return {
                    ...sub,
                    text: finalText,
                    language: getLanguageCode(targetLanguage)
                };
            }));
        }
    }

    // Dispatch event to update UI with completion status
    const baseCompletionMessage = i18n.t('translation.translationComplete', 'Translation completed for all {{count}} chunks', {
        count: chunks.length
    });
    const completionMessage = fileContext ? `[${fileContext}] ${baseCompletionMessage}` : baseCompletionMessage;
    window.dispatchEvent(new CustomEvent('translation-status', {
        detail: { message: completionMessage }
    }));

    // Flatten the array of translated chunks
    const result = translatedChunks.flat();

    // Log the result

    return result;
};

export { translateSubtitlesByChunks };
