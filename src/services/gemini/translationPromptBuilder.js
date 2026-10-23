/**
 * Prompt construction for Gemini single-shot translation.
 * Builds the initial translation prompt (custom or default, plus optional
 * transcription-rules context) and the count-mismatch retry prompt.
 */

import { getTranscriptionRulesSync } from '../../utils/transcriptionRulesStore';

/**
 * Append transcription rules (from video analysis) as IMPORTANT CONTEXT to a prompt.
 * @param {string} prompt - The base translation prompt
 * @returns {string} - The prompt with rules appended (unchanged if none available)
 */
const appendTranscriptionRules = (prompt) => {
    try {
        const transcriptionRules = getTranscriptionRulesSync();

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
        void subtitleText;
        const languages = isMultiLanguage && Array.isArray(targetLanguage)
            ? targetLanguage.join(', ')
            : targetLanguage;
        translationPrompt = `Translate the authoritative timed subtitle cues into ${languages}.

Treat the full sequence as context so terminology, pronouns, names, tone, and register stay consistent. Write concise, natural subtitles suitable for a viewer. Preserve the meaning and communicative intent of each cue without summarizing, censoring, embellishing, or moving content between cues. The response schema and mandatory contract below define the output format.`;
    }

    // If includeRules is true, append transcription rules to the prompt
    if (includeRules) {
        translationPrompt = appendTranscriptionRules(translationPrompt);
    }

    return translationPrompt;
};

export { buildTranslationPrompt };
