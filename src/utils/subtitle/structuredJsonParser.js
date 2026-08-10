/**
 * Module for parsing structured JSON responses from Gemini API
 */

import { convertTimeStringToSeconds } from './timeUtils';
import {
    parseBracketSpaceFormat,
    parseMillisecondsFormat,
    parseOriginalFormat,
    parseSingleTimestampFormat,
} from './formatParsers';
import { deduplicateAndSortSubtitles } from './subtitleUtils';

/**
 * Detect if text contains excessive character repetition (hallucination pattern)
 * @param {string} text - The text to check
 * @returns {boolean} - True if excessive repetition is detected
 */
const hasExcessiveRepetition = (text) => {
    if (!text || text.length < 50) return false; // Too short to be a concern
    
    // Check for single character repeated many times
    const singleCharPattern = /(.)\1{19,}/; // Same character repeated 20+ times
    if (singleCharPattern.test(text)) {
        const match = text.match(singleCharPattern);
        console.warn(`[StructuredJsonParser] Detected excessive repetition: "${match[0].substring(0, 20)}..." repeated ${match[0].length} times`);
        return true;
    }
    
    // Check for short sequences (2-5 chars) repeated many times
    const shortSequencePattern = /(.{2,5})\1{9,}/; // 2-5 char sequence repeated 10+ times
    if (shortSequencePattern.test(text)) {
        const match = text.match(shortSequencePattern);
        const totalLength = match[0].length;
        const sequenceLength = match[1].length;
        const repetitions = totalLength / sequenceLength;
        console.warn(`[StructuredJsonParser] Detected sequence repetition: "${match[1]}" repeated ${Math.floor(repetitions)} times`);
        return true;
    }
    
    // Check if more than 80% of the text is the same character
    const charCounts = {};
    for (const char of text) {
        charCounts[char] = (charCounts[char] || 0) + 1;
    }
    const maxCount = Math.max(...Object.values(charCounts));
    if (maxCount / text.length > 0.8) {
        const dominantChar = Object.keys(charCounts).find(key => charCounts[key] === maxCount);
        console.warn(`[StructuredJsonParser] Text is ${Math.round(maxCount / text.length * 100)}% the character "${dominantChar}"`);
        return true;
    }
    
    return false;
};

/**
 * Parse structured JSON response from Gemini
 * @param {Object} response - The response from Gemini API
 * @returns {Array} - Array of subtitle objects
 */
