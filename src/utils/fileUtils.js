import { resolveActiveNativeMediaAssetId } from '../platform/activeNativeMedia';
import { exportMediaAsset } from '../platform/mediaExportService';
import { runMediaPipeline } from '../platform/mediaPipelineService';

/**
 * Parse time string (00:00:00,000 or 00:00:00.000) to seconds
 * @param {string} timeString - Time string in format 00:00:00,000 or 00:00:00.000
 * @returns {number} - Time in seconds
 */
export const parseTimeString = (timeString) => {
  if (!timeString) return 0;

  // Handle SRT format (00:00:00,000) or WebVTT format (00:00:00.000)
  if (timeString.includes(':')) {
    const [hours, minutes, secondsMs] = timeString.split(':');
    const [seconds, ms] = secondsMs.includes(',')
      ? secondsMs.split(',')
      : secondsMs.split('.');

    return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds) + parseInt(ms) / 1000;
  }

  // If it's just a number, return it as is
  if (!isNaN(parseFloat(timeString))) {
    return parseFloat(timeString);
  }

  return 0;
};

/**
 * Convert seconds to SRT time format (HH:MM:SS,mmm)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Time in SRT format
 */
export const secondsToSrtTime = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
};

/**
 * Clean subtitle text by removing any SRT formatting that might be embedded in it
 * @param {string} text - The subtitle text that might contain SRT formatting
 * @returns {string} - Cleaned text without SRT formatting
 */
export const cleanSubtitleText = (text) => {
  if (!text) return '';

  // Remove any SRT entry numbers at the beginning of lines
  let cleanedText = text.replace(/^"?\d+\s*$/gm, '');

  // Remove timestamp lines (00:00:00,000 --> 00:00:00,000)
  cleanedText = cleanedText.replace(/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*$/gm, '');

  // Remove any quotes that might be wrapping the entire text
  cleanedText = cleanedText.replace(/^"|"$/g, '');

  // Remove any empty lines that might have been created
  cleanedText = cleanedText.split('\n').filter(line => line.trim()).join('\n');

  return cleanedText.trim();
};

/**
 * Generate SRT content from subtitles
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - SRT content
 */
export const generateSrtContent = (subtitles) => {
  return subtitles.map((subtitle, index) => {
    // Always convert to proper SRT format (HH:MM:SS,mmm)
    let startTime, endTime;

    // If we have numeric start/end values, convert them to SRT format
    if (subtitle.start !== undefined) {
      startTime = secondsToSrtTime(subtitle.start);
    }
    // If we have startTime string, ensure it's in SRT format
    else if (subtitle.startTime) {
      // Check if it's already in SRT format
      if (/^\d{2}:\d{2}:\d{2},\d{3}$/.test(subtitle.startTime)) {
        startTime = subtitle.startTime;
      } else {
        // Try to parse and convert to SRT format
        const timeInSeconds = parseTimeString(subtitle.startTime);
        startTime = secondsToSrtTime(timeInSeconds);
      }
    } else {
      startTime = '00:00:00,000';
    }

    // Same for end time
    if (subtitle.end !== undefined) {
      endTime = secondsToSrtTime(subtitle.end);
    }
    else if (subtitle.endTime) {
      if (/^\d{2}:\d{2}:\d{2},\d{3}$/.test(subtitle.endTime)) {
        endTime = subtitle.endTime;
      } else {
        const timeInSeconds = parseTimeString(subtitle.endTime);
        endTime = secondsToSrtTime(timeInSeconds);
      }
    } else {
      endTime = '00:00:05,000';
    }

    // Clean the subtitle text to remove any SRT formatting that might be embedded in it
    const cleanedText = cleanSubtitleText(subtitle.text);

    return `${index + 1}\n${startTime} --> ${endTime}\n${cleanedText}`;
  }).join('\n\n');
};

/**
 * Download subtitles as SRT file
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadSRT = (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    console.error('No subtitles to download');
    return;
  }

  const content = generateSrtContent(subtitles);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'subtitles.srt';
  document.body.appendChild(a);
  a.click();

  // Clean up
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
};

/**
 * Generate JSON content from subtitles
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - JSON content
 */
export const generateJsonContent = (subtitles) => {
  // Create a clean version of the subtitles with consistent properties
  const cleanSubtitles = subtitles.map((subtitle, index) => {
    // Convert any startTime/endTime strings to numeric values if needed
    let start = subtitle.start;
    let end = subtitle.end;

    // If we have startTime/endTime strings but no numeric values, convert them
    if (subtitle.startTime && start === undefined) {
      // Parse the SRT time format (00:00:00,000) to seconds
      const [hours, minutes, secondsMs] = subtitle.startTime.split(':');
      const [seconds, ms] = secondsMs.split(',');
      start = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds) + parseInt(ms) / 1000;
    }

    if (subtitle.endTime && end === undefined) {
      const [hours, minutes, secondsMs] = subtitle.endTime.split(':');
      const [seconds, ms] = secondsMs.split(',');
      end = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds) + parseInt(ms) / 1000;
    }

    return {
      id: index + 1,
      start: start,
      end: end,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      text: subtitle.text
    };
  });

  return JSON.stringify(cleanSubtitles, null, 2); // Pretty print with 2 spaces
};

