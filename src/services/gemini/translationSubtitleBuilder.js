/**
 * Builds the final translated subtitle objects from the parsed translation
 * texts, preserving original timing and applying chain-based formatting when
 * chain items are provided.
 */

import { getLanguageCode } from '../../utils/languageUtils';

/**
 * Apply the language chain formatting for a single subtitle.
 * @param {Object} params
 * @param {Object|string} params.translationData - Translation map or string for this subtitle
 * @param {boolean} params.isTranslationMap - Whether translationData is a per-language map
 * @param {Object} params.originalSub - The original subtitle
 * @param {string} params.finalText - The fallback/plain translated text
 * @param {Array} params.chainItems - Chain items defining the format
 * @returns {string} - The formatted text
 */
const applyChainFormatting = ({ translationData, isTranslationMap, originalSub, finalText, chainItems }) => {
    // If we have a translation map, use it to get translations for each language
    if (isTranslationMap) {

        // Build the formatted text by walking through the chain
        let formattedText = '';

        for (let j = 0; j < chainItems.length; j++) {
            const item = chainItems[j];


            if (item.type === 'language') {
                if (item.isOriginal) {
                    // Add the original text
                    formattedText += originalSub.text;

                } else {
                    // Get the language name
                    const langName = item.value;

                    // Try to find a matching language in the translation map
                    // First try exact match, then case-insensitive match, then partial match
                    let matchedTranslation = null;

                    // Try exact match
                    if (translationData[langName]) {
                        matchedTranslation = translationData[langName];
                    } else {
                        // Try case-insensitive match
                        const langKey = Object.keys(translationData).find(key =>
                            key.toLowerCase() === langName.toLowerCase());

                        if (langKey) {
                            matchedTranslation = translationData[langKey];
                        } else {
                            // Try partial match
                            const partialLangKey = Object.keys(translationData).find(key =>
                                key.toLowerCase().includes(langName.toLowerCase()) ||
                                langName.toLowerCase().includes(key.toLowerCase()));

                            if (partialLangKey) {
                                matchedTranslation = translationData[partialLangKey];
                            }
                        }
                    }

                    if (matchedTranslation) {
                        formattedText += matchedTranslation;

                    } else {
                        // If no matching translation found, use the language name as placeholder
                        formattedText += langName;

                    }
                }
            } else if (item.type === 'delimiter') {
                // Add the delimiter directly
                formattedText += item.value || '';

            }
        }

        return formattedText;
    }

    // If we don't have a translation map, use the old approach with just the translated text
    let formattedText = '';

    for (let j = 0; j < chainItems.length; j++) {
        const item = chainItems[j];


        if (item.type === 'language') {
            if (item.isOriginal) {
                // Add the original text
                formattedText += originalSub.text;

            } else {
                // Add the translated text
                formattedText += finalText;

            }
        } else if (item.type === 'delimiter') {
            // Add the delimiter directly
            formattedText += item.value || '';

        }
    }

    return formattedText;
};

/**
 * Combine original subtitle timing with translated text into the final result.
 * @param {Object} params
 * @param {Array} params.subtitles - The original subtitles
 * @param {Array} params.translatedTexts - Parsed translations (strings or maps)
 * @param {Array|null} params.chainItems - Optional chain items for formatting
 * @param {string|Array} params.targetLanguage - Target language(s)
 * @returns {Array} - The translated subtitle objects
 */
const buildTranslatedSubtitles = ({ subtitles, translatedTexts, chainItems, targetLanguage }) => {
    return subtitles.map((originalSub, index) => {
        // Get the translated text or translation map for this subtitle
        const translationData = translatedTexts[index];

        // Check if we have a translation map (from chain-based formatting) or just a string
        const isTranslationMap = translationData && typeof translationData === 'object' && !Array.isArray(translationData);

        // Default to original text if no translation is available, with a warning
        let finalText = isTranslationMap ? '' : (translationData || originalSub.text);

        // Log warning if we're falling back to original text (indicates alignment issue)
        if (!translationData) {
            console.warn(`Translation missing for subtitle ${index + 1}: "${originalSub.text}" - using original text`);
        }

        // Apply language chain formatting if chain items are provided
        if (chainItems && chainItems.length > 0) {
            finalText = applyChainFormatting({ translationData, isTranslationMap, originalSub, finalText, chainItems });
        }

        return {
            id: originalSub.id ?? originalSub.subtitle_id ?? index + 1,
            start: originalSub.start,
            end: originalSub.end,
            startTime: originalSub.startTime,
            endTime: originalSub.endTime,
            text: finalText,
            originalId: originalSub.originalId
                ?? originalSub.id
                ?? originalSub.subtitle_id
                ?? `ordinal:${index}`,
            sourceOrder: originalSub.sourceOrder ?? index,
            language: Array.isArray(targetLanguage) ? getLanguageCode(targetLanguage[0]) : getLanguageCode(targetLanguage)
        };
    });
};

export { buildTranslatedSubtitles };
