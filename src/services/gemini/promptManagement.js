/**
 * Prompt management for Gemini API
 * Handles prompt presets and custom prompts
 */

import { getTranscriptionRulesSync } from '../../utils/transcriptionRulesStore';
import { normalizeTranscriptionPrompt } from './transcriptionPromptInvariant';

// Task instructions stay separate from the transport schema and clip-local timestamp contract.
// Descriptions are UI copy, never truncated fragments of the request prompt.
export const PROMPT_PRESETS = [
  {
    id: 'general', title: 'General purpose',
    descriptionKey: 'settings.presetGeneralDescription',
    description: 'Transcribe speech in its original language.',
    prompt: `Transcribe all audible speech in this {contentType} in its original language, including language changes. Preserve the spoken meaning and wording; do not summarize or add dialogue. Cover the entire supplied media, including speech near the end. Place each cue at the actual onset and end of its speech, preserving pauses. Do not infer speech from visible text or background music. Return no cues when there is no intelligible speech.`,
  },
  {
    id: 'extract-text', title: 'Extract text',
    descriptionKey: 'settings.presetTextDescription',
    description: 'Capture visible text with its on-screen timing.',
    prompt: `Extract readable on-screen text, including hardcoded subtitles, from this {contentType}. Ignore audio. Preserve the visible wording and language without guessing obscured text. Use each text appearance's visible start and end; keep unchanged text in one continuous cue and create a new cue when it changes or reappears. Return no cues when no text is readable.`,
  },
  {
    id: 'focus-lyrics', title: 'Focus on Lyrics',
    descriptionKey: 'settings.presetLyricsDescription',
    description: 'Transcribe sung lyrics, without spoken dialogue.',
    prompt: `Transcribe only audible sung lyrics in this {contentType}, preserving their original language and repeated sung lines. Ignore spoken dialogue, narration and instrumental passages. Follow the actual vocal timing and pauses, not an assumed musical beat. Cover the entire supplied media. Do not reconstruct missing words from familiarity with a song; return no cues when no lyrics are intelligible.`,
  },
  {
    id: 'describe-video', title: 'Describe video',
    descriptionKey: 'settings.presetVisualDescription',
    description: 'Describe significant visible actions and changes.',
    prompt: `Describe significant visible events and scene changes in this {contentType} with concise, factual captions. Use only visual evidence, not audio or inferred motives, identities or off-screen events. Time each description to the event it describes. Avoid repeatedly describing an unchanged scene; return no cues when no meaningful visual event is discernible.`,
  },
  {
    id: 'translate-directly', title: 'Translate directly',
    descriptionKey: 'settings.presetTranslationDescription',
    description: 'Translate speech into your chosen language.',
    prompt: `Translate all intelligible speech in this {contentType} into TARGET_LANGUAGE. Return only the translation in each cue's text, preserving meaning, tone, names and speaker changes without adding commentary. Cover the entire supplied media. Time each translated cue to the corresponding original speech, not to its translated word count. Preserve pauses and return no cues when there is no intelligible speech.`,
  },
  {
    id: 'chaptering', title: 'Chaptering',
    descriptionKey: 'settings.presetChapterDescription',
    description: 'Create chapter titles and brief summaries.',
    prompt: `Identify major topic or activity changes in this {contentType} using only the supplied evidence. For audio, use audible topics and events without assuming visuals. Give each chapter a short title and a brief summary as "Title :: Summary". Use the actual chapter boundaries, not equal time intervals; retain a single chapter when there is no meaningful transition. Do not invent events to fill gaps or subdivide chapters into subtitle-sized speech cues.`,
  },
  {
    id: 'diarize-speakers', title: 'Identify Speakers',
    descriptionKey: 'settings.presetSpeakerDescription',
    description: 'Transcribe speech with consistent speaker labels.',
    prompt: `Transcribe all intelligible speech in this {contentType} in its original language. Prefix each cue with "Speaker 1:", "Speaker 2:", and so on, assigned by first audible appearance in the supplied media. Keep labels consistent for the same voice within this media; start a new cue when the speaker changes. Use a supplied speaker name only when the evidence supports the match, and "Unknown speaker:" when the voice cannot be distinguished reliably. Do not invent identities. Preserve pauses and time each cue to its actual speech. Cover the entire supplied media; return no cues when there is no intelligible speech.`,
  },
];

