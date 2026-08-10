/**
 * Response parsing for Gemini single-shot translation.
 * Extracts the translated texts (or per-subtitle translation maps for chain
 * formatting) from a Gemini generateContent response.
 *
 * Pure logic: depends only on the explicit `ctx` it is handed (the read-only,
 * loop-invariant translation options). No outer mutable state is captured.
 */

/**
 * Process a Gemini response and extract translated texts.
 * @param {Object} responseData - Raw Gemini generateContent response JSON
 * @param {Object} ctx - Loop-invariant translation context
 * @param {boolean} ctx.isMultiLanguage - Whether multi-language translation is active
 * @param {boolean} ctx.useParentheses - Whether to wrap the secondary language in brackets
 * @param {string|null} ctx.delimiter - Delimiter used to join multiple languages
 * @param {Object|Array|null} ctx.bracketStyle - Bracket style (indexable as [0]/[1])
 * @param {Array|null} ctx.chainItems - Optional chain items for chain-based formatting
 * @param {Array} ctx.subtitles - The original subtitles being translated
 * @returns {Array} - Array of translated strings, or per-subtitle translation maps
 */
const processTranslationResponse = (responseData, ctx) => {
    const { isMultiLanguage, useParentheses, delimiter, bracketStyle, chainItems, subtitles } = ctx;

    // Check if this is a structured JSON response
    if (responseData.candidates?.[0]?.content?.parts?.[0]?.structuredJson) {

        const structuredJson = responseData.candidates[0].content.parts[0].structuredJson;

        // For multi-language translation with the new schema
        if (isMultiLanguage && structuredJson.translations && Array.isArray(structuredJson.translations)) {


            // Extract translations for each language
            const languageTranslations = {};
            structuredJson.translations.forEach(langData => {
                if (langData.language && Array.isArray(langData.texts)) {
                    languageTranslations[langData.language] = langData.texts;
                }
            });

            // Combine translations based on delimiter or parentheses
            const combinedTranslations = [];
            const languages = Object.keys(languageTranslations);

            // Get the first language's translations as the base
            const primaryLang = languages[0];
            const primaryTexts = languageTranslations[primaryLang] || [];

            // For each subtitle, combine translations from all languages
            for (let i = 0; i < primaryTexts.length; i++) {
                // Check if we have the new format with original and translated properties
                const primaryItem = primaryTexts[i] || {};
                let translatedText = '';

                if (primaryItem.original !== undefined && primaryItem.translated !== undefined) {
                    // New format with original and translated properties
                    translatedText = primaryItem.translated;
                } else {
                    // Old format with just the text
                    translatedText = primaryItem;
                }

                let combinedText = translatedText;

                // If we have exactly one additional language and useParentheses is true
                if (languages.length === 2 && useParentheses) {
                    const secondaryLang = languages[1];
                    const secondaryTexts = languageTranslations[secondaryLang] || [];
                    const secondaryItem = secondaryTexts[i] || {};

                    let secondaryTranslatedText = '';
                    if (secondaryItem.original !== undefined && secondaryItem.translated !== undefined) {
                        secondaryTranslatedText = secondaryItem.translated;
                    } else {
                        secondaryTranslatedText = secondaryItem;
                    }

                    if (secondaryTranslatedText) {
                        // For 2 languages with both options, use brackets and delimiter
                        if (delimiter && delimiter !== ' ') {
                            combinedText += `${bracketStyle[0]}${secondaryTranslatedText}${bracketStyle[1]}`;
                        } else {
                            combinedText += ` ${bracketStyle[0]}${secondaryTranslatedText}${bracketStyle[1]}`;
                        }
                    }
                }
                // Otherwise use the specified delimiter
                else if (languages.length > 1 && delimiter) {
                    for (let j = 1; j < languages.length; j++) {
                        const lang = languages[j];
                        const texts = languageTranslations[lang] || [];
                        const secondaryItem = texts[i] || {};

                        let secondaryTranslatedText = '';
                        if (secondaryItem.original !== undefined && secondaryItem.translated !== undefined) {
                            secondaryTranslatedText = secondaryItem.translated;
                        } else {
                            secondaryTranslatedText = secondaryItem;
                        }

                        if (secondaryTranslatedText) {
                            combinedText += `${delimiter}${secondaryTranslatedText}`;
                        }
                    }
                }

                combinedTranslations.push(combinedText);
            }

            return combinedTranslations;
        }

        // Original single language processing
        // If it's an array of translations with the new format (original + translated)
        if (Array.isArray(structuredJson)) {
            return structuredJson.map(item => {
                // Check if this is the new format with original and translated properties
                if (item.original !== undefined && item.translated !== undefined) {
                    return useParentheses
                        ? `${item.original}${bracketStyle[0]}${item.translated}${bracketStyle[1]}`
                        : item.translated;
                }
                // Fall back to the old format or any other property that might contain the text
                return item.text || item.translated || '';
            }).filter(text => text !== undefined);
        }
        // If it has a translations array property (old format)
        else if (structuredJson.translations && Array.isArray(structuredJson.translations)) {
            return structuredJson.translations.map(item => {
                // Check if this is the new format with original and translated properties
                if (item.original !== undefined && item.translated !== undefined) {
                    return useParentheses
                        ? `${item.original}${bracketStyle[0]}${item.translated}${bracketStyle[1]}`
                        : item.translated;
                }
                // Fall back to the old format
                return item.text || '';
            }).filter(text => text !== undefined);
        }
    }

    // Handle text response
    const translatedText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (translatedText) {
        // Log the full response for debugging


        // Check if the response is a JSON object with translations array (multi-language format)
        if (isMultiLanguage && translatedText.includes('"translations"') && translatedText.includes('"language"') && translatedText.includes('"texts"')) {
            try {
                // Try to parse as JSON
                const jsonObj = JSON.parse(translatedText);
                if (jsonObj.translations && Array.isArray(jsonObj.translations)) {


                    // Extract translations for each language
                    const languageTranslations = {};
                    jsonObj.translations.forEach(langData => {
                        if (langData.language && Array.isArray(langData.texts)) {
                            languageTranslations[langData.language] = langData.texts;
                        }
                    });

                    // Prepare to store the combined translations
                    let combinedTranslations = [];
                    const languages = Object.keys(languageTranslations);

                    // Check if we have chain items for chain-based formatting
                    if (chainItems && chainItems.length > 0) {



                        // Get all translations for each subtitle
                        for (let i = 0; i < subtitles.length; i++) {
                            const originalText = subtitles[i].text;

                            // Create a map of language to translated text
                            const translationMap = {
                                'original': originalText
                            };

                            // Add translations for each language
                            for (let j = 0; j < languages.length; j++) {
                                const lang = languages[j];
                                const texts = languageTranslations[lang] || [];
                                const item = texts[i] || {};

                                let translatedText = '';
                                if (item.original !== undefined && item.translated !== undefined) {
                                    translatedText = item.translated;
                                } else {
                                    translatedText = item;
                                }

                                translationMap[lang] = translatedText;
                            }



                            // For chain-based formatting, we'll store the translation map for each subtitle
                            // This allows us to access translations for each language in the final formatting step

                            // Store the translation map for this subtitle
                            // We'll use this in the final formatting step to get the correct translation for each language
                            combinedTranslations.push(translationMap);

                            // Log what we're storing for debugging

                        }
                    } else {
                        // Traditional formatting (without chain items)


                        // Get the first language's translations as the base
                        const primaryLang = languages[0];
                        const primaryTexts = languageTranslations[primaryLang] || [];

                        // For each subtitle, combine translations from all languages
                        for (let i = 0; i < primaryTexts.length; i++) {
                            // Check if we have the new format with original and translated properties
                            const primaryItem = primaryTexts[i] || {};
                            let translatedText = '';

                            if (primaryItem.original !== undefined && primaryItem.translated !== undefined) {
                                // New format with original and translated properties
                                translatedText = primaryItem.translated;
                            } else {
                                // Old format with just the text
                                translatedText = primaryItem;
                            }

                            let combinedText = translatedText;

                            // If we have exactly one additional language and useParentheses is true
                            if (languages.length === 2 && useParentheses) {
                                const secondaryLang = languages[1];
                                const secondaryTexts = languageTranslations[secondaryLang] || [];
                                const secondaryItem = secondaryTexts[i] || {};

                                let secondaryTranslatedText = '';
                                if (secondaryItem.original !== undefined && secondaryItem.translated !== undefined) {
                                    secondaryTranslatedText = secondaryItem.translated;
                                } else {
                                    secondaryTranslatedText = secondaryItem;
                                }

                                if (secondaryTranslatedText) {
                                    // For 2 languages with both options, use brackets and delimiter
                                    if (delimiter && delimiter !== ' ') {
                                        combinedText += `${bracketStyle[0]}${secondaryTranslatedText}${bracketStyle[1]}`;
                                    } else {
                                        combinedText += ` ${bracketStyle[0]}${secondaryTranslatedText}${bracketStyle[1]}`;
                                    }
                                }
                            }
                            // Otherwise use the specified delimiter
                            else if (languages.length > 1 && delimiter) {
                                for (let j = 1; j < languages.length; j++) {
                                    const lang = languages[j];
                                    const texts = languageTranslations[lang] || [];
                                    const secondaryItem = texts[i] || {};

                                    let secondaryTranslatedText = '';
                                    if (secondaryItem.original !== undefined && secondaryItem.translated !== undefined) {
                                        secondaryTranslatedText = secondaryItem.translated;
                                    } else {
                                        secondaryTranslatedText = secondaryItem;
                                    }

                                    if (secondaryTranslatedText) {
                                        combinedText += `${delimiter}${secondaryTranslatedText}`;
                                    }
                                }
                            }

                            combinedTranslations.push(combinedText);
                        }
                    }

                    return combinedTranslations;
                }
            } catch (e) {
                // Continue with the array and line-oriented response formats.
            }
        }

        // Check if the response is a JSON array
        if (translatedText.trim().startsWith('[') && translatedText.trim().endsWith(']')) {
            try {
                // Try to parse as JSON
                const jsonArray = JSON.parse(translatedText);
                if (Array.isArray(jsonArray)) {

                    // Return the array items directly
                    return jsonArray.map(item => {
                        // Check if this is the new format with original and translated properties
                        if (item && typeof item === 'object' && item.original !== undefined && item.translated !== undefined) {
                            return useParentheses
                                ? `${item.original}${bracketStyle[0]}${item.translated}${bracketStyle[1]}`
                                : item.translated;
                        }
                        // Remove any quotes if the item is a string
                        return typeof item === 'string' ? item.replace(/^"|"$/g, '') : (item.text || item.translated || '');
                    });
                }
            } catch (e) {
                // Continue with the line-oriented response format.
            }
        }

        // Split the text by lines and remove empty lines
        const lines = translatedText.split('\n').map(line => line.trim()).filter(line => line.trim());

        // Log the number of lines for debugging




        // No filtering of lines - we'll rely on the retry mechanism if the count is wrong
        return lines;
    }

    return [];
};

export { processTranslationResponse };
