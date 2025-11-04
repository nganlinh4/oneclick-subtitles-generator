/**
 * Main subtitle parser module
 * Exports all subtitle parsing functionality
 */

import { parseRawTextManually } from './formatParsers';
import { parseStructuredJsonResponse } from './structuredJsonParser';
import { parseTranslatedSubtitles } from './translationParser';
import { convertTimeStringToSeconds, formatSecondsToSRTTime } from './timeUtils';
import { deduplicateAndSortSubtitles } from './subtitleUtils';
import {
    parseOriginalFormat,
    parseMillisecondsFormat,
    parseSingleTimestampFormat,
    parseBracketSpaceFormat
} from './formatParsers';
import i18n from '../../i18n/i18n';

/**
 * Parse Gemini API response to extract subtitles
 * @param {Object} response - The response from Gemini API
 * @returns {Array} - Array of subtitle objects
 */
export const parseGeminiResponse = (response) => {
    // Check if content was blocked by Gemini
    if (response?.promptFeedback?.blockReason) {
        console.error('Content blocked by Gemini:', response.promptFeedback);
        throw new Error(i18n.t('errors.contentBlocked', 'Video content is not safe and was blocked by Gemini'));
    }

    // Check if this is a structured JSON response
    if (response?.candidates?.[0]?.content?.parts?.[0]?.structuredJson) {
        try {
            return parseStructuredJsonResponse(response);
        } catch (error) {
            console.error('Error parsing structured JSON response:', error);
            // Continue to try other parsing methods
        }
    }

    // Check for MAX_TOKENS finish reason
    if (response?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        const thoughtsTokens = response?.usageMetadata?.thoughtsTokenCount || 0;
        const totalTokens = response?.usageMetadata?.totalTokenCount || 0;

        console.error('Model hit token limit:', {
            finishReason: response.candidates[0].finishReason,
            thoughtsTokens,
            totalTokens,
            modelVersion: response.modelVersion
        });

        throw new Error(`Model ran out of tokens. Thinking used ${thoughtsTokens} tokens, leaving no space for response. Try reducing the thinking budget in Settings.`);
    }

    // Fall back to text parsing if not structured JSON
    if (!response?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error('Invalid Gemini API response structure:', JSON.stringify(response, null, 2));
        console.error('Expected: response.candidates[0].content.parts[0].text');
        console.error('Actual structure:', {
            hasCandidates: !!response?.candidates,
            candidatesLength: response?.candidates?.length,
            hasContent: !!response?.candidates?.[0]?.content,
            hasParts: !!response?.candidates?.[0]?.content?.parts,
            partsLength: response?.candidates?.[0]?.content?.parts?.length,
            firstPart: response?.candidates?.[0]?.content?.parts?.[0]
        });
        throw new Error('Invalid response format from Gemini API');
    }

    let text = response.candidates[0].content.parts[0].text;

    // Ensure text is a string before processing
    if (typeof text !== 'string') {
        console.error('Text is not a string:', typeof text, text);
        // Try to convert to string or handle the unexpected type
        if (text === null || text === undefined) {
            throw new Error('Response text is null or undefined');
        }
        // If it's an object or array, try to stringify it
        if (typeof text === 'object') {
            console.warn('Received object instead of string, attempting to parse directly');
            // Check if it's already parsed JSON data
            if (Array.isArray(text)) {
                // It's already an array of subtitles
                return text;
            }
            // Try to stringify and continue
            try {
                const stringified = JSON.stringify(text);
                console.warn('Stringified object:', stringified.substring(0, 200));
                // Continue with stringified version
                text = stringified;
            } catch (e) {
                throw new Error(`Cannot process non-string text: ${typeof text}`);
            }
        }
    }

    // Check if the text is a JSON string (be more lenient for streaming)
    // Handle both direct JSON arrays and JSON wrapped in markdown code blocks
    let jsonText = (typeof text === 'string' ? text : String(text)).trim();

    // Extract JSON from markdown code blocks if present
    if (jsonText.includes('```json') || jsonText.includes('```')) {
        const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
        if (jsonMatch && jsonMatch[1]) {
            jsonText = jsonMatch[1].trim();
        }
    }

    // Helper: detect clearly incomplete JSON (unterminated strings or unbalanced braces)
    const isLikelyIncompleteJsonArray = (s) => {
        if (!s || s[0] !== '[') return false;
        let inString = false;
        let escapeNext = false;
        let braceCount = 0;
        let bracketCount = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (ch === '\\') { escapeNext = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') braceCount++;
            else if (ch === '}') braceCount--;
            else if (ch === '[') bracketCount++;
            else if (ch === ']') bracketCount--;
        }
        // Incomplete if inside a string or braces/brackets are not balanced
        if (inString) return true;
        if (braceCount < 0 || bracketCount < 0) return true; // malformed
        if (bracketCount > 0) return true; // missing closing ]
        // Sometimes last object is cut off: ends with '"' without closing, or trailing comma
        const trimmed = s.trimEnd();
        if (trimmed.endsWith(',')) return true;
        // If last quote is not closed (odd number of quotes ignoring escapes), treat as incomplete
        let quotes = 0; let esc = false;
        for (let i = 0; i < s.length; i++) {
            const ch2 = s[i];
            if (esc) { esc = false; continue; }
            if (ch2 === '\\') { esc = true; continue; }
            if (ch2 === '"') quotes++;
        }
        if (quotes % 2 === 1) return true;
        return false;
    };

    if (jsonText.startsWith('[')) {
        try {

            // For streaming, try to fix incomplete JSON by adding missing closing bracket
            if (!jsonText.endsWith(']')) {
                // Find the last complete object and truncate there
                let lastCompleteIndex = -1;
                let braceCount = 0;
                let inString = false;
                let escapeNext = false;

                for (let i = 0; i < jsonText.length; i++) {
                    const char = jsonText[i];

                    if (escapeNext) {
                        escapeNext = false;
                        continue;
                    }

                    if (char === '\\') {
                        escapeNext = true;
                        continue;
                    }

                    if (char === '"') {
                        inString = !inString;
                        continue;
                    }

                    if (!inString) {
                        if (char === '{') {
                            braceCount++;
                        } else if (char === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                lastCompleteIndex = i;
                            }
                        }
                    }
                }

                // If we found complete objects, truncate and add closing bracket
                if (lastCompleteIndex > -1) {
                    jsonText = jsonText.substring(0, lastCompleteIndex + 1) + ']';
                } else if (jsonText.endsWith(',')) {
                    // Remove trailing comma and add closing bracket
                    jsonText = jsonText.slice(0, -1) + ']';
                } else {
                    // Just add closing bracket
                    jsonText += ']';
                }
            }

            // If it still looks incomplete (e.g., unterminated string), don't try to JSON.parse yet in streaming
            if (isLikelyIncompleteJsonArray(jsonText)) {
                // Return empty to signal "keep accumulating" rather than throwing
                return [];
            }

            const jsonData = JSON.parse(jsonText);

            if (Array.isArray(jsonData)) {
                // Check if it's a subtitle array
                if (jsonData.length > 0) {
                    const firstItem = jsonData[0];

                    // Check for standard subtitle format with text
                    if (firstItem.startTime && firstItem.endTime && firstItem.text) {
                        // Create a mock structured response
                        const mockResponse = {
                            candidates: [{
                                content: {
                                    parts: [{
                                        structuredJson: jsonData
                                    }]
                                }
                            }]
                        };
                        return parseStructuredJsonResponse(mockResponse);
                    }
                    // Check for timing format with index (for user-provided subtitles, with or without text)
                    else if (firstItem.startTime && firstItem.endTime && firstItem.index !== undefined) {
                        // Create a mock structured response
                        const mockResponse = {
                            candidates: [{
                                content: {
                                    parts: [{
                                        structuredJson: jsonData
                                    }]
                                }
                            }]
                        };
                        return parseStructuredJsonResponse(mockResponse);
                    }
                }
            }
        } catch (e) {
            // Downgrade log level for streaming noise; treat as non-fatal and fall back to other parsers
            console.debug('Failed to parse text as JSON (likely mid-stream, will retry):', e.message);
            // Continue to other parsing methods
        }
    }

    const subtitles = [];
    let hasTimestamps = false;
    let match;

    // Try new format with descriptions and on-screen text: [0:08 - 0:16] (Description)
    const regexNewFormat = /\[(\d+):(\d+)\s*-\s*(\d+):(\d+)\]\s*(?:\((.*?)\)|(.+?)(?=\[|$))/gs;

    while ((match = regexNewFormat.exec(text)) !== null) {
        hasTimestamps = true;
        const startMin = parseInt(match[1]);
        const startSec = parseInt(match[2]);
        const endMin = parseInt(match[3]);
        const endSec = parseInt(match[4]);

        let content = match[5] || match[6];
        if (content) {
            content = content.trim();
            if (content.startsWith('On-screen text:')) {
                content = content.substring('On-screen text:'.length).trim();
            }

            subtitles.push({
                id: subtitles.length + 1,
                start: startMin * 60 + startSec,
                end: endMin * 60 + endSec,
                text: content
            });
        }
    }

    // Try other formats if new format didn't work
    if (subtitles.length === 0) {
        subtitles.push(...parseOriginalFormat(text));
    }

    if (subtitles.length === 0) {
        subtitles.push(...parseMillisecondsFormat(text));
    }

    if (subtitles.length === 0) {
        subtitles.push(...parseSingleTimestampFormat(text));
    }

    // Try the new bracket format with spaces: [ 0m0s - 0m1s ] Text
    if (subtitles.length === 0) {
        subtitles.push(...parseBracketSpaceFormat(text));
    }

    if (!hasTimestamps && subtitles.length === 0) {
        // Check if this is a JSON array with all empty subtitles
        if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
            try {
                const jsonData = JSON.parse(text);
                if (Array.isArray(jsonData)) {
                    // Handle completely empty array
                    if (jsonData.length === 0) {

                        return []; // Return empty array instead of throwing an error
                    }

                    let emptyCount = 0;
                    for (const item of jsonData) {
                        if (item.startTime === '00m00s000ms' &&
                            item.endTime === '00m00s000ms' &&
                            (!item.text || item.text.trim() === '')) {
                            emptyCount++;
                        }
                    }

                    if (emptyCount > 0 && emptyCount / jsonData.length > 0.9) {
                        throw new Error(JSON.stringify({
                            type: 'empty_subtitles',
                            message: `Found ${emptyCount} empty subtitles out of ${jsonData.length}. The audio may not contain any speech or the model failed to transcribe it.`,
                            rawText: text
                        }));
                    }
                }
            } catch (e) {
                // If JSON parsing fails, continue with the default error
                console.debug('Error parsing JSON in empty subtitle check (non-fatal):', e.message);
            }
        }

        // If the text looks like a partial JSON array, suppress error during streaming and let caller continue accumulating
        if (typeof text === 'string' && text.trim().startsWith('[') && isLikelyIncompleteJsonArray(text.trim())) {
            return [];
        }

        throw new Error(JSON.stringify({
            type: 'unrecognized_format',
            message: 'Unrecognized subtitle format. Please add handling for this new format and try again.',
            rawText: text
        }));
    }

    return deduplicateAndSortSubtitles(subtitles);
};

// Export all functions
export {
    parseRawTextManually,
    parseTranslatedSubtitles,
    convertTimeStringToSeconds,
    formatSecondsToSRTTime,
    deduplicateAndSortSubtitles,
    parseStructuredJsonResponse
};