// Default transcription prompt that will be used if no custom prompt is set
export const DEFAULT_TRANSCRIPTION_PROMPT = PROMPT_PRESETS[0].prompt;

const SPEECH_ONLY_PRESET_IDS = new Set([
    'general',
    'focus-lyrics',
    'translate-directly',
    'diarize-speakers',
]);

// Function declarations first
const getUserPromptPresetsImpl = () => {
    try {
        const savedPresets = localStorage.getItem('user_prompt_presets');
        return savedPresets ? JSON.parse(savedPresets) : [];
    } catch (error) {
        console.error('Error loading user prompt presets:', error);
        return [];
    }
};

const saveUserPromptPresetsImpl = (presets) => {
    try {
        localStorage.setItem('user_prompt_presets', JSON.stringify(presets));
    } catch (error) {
        console.error('Error saving user prompt presets:', error);
    }
};

const getTranscriptionPromptImpl = (contentType, userProvidedSubtitles = null, options = {}) => {
    const promptContext = options?.promptContext ?? null;
    // Check if a specific preset was selected in the Video Processing Options Modal
    const selectedPresetId = promptContext
        ? promptContext.presetId
        : localStorage.getItem('video_processing_prompt_preset');
    if (contentType === 'audio' && ['extract-text', 'describe-video'].includes(selectedPresetId)) {
        throw new Error('This preset requires video frames. Disable audio-only or choose a speech preset.');
    }
    
    // Get the transcription rules if available and enabled (using sync version)
    const useTranscriptionRules = promptContext
        ? promptContext.useTranscriptionRules === true
        : localStorage.getItem('video_processing_use_transcription_rules') !== 'false';
    const transcriptionRules = useTranscriptionRules
        ? (promptContext ? promptContext.transcriptionRules : getTranscriptionRulesSync())
        : null;

    // Determine the base prompt based on the selected preset
    let basePrompt;

    if (selectedPresetId && selectedPresetId !== 'settings') {
        // A specific preset was selected - use its prompt
        const preset = PROMPT_PRESETS.find(p => p.id === selectedPresetId)
            || (promptContext?.userPromptPresets ?? getUserPromptPresetsImpl()).find(
                p => p?.id === selectedPresetId && typeof p.prompt === 'string'
            );
        if (preset) {
            basePrompt = normalizeTranscriptionPrompt(
                preset.prompt,
                DEFAULT_TRANSCRIPTION_PROMPT
            ).replace('{contentType}', contentType);

            // Handle translate-directly preset with custom language
            if (selectedPresetId === 'translate-directly') {
                const customLanguage = promptContext
                    ? promptContext.customLanguage
                    : localStorage.getItem('video_processing_custom_language');
                if (typeof customLanguage !== 'string' || !customLanguage.trim()) {
                    throw new Error('Please enter a target language');
                }
                basePrompt = basePrompt.replace(/TARGET_LANGUAGE/g, () => customLanguage.trim());
            }
        } else {
            // Preset not found, fall back to default
            basePrompt = PROMPT_PRESETS[0].prompt.replace('{contentType}', contentType);
        }
    } else {
        // Use the prompt from settings (either 'settings' was selected or no preset specified)
        const settingsPrompt = promptContext
            ? promptContext.settingsPrompt
            : localStorage.getItem('transcription_prompt');
        if (settingsPrompt && settingsPrompt.trim() !== '') {
            basePrompt = normalizeTranscriptionPrompt(
                settingsPrompt,
                DEFAULT_TRANSCRIPTION_PROMPT
            ).replace('{contentType}', contentType);
        } else {
            basePrompt = PROMPT_PRESETS[0].prompt.replace('{contentType}', contentType);
        }
    }

    // Removed session prompt logging since we're not using it directly anymore

    // If we have user-provided subtitles, replace the entire prompt with a simplified version
    if (userProvidedSubtitles && userProvidedSubtitles.trim() !== '') {
        // Use a very simple prompt that only focuses on timing the provided subtitles
        // No preset information, no transcription rules, just the core task




        // Split the subtitles into an array and count them
        const subtitleLines = userProvidedSubtitles.trim().split('\n').filter(line => line.trim() !== '');
        const subtitleCount = subtitleLines.length;

        // Create a numbered list of subtitles for the prompt
        const numberedSubtitles = subtitleLines.map((line, index) => `[${index}] ${line}`).join('\n');

        // Get segment information if available
        const segmentInfo = options?.segmentInfo || {};
        const hasSegmentTimes = typeof segmentInfo.start === 'number' && typeof segmentInfo.duration === 'number';
        const isSegment = !!segmentInfo.isSegment || hasSegmentTimes;
        const segmentIndex = segmentInfo.segmentIndex !== undefined ? segmentInfo.segmentIndex : null;
        const segmentStartTime = hasSegmentTimes ? segmentInfo.start : (segmentInfo.startTime !== undefined ? segmentInfo.startTime : 0);
        const segmentDuration = hasSegmentTimes ? segmentInfo.duration : (segmentInfo.duration !== undefined ? segmentInfo.duration : null);
        const totalDuration = segmentInfo.totalDuration !== undefined ? segmentInfo.totalDuration : null;

        let segmentInfoText = '';
        if (isSegment && segmentDuration !== null) {
            if (segmentIndex !== null && totalDuration !== null) {
                segmentInfoText = `\nSegment info: This is segment ${segmentIndex + 1} starting at ${Number(segmentStartTime).toFixed(2)}s (duration: ${Number(segmentDuration).toFixed(2)}s).\nProvide timestamps relative to this segment's start (beginning at 00m00s000ms).`;
            } else {
                segmentInfoText = `\nSegment info: This segment starts at ${Number(segmentStartTime).toFixed(2)}s (duration: ${Number(segmentDuration).toFixed(2)}s).\nProvide timestamps relative to this segment's start (beginning at 00m00s000ms).`;
            }
        }

        // Build a simpler example JSON (just show format, not all lines)
        const exampleJson = `[
  { "index": 0, "startTime": "00m00s500ms", "endTime": "00m02s000ms", "text": "First subtitle text" },
  { "index": 1, "startTime": "00m02s000ms", "endTime": "00m04s500ms", "text": "Second subtitle text" },
  { "index": 2, "startTime": "00m04s500ms", "endTime": "00m07s000ms", "text": "Third subtitle text" }
]`;

        let simplifiedPrompt;
        if (isSegment) {
            // For segments, use a clean prompt similar to normal presets
            simplifiedPrompt = `Time the provided subtitles for this video segment. Match each numbered subtitle from the list below to when it appears in the video.${segmentInfoText}

Format: Return a JSON array with timing for subtitles that appear in this segment:
${exampleJson}

Rules:
- Each numbered subtitle that appears gets one entry with its index, start time, end time, and exact text
- Use exact text from the numbered list (do not modify or combine)
- Use leading zeros in timestamps (00m05s100ms, not 0m5s100ms)
- Only include subtitles that actually appear in this segment
- Index must match the number in brackets from the list below

Numbered subtitle list:\n${numberedSubtitles}`;

            // Append outside-range context if the modal requested it (persisted in localStorage)
            try {
                const useOutside = promptContext
                    ? promptContext.useOutsideResultsContext === true
                    : localStorage.getItem('video_processing_use_outside_context') === 'true';
                const ocText = promptContext
                    ? promptContext.outsideContextText
                    : localStorage.getItem('video_processing_outside_context_text');
                if (useOutside && ocText && ocText.trim()) {
                    simplifiedPrompt += `\n\nContextual subtitles outside the selected range (for consistency):${ocText}`;
                }
            } catch (e) {
                // ignore localStorage access issues
            }
        } else {
            // For full video processing, use a clean prompt similar to segment processing
            simplifiedPrompt = `Time all ${subtitleCount} provided subtitles for this video. Match each numbered subtitle to when it appears in the video.

Format: Return a JSON array with exactly ${subtitleCount} entries:
${exampleJson}

Rules:
- Must return exactly ${subtitleCount} entries (one for each numbered subtitle)
- Each entry must have: index (matching the number in brackets), startTime, endTime, and exact text
- Use exact text from the numbered list (do not modify, combine, or skip any lines)
- Use leading zeros in timestamps (00m05s100ms, not 0m5s100ms)
- Even if lines are similar or repetitive, each gets its own separate entry
- Index must match: [0] to index 0, [1] to index 1, etc.

Numbered subtitle list (all ${subtitleCount} must be timed):\n${numberedSubtitles}`;

            // Append outside-range context in full-video path as well
            try {
                const useOutside = promptContext
                    ? promptContext.useOutsideResultsContext === true
                    : localStorage.getItem('video_processing_use_outside_context') === 'true';
                const ocText = promptContext
                    ? promptContext.outsideContextText
                    : localStorage.getItem('video_processing_outside_context_text');
                if (useOutside && ocText && ocText.trim()) {
                    simplifiedPrompt += `\n\nContextual subtitles outside the selected range (for consistency):${ocText}`;
                }
            } catch (e) {
                // ignore
            }
        }


        return simplifiedPrompt;
    }

    // If we have transcription rules, append them to the prompt
    if (transcriptionRules) {
        let rulesText = '\n\nAdditional transcription rules to follow:\n';

        // Add atmosphere if available
        if (transcriptionRules.atmosphere) {
            rulesText += `\n- Atmosphere: ${transcriptionRules.atmosphere}\n`;
        }

        // Add terminology if available
        if (transcriptionRules.terminology && transcriptionRules.terminology.length > 0) {
            rulesText += '\n- Terminology and Proper Nouns:\n';
            transcriptionRules.terminology.forEach(term => {
                rulesText += `  * ${term.term}: ${term.definition}\n`;
            });
        }

        // Add speaker identification if available
        if (transcriptionRules.speakerIdentification && transcriptionRules.speakerIdentification.length > 0) {
            // Check if we're using the diarize-speakers preset
            const currentPreset = selectedPresetId;
            if (currentPreset === 'diarize-speakers') {
                rulesText += '\n- Speaker Identification (IMPORTANT - Use these names instead of generic "Speaker X" labels):\n';
                transcriptionRules.speakerIdentification.forEach(speaker => {
                    rulesText += `  * When you identify ${speaker.speakerId}, label them as "${speaker.speakerId}: " in the subtitle\n`;
                    rulesText += `    Description: ${speaker.description}\n`;
                });
                rulesText += '  * Use a generic numbered label for other distinguishable voices, or "Unknown speaker:" when uncertain.\n';
            } else {
                rulesText += '\n- Speaker Identification:\n';
                transcriptionRules.speakerIdentification.forEach(speaker => {
                    rulesText += `  * ${speaker.speakerId}: ${speaker.description}\n`;
                });
            }
        }

        // Add formatting conventions if available
        if (transcriptionRules.formattingConventions && transcriptionRules.formattingConventions.length > 0) {
            rulesText += '\n- Formatting and Style Conventions:\n';
            transcriptionRules.formattingConventions.forEach(convention => {
                rulesText += `  * ${convention}\n`;
            });
        }

        // Add spelling and grammar rules if available
        if (transcriptionRules.spellingAndGrammar && transcriptionRules.spellingAndGrammar.length > 0) {
            rulesText += '\n- Spelling, Grammar, and Punctuation:\n';
            transcriptionRules.spellingAndGrammar.forEach(rule => {
                rulesText += `  * ${rule}\n`;
            });
        }

        // Add relationships if available
        if (transcriptionRules.relationships && transcriptionRules.relationships.length > 0) {
            rulesText += '\n- Relationships and Social Hierarchy:\n';
            transcriptionRules.relationships.forEach(relationship => {
                rulesText += `  * ${relationship}\n`;
            });
        }

        // Add additional notes if available
        if (transcriptionRules.additionalNotes && transcriptionRules.additionalNotes.length > 0) {
            rulesText += '\n- Additional Notes:\n';
            transcriptionRules.additionalNotes.forEach(note => {
                rulesText += `  * ${note}\n`;
            });
        }

        // Append the rules to the base prompt
        return basePrompt + rulesText;
    }

    // Return the base prompt if no rules are available
    return basePrompt;
};

