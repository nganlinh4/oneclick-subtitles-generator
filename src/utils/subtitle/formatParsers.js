/**
 * This module contains parsers for different subtitle text formats
 */

/**
 * Parse original format with minutes and seconds
 * @param {string} text - The text to parse
 * @returns {Array} - Array of subtitle objects
 */
export const parseOriginalFormat = (text) => {
    const subtitles = [];
    const regexOriginal = /\[\s*(\d+)m(\d+)s\s*-\s*(\d+)m(\d+)s\s*\](?:\n|\r\n?)+(.*?)(?=\[\s*\d+m\d+s|\s*$)/gs;
    let match;

    while ((match = regexOriginal.exec(text)) !== null) {
        const startMin = parseInt(match[1]);
        const startSec = parseInt(match[2]);
        const endMin = parseInt(match[3]);
        const endSec = parseInt(match[4]);

        let subtitleText = match[5].trim();

        subtitles.push({
            id: subtitles.length + 1,
            start: startMin * 60 + startSec,
            end: endMin * 60 + endSec,
            text: subtitleText
        });
    }

    return subtitles;
};

/**
 * Parse format with milliseconds
 * @param {string} text - The text to parse
 * @returns {Array} - Array of subtitle objects
 */
export const parseMillisecondsFormat = (text) => {
    const subtitles = [];
    const regexWithMs = /\[\s*(\d+)m(\d+)s(\d+)ms\s*-\s*(\d+)m(\d+)s(\d+)ms\s*\]\s*(.*?)(?=\[\s*\d+m\d+s|\s*$)/gs;
    let match;

    while ((match = regexWithMs.exec(text)) !== null) {
        const startMin = parseInt(match[1]);
        const startSec = parseInt(match[2]);
        const startMs = parseInt(match[3]);
        const endMin = parseInt(match[4]);
        const endSec = parseInt(match[5]);
        const endMs = parseInt(match[6]);

        const startTime = startMin * 60 + startSec + startMs / 1000;
        const endTime = endMin * 60 + endSec + endMs / 1000;

        let subtitleText = match[7].trim();

        subtitles.push({
            id: subtitles.length + 1,
            start: startTime,
            end: endTime,
            text: subtitleText
        });
    }

    return subtitles;
};

/**
 * Parse single timestamp format
 * @param {string} text - The text to parse
 * @returns {Array} - Array of subtitle objects
 */
export const parseSingleTimestampFormat = (text) => {
    const subtitles = [];
    const regexSingleTimestamp = /\[(\d+)m(\d+)s\]\s*([^[\n]*?)(?=\n*\[|$)/gs;
    const matches = [];
    let match;

    while ((match = regexSingleTimestamp.exec(text)) !== null) {
        const min = parseInt(match[1]);
        const sec = parseInt(match[2]);
        const content = match[3].trim();

        if (content && !content.match(/^\d+\.\d+s$/)) {
            matches.push({
                startTime: min * 60 + sec,
                text: content
            });
        }
    }

    if (matches.length > 0) {
        matches.forEach((curr, index) => {
            const next = matches[index + 1];
            const endTime = next ? next.startTime : curr.startTime + 4;

            subtitles.push({
                id: subtitles.length + 1,
                start: curr.startTime,
                end: endTime,
                text: curr.text
            });
        });
    }

    return subtitles;
};

/**
 * Parse the new bracket format with spaces and optional milliseconds: [ 0m0s000ms - 0m1s500ms ] Text
 * @param {string} text - The text to parse
 * @returns {Array} - Array of subtitle objects
 */
export const parseBracketSpaceFormat = (text) => {
    const subtitles = [];

    // First try the format with both start and end times including milliseconds
    const regexWithMs = /\[\s*(\d+)m(\d+)s(?:(\d+)ms)?\s*-\s*(\d+)m(\d+)s(?:(\d+)ms)?\s*\]\s*(.+?)(?=\[|$)/g;
    let match;

    while ((match = regexWithMs.exec(text)) !== null) {
        const startMin = parseInt(match[1]);
        const startSec = parseInt(match[2]);
        const startMs = match[3] ? parseInt(match[3]) / 1000 : 0;
        const endMin = parseInt(match[4]);
        const endSec = parseInt(match[5]);
        const endMs = match[6] ? parseInt(match[6]) / 1000 : 0;
        const content = match[7].trim();

        if (content) {
            subtitles.push({
                id: subtitles.length + 1,
                start: startMin * 60 + startSec + startMs,
                end: endMin * 60 + endSec + endMs,
                text: content
            });
        }
    }

    // If no matches, try the format without milliseconds
    if (subtitles.length === 0) {
        const regexWithoutMs = /\[\s*(\d+)m(\d+)s\s*-\s*(\d+)m(\d+)s\s*\]\s*(.+?)(?=\[\s*\d+m\d+s|$)/gs;

        while ((match = regexWithoutMs.exec(text)) !== null) {
            const startMin = parseInt(match[1]);
            const startSec = parseInt(match[2]);
            const endMin = parseInt(match[3]);
            const endSec = parseInt(match[4]);
            const content = match[5].trim();

            if (content) {
                subtitles.push({
                    id: subtitles.length + 1,
                    start: startMin * 60 + startSec,
                    end: endMin * 60 + endSec,
                    text: content
                });
            }
        }
    }

    // If still no matches, try the single timestamp format
    if (subtitles.length === 0) {
        const singleTimestampRegex = /\[\s*(\d+)m(\d+)s(?:(\d+)ms)?\s*\]\s*(.+?)(?=\[|$)/g;

        while ((match = singleTimestampRegex.exec(text)) !== null) {
            const startMin = parseInt(match[1]);
            const startSec = parseInt(match[2]);
            const startMs = match[3] ? parseInt(match[3]) / 1000 : 0;
            const content = match[4].trim();

            const start = startMin * 60 + startSec + startMs;

            // If this is not the first subtitle, set the end time of the previous subtitle
            if (subtitles.length > 0) {
                subtitles[subtitles.length - 1].end = start;
            }

            // For the current subtitle, set the end time to start + 5 seconds (temporary)
            const end = start + 5;

            if (content) {
                subtitles.push({
                    id: subtitles.length + 1,
                    start: start,
                    end: end,
                    text: content
                });
            }
        }

        // Adjust the end time of the last subtitle if needed
        if (subtitles.length > 0) {
            const lastSubtitle = subtitles[subtitles.length - 1];
            if (lastSubtitle.end > lastSubtitle.start + 10) {
                lastSubtitle.end = lastSubtitle.start + 5; // Limit to 5 seconds if it's too long
            }
        }
    }

    return subtitles;
};
