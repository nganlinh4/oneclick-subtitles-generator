/**
 * Delimiter/chain formatting helpers for Gemini translation (format mode).
 * Pure formatting logic — depends only on i18n and global window events.
 */

/**
 * Format subtitles with the specified delimiter and bracket style
 * @param {Array} subtitles - Subtitles to format
 * @param {string} delimiter - Delimiter to use
 * @param {boolean} useParentheses - Whether to use parentheses
 * @param {Object} bracketStyle - Optional bracket style { open, close }
 * @returns {Array} formatted subtitles
 */
const formatSubtitles = (subtitles, delimiter = ' ', useParentheses = false, bracketStyle = null) => {
    // Create a copy of the subtitles to avoid modifying the original
    const formattedSubtitles = subtitles.map((subtitle) => ({ ...subtitle }));

    // Get bracket style if using parentheses and no custom style was provided
    if (!bracketStyle && useParentheses) {
        bracketStyle = { open: '(', close: ')' };
    }

    // Format each subtitle
    for (let i = 0; i < formattedSubtitles.length; i++) {
        const subtitle = formattedSubtitles[i];

        // Apply bracket style if specified
        if (useParentheses && bracketStyle) {
            subtitle.text = `${bracketStyle.open}${subtitle.text}${bracketStyle.close}`;
        }

        // Apply delimiter if specified (for consistency with translation mode)
        if (delimiter && delimiter !== ' ') {
            // For newline delimiter, add it at the end
            if (delimiter === '\n') {
                subtitle.text = `${subtitle.text}${delimiter}`;
            }
            // For other delimiters, we don't need to add them in format mode
        }
    }

    return formattedSubtitles;
};

/**
 * Format subtitles according to the exact chain arrangement
 * @param {Array} subtitles - Subtitles to format
 * @param {Array} chainItems - Chain items defining the format
 * @returns {Array} formatted subtitles
 */
const formatSubtitlesWithChain = (subtitles, chainItems) => {


    // Create a copy of the subtitles to avoid modifying the original
    const formattedSubtitles = subtitles.map((subtitle) => ({ ...subtitle }));

    // Find the original language item in the chain
    const originalItem = chainItems.find(item => item.type === 'language' && item.isOriginal);

    if (!originalItem) {
        console.warn('No original language found in chain items');
        return formattedSubtitles;
    }

    // Log the subtitles for debugging


    // Format each subtitle according to the chain
    for (let i = 0; i < formattedSubtitles.length; i++) {
        const subtitle = formattedSubtitles[i];

        // Make a copy of the subtitle for debugging if needed
        // const originalSubtitle = { ...subtitle };

        // Store the original text
        const originalText = subtitle.text;


        // Build the formatted text by directly concatenating based on chain order
        let formattedText = '';

        // Process each item in the chain in order
        for (let j = 0; j < chainItems.length; j++) {
            const item = chainItems[j];


            if (item.type === 'language') {
                if (item.isOriginal) {
                    // Add the original text directly
                    formattedText += originalText;

                } else {
                    // Add the target language name as a placeholder
                    formattedText += item.value || '';

                }
            } else if (item.type === 'delimiter') {
                // Add the delimiter directly
                formattedText += item.value || '';

            }
        }



        // Update the subtitle text with the formatted result
        subtitle.text = formattedText;
    }

    return formattedSubtitles;
};

export { formatSubtitles, formatSubtitlesWithChain };