const getEmptySpeechPolicyImpl = (contentType, userProvidedSubtitles = null, promptContext = null) => {
    if (userProvidedSubtitles?.trim()) return undefined;

    const selectedPresetId = promptContext
        ? promptContext.presetId
        : localStorage.getItem('video_processing_prompt_preset');
    if (selectedPresetId && selectedPresetId !== 'settings') {
        return SPEECH_ONLY_PRESET_IDS.has(selectedPresetId) ? 'provenSilence' : undefined;
    }

    const settingsPrompt = promptContext
        ? promptContext.settingsPrompt
        : localStorage.getItem('transcription_prompt');
    if (!settingsPrompt?.trim()) return 'provenSilence';

    const normalizedSettingsPrompt = settingsPrompt.trim();
    const matchesExactSpeechPrompt = PROMPT_PRESETS
        .filter(({ id }) => SPEECH_ONLY_PRESET_IDS.has(id))
        .some(({ prompt }) => (
            prompt.trim() === normalizedSettingsPrompt
            || prompt.replace('{contentType}', contentType).trim() === normalizedSettingsPrompt
        ));
    return matchesExactSpeechPrompt ? 'provenSilence' : undefined;
};

const getDefaultTranslationPromptImpl = (subtitleText, targetLanguage, multiLanguage = false) => {
    // Count the number of subtitles by counting the lines
    const subtitleLines = subtitleText.split('\n').filter(line => line.trim());
    const subtitleCount = subtitleLines.length;

    if (multiLanguage && Array.isArray(targetLanguage)) {
        // For multiple languages
        const languageList = targetLanguage.join(', ');

        // Build example JSON with actual subtitle lines
        let exampleJson = '{\n  "translations": [';

        // Add examples for each language
        for (let langIndex = 0; langIndex < targetLanguage.length; langIndex++) {
            const lang = targetLanguage[langIndex];
            exampleJson += '\n    {\n      "language": "' + lang + '",\n      "texts": [';

            // Use all subtitle lines as examples
            for (let i = 0; i < subtitleLines.length; i++) {
                exampleJson += '\n        { "original": "' + subtitleLines[i].replace(/"/g, "'") + '", "translated": "[Translation in ' + lang + ']" }' + (i < subtitleLines.length - 1 ? ',' : '');
            }

            exampleJson += '\n      ]\n    }' + (langIndex < targetLanguage.length - 1 ? ',' : '');
        }

        exampleJson += '\n  ]\n}';

        return `Translate the following ${subtitleCount} subtitle texts to these languages: ${languageList}.

IMPORTANT INSTRUCTIONS:
1. Translate each line of text separately for EACH language.
2. DO NOT add any timestamps, SRT formatting, or other formatting.
3. DO NOT include any explanations, comments, or additional text in your response.
4. DO NOT include any SRT entry numbers, timestamps, or formatting in your translations.
5. DO NOT include quotes around your translations.
6. MAINTAIN exactly ${subtitleCount} lines in the same order for each language.
7. Each line in your response should correspond to the same line in the input.
8. If a line is empty, keep it empty in your response.
9. Return your response in a structured format with each language's translations grouped together.
10. For each subtitle, include BOTH the original text AND its translation to prevent mismatches.

Format your response as a JSON object with this structure:
${exampleJson}
`;
    } else {
        // Updated single language prompt to include original text
        // Build a JSON example with the actual subtitle lines
        let exampleJson = '[\n';

        // Add up to 5 example lines using the actual subtitle content
        // Use all subtitle lines as examples
        for (let i = 0; i < subtitleLines.length; i++) {
            // Use single quotes to avoid escaping issues
            const escapedLine = subtitleLines[i].replace(/"/g, "'");
            exampleJson += `  { "original": "${escapedLine}", "translated": "[Translation of this line in ${targetLanguage}]" }${i < subtitleLines.length - 1 ? ',' : ''}\n`;
        }

        exampleJson += ']';

        return `Translate the following ${subtitleCount} subtitle texts to ${targetLanguage}.

IMPORTANT INSTRUCTIONS:
1. Translate each line of text separately.
2. DO NOT add any timestamps, SRT formatting, or other formatting.
3. DO NOT include any explanations, comments, or additional text in your response.
4. DO NOT include any SRT entry numbers, timestamps, or formatting in your translations.
5. DO NOT include quotes around your translations.
6. MAINTAIN exactly ${subtitleCount} lines in the same order.
7. Each line in your response should correspond to the same line in the input.
8. If a line is empty, keep it empty in your response.
9. For each subtitle, include BOTH the original text AND its translation to prevent mismatches.

Format your response as a JSON array with objects containing both original and translated text:
${exampleJson}

`;
    }
};

const getDefaultConsolidatePromptImpl = (subtitlesText, language = null) => {
    const languageInstruction = language ?
        `CRITICAL INSTRUCTION: Your response MUST be in ${language} ONLY. DO NOT translate to English or any other language under any circumstances.` :
        `CRITICAL INSTRUCTION: You MUST maintain the EXACT SAME LANGUAGE as the original subtitles. DO NOT translate to English or any other language under any circumstances.`;

    return `${languageInstruction}

I have a collection of subtitles from a video or audio. Please convert these into a coherent document, organizing the content naturally based on the context. Maintain the original meaning but improve flow and readability.

${languageInstruction}

Provide a clear title and well-structured content for the document.

Here are the subtitles:\n\n${subtitlesText}

${languageInstruction}`;
};

const getDefaultSummarizePromptImpl = (subtitlesText, language = null) => {
    const languageInstruction = language ?
        `CRITICAL INSTRUCTION: Your response MUST be in ${language} ONLY. DO NOT translate to English or any other language under any circumstances.` :
        `CRITICAL INSTRUCTION: You MUST maintain the EXACT SAME LANGUAGE as the original subtitles. DO NOT translate to English or any other language under any circumstances.`;

    return `${languageInstruction}

I have a collection of subtitles from a video or audio. Please create a concise summary of the main points and key information. The summary should be about 1/3 the length of the original text but capture all essential information.

${languageInstruction}

Provide both a comprehensive summary and key points from the content.

Here are the subtitles:\n\n${subtitlesText}

${languageInstruction}`;
};

// Simple translation prompt for single subtitle retry
const getSimpleTranslationPromptImpl = (subtitleText, targetLanguage) => {
    if (Array.isArray(targetLanguage)) {
        const languageList = targetLanguage.join(', ');
        return `Translate the following text to ${languageList}. Return ONLY the translations, nothing else.

Text: ${subtitleText}`;
    } else {
        return `Translate the following text to ${targetLanguage}. Return ONLY the translation, nothing else.

Text: ${subtitleText}`;
    }
};

// Export all functions at the module level
export const getUserPromptPresets = getUserPromptPresetsImpl;
export const saveUserPromptPresets = saveUserPromptPresetsImpl;
export const shouldSplitGeneratedSubtitles = (options = {}) => {
    const presetId = options.promptContext
        ? options.promptContext.presetId
        : localStorage.getItem('video_processing_prompt_preset');
    return options.autoSplitSubtitles === true
        && !options.userProvidedSubtitles?.trim()
        && presetId !== 'chaptering';
};
export const getTranscriptionPrompt = (contentType, userProvidedSubtitles = null, options = {}) => {
    const prompt = getTranscriptionPromptImpl(contentType, userProvidedSubtitles, options);
    const maximum = Number(options.maxWordsPerSubtitle);
    // The user's presentation limit must reach the model before local auto-splitting.
    // Timing supplied text is a separate exact-index contract; do not subdivide its rows.
    if (!shouldSplitGeneratedSubtitles({ ...options, userProvidedSubtitles })
        || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) return prompt;
    return `${prompt}\n\nSubtitle cue length: aim for at most ${maximum} words per cue. Break at natural speech or content boundaries and time each cue independently from the supplied media. Preserve pauses and speaker changes; do not assign timestamps by evenly dividing a long segment or assuming a constant speaking rate. Preserve all requested content.`;
};
export const getEmptySpeechPolicy = getEmptySpeechPolicyImpl;
export const getDefaultTranslationPrompt = getDefaultTranslationPromptImpl;
export const getSimpleTranslationPrompt = getSimpleTranslationPromptImpl;
export const getDefaultConsolidatePrompt = getDefaultConsolidatePromptImpl;
export const getDefaultSummarizePrompt = getDefaultSummarizePromptImpl;
