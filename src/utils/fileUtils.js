import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { exportMediaAsset } from '../platform/mediaExportService';
import { runMediaPipeline } from '../platform/mediaPipelineService';
import { exportSubtitleDocument } from '../platform/subtitleDocumentExportService';
import {
  serializeJsonSubtitleDocument,
  serializeSrtDocument,
  serializeTextSubtitleDocument,
} from './subtitleDocumentSerializer';

const saveSubtitleDocument = async (content, format, filename) => (
  exportSubtitleDocument({ suggestedName: filename, format, content })
);

export const downloadTextDocument = async (content, filename = 'document.txt') => {
  if (typeof content !== 'string') {
    throw new TypeError('A text document is required');
  }
  return saveSubtitleDocument(content, 'txt', filename);
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
    filename || 'subtitles.srt'
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
    filename || 'subtitles.json'
  );
};

/**
 * Generate plain text content from subtitles (without timings)
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - Plain text content
 */
const generateTxtContent = (subtitles) => {
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
    filename || 'subtitles.txt'
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
