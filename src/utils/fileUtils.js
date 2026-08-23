import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { exportMediaAsset } from '../platform/mediaExportService';
import { runMediaPipeline } from '../platform/mediaPipelineService';
import { isDesktopRuntime } from '../platform/runtimeEnvironment';
import { exportSubtitleDocument } from '../platform/subtitleDocumentExportService';
import {
  parseSubtitleTimeSeconds,
  secondsToSrtTimestamp,
  serializeJsonSubtitleDocument,
  serializeSrtDocument,
  serializeTextSubtitleDocument,
} from './subtitleDocumentSerializer';

const downloadBrowserDocument = (content, mimeType, filename) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 100);
  return Object.freeze({ status: 'saved' });
};

const saveSubtitleDocument = async (content, format, filename, mimeType) => {
  if (!isDesktopRuntime()) {
    return downloadBrowserDocument(content, mimeType, filename);
  }
  return exportSubtitleDocument({ suggestedName: filename, format, content });
};

export const downloadTextDocument = async (content, filename = 'document.txt') => {
  if (typeof content !== 'string') {
    throw new TypeError('A text document is required');
  }
  return saveSubtitleDocument(content, 'txt', filename, 'text/plain;charset=utf-8');
};

/**
 * Parse time string (00:00:00,000 or 00:00:00.000) to seconds
 * @param {string} timeString - Time string in format 00:00:00,000 or 00:00:00.000
 * @returns {number} - Time in seconds
 */
export const parseTimeString = (timeString) => {
  return parseSubtitleTimeSeconds(timeString);
};

/**
 * Convert seconds to SRT time format (HH:MM:SS,mmm)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Time in SRT format
 */
export const secondsToSrtTime = (seconds) => {
  return secondsToSrtTimestamp(seconds);
};

/**
 * Clean subtitle text by removing any SRT formatting that might be embedded in it
 * @param {string} text - The subtitle text that might contain SRT formatting
 * @returns {string} - Cleaned text without SRT formatting
 */
export const cleanSubtitleText = (text) => {
  return typeof text === 'string' ? text : '';
};

/**
 * Generate SRT content from subtitles
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - SRT content
 */
export const generateSrtContent = (subtitles) => {
  return serializeSrtDocument(subtitles);
};

/**
 * Download subtitles as SRT file
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadSRT = async (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    throw new TypeError('Subtitles are required');
  }

  const content = generateSrtContent(subtitles);
  return saveSubtitleDocument(
    content,
    'srt',
    filename || 'subtitles.srt',
    'text/plain;charset=utf-8'
  );
};

/**
 * Generate JSON content from subtitles
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - JSON content
 */
export const generateJsonContent = (subtitles) => {
  return serializeJsonSubtitleDocument(subtitles);
};

/**
 * Download subtitles as JSON file
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadJSON = async (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    throw new TypeError('Subtitles are required');
  }

  const content = generateJsonContent(subtitles);
  return saveSubtitleDocument(
    content,
    'json',
    filename || 'subtitles.json',
    'application/json;charset=utf-8'
  );
};

/**
 * Generate plain text content from subtitles (without timings)
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - Plain text content
 */
export const generateTxtContent = (subtitles) => {
  return serializeTextSubtitleDocument(subtitles);
};

/**
 * Download subtitles as TXT file (text only, no timings)
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} filename - Name of the file to download
 */
export const downloadTXT = async (subtitles, filename) => {
  if (!subtitles || subtitles.length === 0) {
    throw new TypeError('Subtitles are required');
  }

  const content = generateTxtContent(subtitles);
  const result = await saveSubtitleDocument(
    content,
    'txt',
    filename || 'subtitles.txt',
    'text/plain;charset=utf-8'
  );

  return Object.freeze({ ...result, content });
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
    const capability = await resolveActiveNativeMedia({ candidate: videoPath });
    const result = await runMediaPipeline({
      operation: 'extractAudio',
      assetId: capability.assetId,
      format: 'mp3',
      range: null,
    });
    await revalidateActiveNativeMedia(capability);
    if (result?.kind !== 'media') throw new Error('Audio extraction returned no media.');
    const exported = await exportMediaAsset(result.media.asset.id);
    await revalidateActiveNativeMedia(capability);
    return exported.status === 'completed';
  } catch (error) {
    console.error('Error extracting audio:', error);
    return false;
  }
};