/**
 * Download subtitles as JSON file
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadJSON = (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    console.error('No subtitles to download');
    return;
  }

  const content = generateJsonContent(subtitles);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'subtitles.json';
  document.body.appendChild(a);
  a.click();

  // Clean up
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
};

/**
 * Generate plain text content from subtitles (without timings)
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - Plain text content
 */
export const generateTxtContent = (subtitles) => {
  return subtitles.map(subtitle => subtitle.text).join('\n');
};

/**
 * Download subtitles as TXT file (text only, no timings)
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadTXT = (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    console.error('No subtitles to download');
    return;
  }

  const content = generateTxtContent(subtitles);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'subtitles.txt';
  document.body.appendChild(a);
  a.click();

  // Clean up
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);

  // Return the plain text content for potential further processing
  return content;
};

/**
 * Convert a Blob or File to a base64 string (without the `data:` URL prefix).
 *
 * Single source for what used to be four near-identical copies (fileUtils.fileToBase64,
 * gemini/utils.fileToBase64, transcriptionService.blobToBase64, imageGenerationService).
 * Rejects on an empty/invalid input or a FileReader result that isn't a data URL.
 *
 * @param {Blob|File} blobOrFile - the blob/file to convert
 * @returns {Promise<string>} - Promise resolving to the base64-encoded contents
 */
export const toBase64 = (blobOrFile) => {
  return new Promise((resolve, reject) => {
    if (!blobOrFile || blobOrFile.size === 0) {
      reject(new Error('Invalid or empty blob/file provided to toBase64'));
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      // result is a data URL: data:<mediatype>;base64,<data>
      if (!result || String(result).indexOf(',') === -1) {
        reject(new Error('FileReader result is not a data URL'));
        return;
      }
      const base64String = String(result).split(',')[1];
      if (!base64String) {
        reject(new Error('Failed to extract base64 data from FileReader result'));
        return;
      }
      resolve(base64String);
    };
    reader.onerror = (error) => reject(error);
    try {
      reader.readAsDataURL(blobOrFile);
    } catch (error) {
      reject(error);
    }
  });
};

/** @deprecated Use {@link toBase64}. Kept as an alias for existing `fileToBase64` imports. */
export const fileToBase64 = toBase64;

/**
 * Extract audio from a video and download it
 * @param {string} videoPath - Path to the video file
 * @param {string} filename - Name of the file to download (without extension)
 * @returns {Promise<boolean>} - Promise resolving to success status
 */
export const extractAndDownloadAudio = async (videoPath, _filename = 'audio') => {
  try {
    const nativeAssetId = resolveActiveNativeMediaAssetId(videoPath);
    if (nativeAssetId === null) {
      throw new Error('Select the media again before extracting audio.');
    }
    const result = await runMediaPipeline({
      operation: 'extractAudio',
      assetId: nativeAssetId,
      format: 'mp3',
      range: null,
    });
    if (result?.kind !== 'media') throw new Error('Audio extraction returned no media.');
    const exported = await exportMediaAsset(result.media.asset.id);
    return exported.status === 'completed';
  } catch (error) {
    console.error('Error extracting audio:', error);
    return false;
  }
};