export const parseStructuredJsonResponse = (response) => {
    try {
        const structuredJson = response.candidates[0].content.parts[0].structuredJson;


        // Check for translations array in the new schema format
        if (structuredJson.translations && Array.isArray(structuredJson.translations)) {


            const subtitles = [];

            for (let i = 0; i < structuredJson.translations.length; i++) {
                const item = structuredJson.translations[i];


                if (!item || !item.text) {
                    console.warn(`Skipping item ${i + 1} - missing text property`);
                    continue;
                }

                // Try to get original subtitle from localStorage
                try {
                    const originalSubtitlesMapJson = localStorage.getItem('original_subtitles_map');
                    if (originalSubtitlesMapJson) {
                        const originalSubtitlesMap = JSON.parse(originalSubtitlesMapJson);
                        const originalSub = originalSubtitlesMap[item.id];

                        if (originalSub) {

                            subtitles.push({
                                id: parseInt(item.id),
                                start: originalSub.start,
                                end: originalSub.end,
                                text: item.text,
                                originalId: parseInt(item.id)
                            });
                            continue;
                        } else {
                            console.warn(`Original subtitle not found for ID ${item.id} in map`);
                        }
                    } else {
                        console.warn('No original subtitles map found in localStorage');
                    }
                } catch (error) {
                    console.error('Error loading original subtitles map:', error);
                }

                // Fallback if original subtitle not found - try to find by index
                try {
                    const originalSubtitlesMapJson = localStorage.getItem('original_subtitles_map');
                    if (originalSubtitlesMapJson) {
                        const originalSubtitlesMap = JSON.parse(originalSubtitlesMapJson);
                        const originalSubsArray = Object.values(originalSubtitlesMap);

                        if (i < originalSubsArray.length) {
                            const originalSub = originalSubsArray[i];

                            subtitles.push({
                                id: parseInt(item.id) || (i + 1),
                                start: originalSub.start,
                                end: originalSub.end,
                                text: item.text,
                                originalId: originalSub.id || (i + 1)
                            });
                            continue;
                        }
                    }
                } catch (error) {
                    console.error('Error using index-based fallback:', error);
                }

                // Last resort fallback
                console.warn(`Using default timing for subtitle ID ${item.id} at index ${i}`);
                subtitles.push({
                    id: parseInt(item.id) || (i + 1),
                    start: 0,
                    end: 0,
                    text: item.text,
                    originalId: parseInt(item.id) || (i + 1)
                });
            }


            return subtitles;
        }
        // If it's an array, assume it's a subtitle array
        else if (Array.isArray(structuredJson)) {
            const subtitles = [];

            // Check if all subtitles are empty with 00m00s000ms timestamps
            let allEmpty = true;
            let emptyCount = 0;

            // Skip this check for user-provided subtitles format (with index property)
            const isUserProvidedFormat = structuredJson.length > 0 &&
                                        structuredJson[0].index !== undefined &&
                                        structuredJson[0].startTime &&
                                        structuredJson[0].endTime;

            if (!isUserProvidedFormat) {
                for (let i = 0; i < structuredJson.length; i++) {
                    const item = structuredJson[i];
                    if (item.startTime === '00m00s000ms' &&
                        item.endTime === '00m00s000ms' &&
                        (!item.text || item.text.trim() === '')) {
                        emptyCount++;
                    } else {
                        allEmpty = false;
                        break;
                    }
                }
            } else {
                // For user-provided subtitles format, we don't need to check for empty subtitles
                allEmpty = false;

            }

            // If all subtitles are empty or more than 90% are empty, this is likely an error
            if (allEmpty || (emptyCount > 0 && emptyCount / structuredJson.length > 0.9)) {

                if (allEmpty) {
                    console.error('All subtitles are empty with 00m00s000ms timestamps. This is likely an error.');
                    throw new Error('No valid subtitles found in the response. All subtitles have empty text and 00m00s000ms timestamps.');
                } else {
                    console.warn(`${emptyCount} out of ${structuredJson.length} subtitles are empty with 00m00s000ms timestamps.`);
                }
            }

            // Skip empty subtitles at 00m00s000ms
            let startIndex = 0;

            // Skip this check for user-provided subtitles format
            if (!isUserProvidedFormat) {
                while (startIndex < structuredJson.length &&
                       structuredJson[startIndex].startTime === '00m00s000ms' &&
                       structuredJson[startIndex].endTime === '00m00s000ms' &&
                       (!structuredJson[startIndex].text || structuredJson[startIndex].text.trim() === '')) {

                    startIndex++;
                }
            }

            for (let i = startIndex; i < structuredJson.length; i++) {
                const item = structuredJson[i];

                // Handle timing format for user-provided subtitles (with or without text)
                if (item.startTime && item.endTime && item.index !== undefined) {
                    try {
                        // Convert time format from MMmSSsNNNms to seconds
                        const start = convertTimeStringToSeconds(item.startTime);
                        const end = convertTimeStringToSeconds(item.endTime);
                        const index = item.index;

                        let text = '';

                        // Check if text is included in the response (new format)
                        if (item.text && item.text.trim() !== '') {
                            text = item.text.trim();
                        } else {
                            // Fallback to getting text from localStorage (old format)
                            const userProvidedSubtitles = localStorage.getItem('user_provided_subtitles');
                            if (userProvidedSubtitles) {
                                const subtitleLines = userProvidedSubtitles.trim().split('\n').filter(line => line.trim() !== '');
                                if (index < subtitleLines.length) {
                                    text = subtitleLines[index].trim();
                                } else {
                                    console.warn(`Index ${index} out of range for user-provided subtitles (length: ${subtitleLines.length}) - skipping this entry`);
                                    continue; // Skip this entry
                                }
                            } else {
                                console.error('No user-provided subtitles found in localStorage');
                                continue; // Skip this entry
                            }
                        }

                        subtitles.push({
                            id: i + 1,
                            start,
                            end,
                            text: text
                        });
                    } catch (error) {
                        console.error(`Error processing timing item ${i + 1}:`, error);
                    }
                }
                // Handle regular subtitle format
                else if (item.startTime && item.endTime) {
                    try {
                        // Convert time format from MMmSSsNNNms to seconds
                        const start = convertTimeStringToSeconds(item.startTime);
                        const end = convertTimeStringToSeconds(item.endTime);

                        // Skip empty subtitles at the beginning of the video
                        if (start === 0 && end === 0 && (!item.text || item.text.trim() === '')) {
                            continue;
                        }
                        
                        // Check for excessive repetition (hallucination)
                        if (item.text && hasExcessiveRepetition(item.text)) {
                            console.error(`[StructuredJsonParser] Skipping subtitle ${i + 1} due to hallucination (excessive repetition)`);
                            console.error(`[StructuredJsonParser] Subtitle time: ${item.startTime} - ${item.endTime}`);
                            console.error(`[StructuredJsonParser] Text sample: "${item.text.substring(0, 100)}..."`);
                            
                            // Throw an error to indicate hallucination detected
                            throw new Error(JSON.stringify({
                                type: 'hallucination_detected',
                                message: `Subtitle contains excessive character repetition, indicating model hallucination`,
                                subtitleIndex: i + 1,
                                startTime: item.startTime,
                                endTime: item.endTime,
                                textSample: item.text.substring(0, 200)
                            }));
                        }

                        subtitles.push({
                            id: i + 1,
                            start,
                            end,
                            text: item.text || ''
                        });
                    } catch (error) {
                        console.error(`Error processing item ${i + 1}:`, error);
                    }
                }

                // Handle translation format
                else if (item.id && item.text) {
                    // Try to get original subtitle from localStorage
                    try {
                        const originalSubtitlesMapJson = localStorage.getItem('original_subtitles_map');
                        if (originalSubtitlesMapJson) {
                            const originalSubtitlesMap = JSON.parse(originalSubtitlesMapJson);
                            const originalSub = originalSubtitlesMap[item.id];

                            if (originalSub) {

                                subtitles.push({
                                    id: parseInt(item.id),
                                    start: originalSub.start,
                                    end: originalSub.end,
                                    text: item.text,
                                    originalId: parseInt(item.id)
                                });
                                continue;
                            } else {
                                console.warn(`Original subtitle not found for ID ${item.id} in map`);
                            }
                        } else {
                            console.warn('No original subtitles map found in localStorage');
                        }
                    } catch (error) {
                        console.error('Error loading original subtitles map:', error);
                    }

                    // Fallback if original subtitle not found - try to find by index
                    // This is important for when the ID in the response doesn't match the original ID
                    // but the order is preserved
                    try {
                        const originalSubtitlesMapJson = localStorage.getItem('original_subtitles_map');
                        if (originalSubtitlesMapJson) {
                            const originalSubtitlesMap = JSON.parse(originalSubtitlesMapJson);
                            // Get all values from the map as an array
                            const originalSubsArray = Object.values(originalSubtitlesMap);

                            // If we have an original subtitle at this index, use its timing
                            if (i < originalSubsArray.length) {
                                const originalSub = originalSubsArray[i];

                                subtitles.push({
                                    id: parseInt(item.id) || (i + 1),
                                    start: originalSub.start,
                                    end: originalSub.end,
                                    text: item.text,
                                    originalId: originalSub.id || (i + 1)
                                });
                                continue;
                            }
                        }
                    } catch (error) {
                        console.error('Error using index-based fallback:', error);
                    }

                    // Last resort fallback if original subtitle not found
                    console.warn(`Using default timing for subtitle ID ${item.id} at index ${i}`);
                    subtitles.push({
                        id: parseInt(item.id) || (i + 1),
                        start: 0, // Default start time
                        end: 0,   // Default end time
                        text: item.text,
                        originalId: parseInt(item.id) || (i + 1)
                    });
                }

                // Default case
                else {
                    console.warn(`Item ${i + 1} doesn't have required fields:`, JSON.stringify(item));
                }
            }


            return subtitles;
        }

        // Handle consolidation or summarization response
        if (structuredJson.title && structuredJson.content) {
            // This is a consolidated document
            return structuredJson;
        }

        if (structuredJson.summary && structuredJson.keyPoints) {
            // This is a summary
            return structuredJson;
        }

        // Unknown structure, return as is
        return structuredJson;
    } catch (error) {
        console.error('Error parsing structured JSON response:', error);
        console.error('Response was:', JSON.stringify(response).substring(0, 500) + '...');

        // Try to extract the text content as a fallback
        if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
            const text = response.candidates[0].content.parts[0].text;


            // Check if the text is a JSON string
            if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
                try {
                    const jsonData = JSON.parse(text);
                    if (Array.isArray(jsonData) && jsonData.length > 0) {

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
                } catch (e) {
                    console.error('Failed to parse text as JSON in fallback:', e);
                }
            }

            // Create a response structure with just the text
            // const mockResponse = {
            //     candidates: [{
            //         content: {
            //             parts: [{
            //                 text: text
            //             }]
            //         }
            //     }]
            // };

            // Parse the text directly to avoid infinite recursion
            const subtitles = [];

            // Try all the text parsing methods
            subtitles.push(...parseOriginalFormat(text));
            subtitles.push(...parseMillisecondsFormat(text));
            subtitles.push(...parseSingleTimestampFormat(text));
            subtitles.push(...parseBracketSpaceFormat(text));

            if (subtitles.length > 0) {
                return deduplicateAndSortSubtitles(subtitles);
            }
        }

        throw new Error('Failed to parse structured JSON response: ' + error.message);
    }
};
