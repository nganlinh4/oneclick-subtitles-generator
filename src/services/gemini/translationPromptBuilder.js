/**
 * Prompt construction for Gemini single-shot translation.
 * Builds the initial translation prompt (custom or default, plus optional
 * transcription-rules context) and the count-mismatch retry prompt.
 */

import { getDefaultTranslationPrompt } from './promptManagement';
import { getTranscriptionRules } from '../../utils/transcriptionRulesStore';

/**
 * Append transcription rules (from video analysis) as IMPORTANT CONTEXT to a prompt.
 * @param {string} prompt - The base translation prompt
 * @returns {string} - The prompt with rules appended (unchanged if none available)
 */
const appendTranscriptionRules = (prompt) => {
    try {
        const transcriptionRules = getTranscriptionRules();

        if (transcriptionRules && Object.keys(transcriptionRules).length > 0) {

            let rulesText = '\n\nIMPORTANT CONTEXT: Use the following rules and context from the video analysis to ensure consistent translation:\n';

            // Add atmosphere if available
            if (transcriptionRules.atmosphere) {
                rulesText += `\n- Atmosphere/Context: ${transcriptionRules.atmosphere}\n`;
            }

            // Add terminology if available
            if (transcriptionRules.terminology && transcriptionRules.terminology.length > 0) {
                rulesText += '\n- Terminology (maintain these terms consistently):\n';
                transcriptionRules.terminology.forEach(term => {
                    rulesText += `  * ${term.term}: ${term.definition}\n`;
                });
            }

            // Add speaker identification if available
            if (transcriptionRules.speakerIdentification && transcriptionRules.speakerIdentification.length > 0) {
                rulesText += '\n- Speakers:\n';
                transcriptionRules.speakerIdentification.forEach(speaker => {
                    rulesText += `  * ${speaker.speakerId}: ${speaker.description}\n`;
                });
            }

            // Add formatting conventions if available
            if (transcriptionRules.formattingConventions && transcriptionRules.formattingConventions.length > 0) {
                rulesText += '\n- Formatting Conventions:\n';
                transcriptionRules.formattingConventions.forEach(convention => {
                    rulesText += `  * ${convention}\n`;
                });
            }

            // Add additional notes if available
            if (transcriptionRules.additionalNotes && transcriptionRules.additionalNotes.length > 0) {
                rulesText += '\n- Additional Notes:\n';
                transcriptionRules.additionalNotes.forEach(note => {
                    rulesText += `  * ${note}\n`;
                });
            }

            // Append the rules to the translation prompt
            prompt += rulesText;
        }
    } catch (error) {
        console.error('Error retrieving transcription rules:', error);
    }

    return prompt;
};

/**
 * Build the initial translation prompt.
 * @param {Object} params
 * @param {string} params.subtitleText - Newline-joined subtitle texts
 * @param {string|Array} params.targetLanguage - Target language(s)
 * @param {boolean} params.isMultiLanguage - Whether multi-language translation is active
 * @param {string|null} params.customPrompt - Optional custom prompt template
 * @param {boolean} params.includeRules - Whether to append transcription rules
 * @returns {string} - The fully built translation prompt
 */
const buildTranslationPrompt = ({ subtitleText, targetLanguage, isMultiLanguage, customPrompt, includeRules }) => {
    let translationPrompt;
    if (customPrompt) {
        // Replace variables in the custom prompt
        translationPrompt = customPrompt
            .replace('{subtitlesText}', subtitleText)
            .replace('{targetLanguage}', isMultiLanguage ? targetLanguage.join(', ') : targetLanguage);
    } else {
        translationPrompt = getDefaultTranslationPrompt(subtitleText, targetLanguage, isMultiLanguage);
    }

    // If includeRules is true, append transcription rules to the prompt
    if (includeRules) {
        translationPrompt = appendTranscriptionRules(translationPrompt);
    }

    return translationPrompt;
};

/**
 * Build the retry prompt used when the translation count does not match.
 * @param {Object} params
 * @param {Array} params.subtitles - The original subtitles
 * @param {string|Array} params.targetLanguage - Target language(s)
 * @param {boolean} params.isMultiLanguage - Whether multi-language translation is active
 * @param {number} params.translatedCount - Count returned by the previous attempt
 * @returns {string} - The retry prompt
 */
const buildRetryPrompt = ({ subtitles, targetLanguage, isMultiLanguage, translatedCount }) => {
    // Create a more specific retry prompt that includes the original subtitle text
    // This ensures proper mapping between input and output
    const subtitleTextWithNumbers = subtitles.map((sub, index) => `${index + 1}. ${sub.text}`).join('\n');

    if (isMultiLanguage && Array.isArray(targetLanguage)) {
        const languageList = targetLanguage.join(', ');
        return `RETRY REQUEST: Translate the following ${subtitles.length} numbered subtitle texts to these languages: ${languageList}.

CRITICAL: You must return exactly ${subtitles.length} translations for each language, maintaining the exact same order as the numbered list below.

Previous attempt returned ${translatedCount} translations but we need exactly ${subtitles.length}.

${subtitleTextWithNumbers}

Return your response in the same JSON format as requested originally, with exactly ${subtitles.length} entries for each language.`;
    }

    return `RETRY REQUEST: Translate the following ${subtitles.length} numbered subtitle texts to ${targetLanguage}.

CRITICAL: You must return exactly ${subtitles.length} translations, maintaining the exact same order as the numbered list below.

Previous attempt returned ${translatedCount} translations but we need exactly ${subtitles.length}.

${subtitleTextWithNumbers}

Return your response in the same JSON format as requested originally, with exactly ${subtitles.length} entries.`;
};

export { buildTranslationPrompt, buildRetryPrompt };
