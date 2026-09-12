import {
  downloadJSON,
  downloadSRT,
  generateJsonContent,
  generateSrtContent,
} from '../../../utils/fileUtils';
import { isDesktopRuntime } from '../../../platform/runtimeEnvironment';
import {
  exportSubtitleArchive,
  normalizeSubtitleArchiveEntries,
} from '../../../platform/subtitleDocumentExportService';
import { subtitleImportFileNameForCache } from '../../../platform/subtitleImportProvenance';
import { getCurrentCacheId } from '../../../utils/userSubtitlesStore';

/**
 * Generate comprehensive filename based on priority system.
 * @param {string} source - 'translated' or 'original'
 * @param {Object} namingInfo - { sourceSubtitleName, videoName, targetLanguages }
 * @param {string} videoTitle - Fallback video title
 * @returns {string} - Base filename (no extension)
 */
export const generateFilename = (source, namingInfo = {}, videoTitle) => {
  const { sourceSubtitleName = '', videoName = '', targetLanguages: targetLangs = [] } = namingInfo;

  // Priority 1: Source subtitle name (remove extension)
  let baseName = '';
  if (sourceSubtitleName) {
    baseName = sourceSubtitleName.replace(/\.(srt|json)$/i, '');
  }
  // Priority 2: Video name (remove extension)
  else if (videoName) {
    baseName = videoName.replace(/\.[^/.]+$/, '');
  }
  // Fallback: Use video title or default
  else {
    baseName = videoTitle || 'subtitles';
  }

  // Add language suffix for translations
  let langSuffix = '';
  if (source === 'translated' && targetLangs.length > 0) {
    if (targetLangs.length === 1) {
      // Single language: use the language name
      const langName = targetLangs[0].value || targetLangs[0];
      langSuffix = `_${langName.toLowerCase().replace(/\s+/g, '_')}`;
    } else {
      // Multiple languages: use multi_lang
      langSuffix = '_multi_lang';
    }
  }

  return `${baseName}${langSuffix}`;
};

/**
 * Generate filename for bulk translations.
 * @param {string} originalName - Original file name
 * @param {Array} targetLanguages - Target languages
 * @returns {string} - Base filename (no extension)
 */
export const generateBulkFilename = (originalName, targetLanguages) => {
  // Remove extension from original name
  const baseName = originalName.replace(/\.(srt|json)$/i, '');

  // Create language suffix
  const languageSuffix = targetLanguages.map(lang => lang.value || lang).join('_');

  return `${baseName}_${languageSuffix}`;
};

/**
 * Get naming information for downloads.
 * @param {string} videoTitle - Video title used as videoName
 * @param {Array} targetLanguages - Target languages
 * @returns {Object} - { sourceSubtitleName, videoName, targetLanguages }
 */
export const getNamingInfo = (videoTitle, targetLanguages) => {
  const sourceSubtitleName = subtitleImportFileNameForCache(getCurrentCacheId());

  return {
    sourceSubtitleName,
    videoName: videoTitle,
    targetLanguages
  };
};

/**
 * Handle bulk download all (includes main translation + bulk translations).
 * @param {Object} ctx - { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages }
 */
export const handleBulkDownloadAll = async (ctx) => {
  const { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages } = ctx;
  const allDownloads = [];

  // Add main translation if available (always as SRT since it comes from video processing)
  if (translatedSubtitles && translatedSubtitles.length > 0) {
    const namingInfo = getNamingInfo(videoTitle, targetLanguages);
    const baseFilename = generateFilename('translated', namingInfo, videoTitle);

    allDownloads.push({
      subtitles: translatedSubtitles,
      filename: `${baseFilename}.srt`,
      format: 'srt'
    });
  }

  // Add bulk translations
  const successfulBulkTranslations = bulkTranslations.filter(bt => bt.success);
  successfulBulkTranslations.forEach(bulkTranslation => {
    const originalFile = bulkTranslation.originalFile;
    const translatedBulkSubtitles = bulkTranslation.translatedSubtitles;
    const originalFormat = originalFile.name.toLowerCase().endsWith('.json') ? 'json' : 'srt';

    // Generate filename with target languages
    const baseFilename = generateBulkFilename(originalFile.name, targetLanguages);
    const filename = `${baseFilename}.${originalFormat}`;

    allDownloads.push({
      subtitles: translatedBulkSubtitles,
      filename: filename,
      format: originalFormat
    });
  });

  // Download all files
  let savedCount = 0;
  for (const download of allDownloads) {
    const result = download.format === 'json'
      ? await downloadJSON(download.subtitles, download.filename)
      : await downloadSRT(download.subtitles, download.filename);
    if (result.status !== 'saved') {
      return Object.freeze({ status: 'cancelled', savedCount, totalCount: allDownloads.length });
    }
    savedCount += 1;
  }
  return Object.freeze({ status: 'saved', savedCount, totalCount: allDownloads.length });
};

const buildArchiveEntries = ({
  translatedSubtitles,
  bulkTranslations,
  videoTitle,
  targetLanguages,
}) => {
  const entries = [];
  if (translatedSubtitles && translatedSubtitles.length > 0) {
    const namingInfo = getNamingInfo(videoTitle, targetLanguages);
    const baseFilename = generateFilename('translated', namingInfo, videoTitle);
    entries.push({
      suggestedName: `${baseFilename}.srt`,
      format: 'srt',
      content: generateSrtContent(translatedSubtitles),
    });
  }
  for (const bulkTranslation of bulkTranslations) {
    if (!bulkTranslation.success || !bulkTranslation.translatedSubtitles) continue;
    const originalFile = bulkTranslation.originalFile;
    const format = originalFile.name.toLowerCase().endsWith('.json') ? 'json' : 'srt';
    const baseFilename = generateBulkFilename(originalFile.name, targetLanguages);
    entries.push({
      suggestedName: `${baseFilename}.${format}`,
      format,
      content: format === 'json'
        ? generateJsonContent(bulkTranslation.translatedSubtitles)
        : generateSrtContent(bulkTranslation.translatedSubtitles),
    });
  }
  return normalizeSubtitleArchiveEntries(entries);
};

/**
 * Handle bulk download as ZIP.
 * @param {Object} ctx - { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages }
 */
export const handleBulkDownloadZip = async (ctx) => {
  const { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages } = ctx;
  try {
    const entries = buildArchiveEntries({
      translatedSubtitles,
      bulkTranslations,
      videoTitle,
      targetLanguages,
    });

    // Create descriptive ZIP filename
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const targetLanguagesSuffix = targetLanguages.length > 0
      ? `_${targetLanguages.map(lang => lang.value.toLowerCase().replace(/\s+/g, '_')).join('_')}`
      : '';
    const zipFilename = `translated_subtitles${targetLanguagesSuffix}_${timestamp}.zip`;

    if (isDesktopRuntime()) {
      return exportSubtitleArchive(entries, zipFilename);
    }

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const entry of entries) zip.file(entry.suggestedName, entry.content);
    const zipPayload = await zip.generateAsync({ type: 'blob' });

    // Create download link
    const url = URL.createObjectURL(zipPayload);
    const link = document.createElement('a');
    link.href = url;
    link.download = zipFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return Object.freeze({ status: 'saved' });

  } catch (error) {
    console.error('Error creating ZIP file:', error);
    if (isDesktopRuntime()) throw error;
    // Fallback to individual downloads
    return handleBulkDownloadAll(ctx);
  }
};

/**
 * Acquire the synchronous UI lease used by bulk export buttons.
 * The returned promise always settles, so React event handlers cannot create an
 * unhandled rejection when a native dialog or write fails.
 *
 * @param {Object} options
 * @param {{current: boolean}} options.pendingRef
 * @param {(pending: boolean) => void} options.setPending
 * @param {() => Promise<Object>} options.operation
 * @param {(error: unknown) => void} [options.onError]
 * @returns {Promise<Object>}
 */
export const runOwnedBulkExport = async ({ pendingRef, setPending, operation, onError }) => {
  if (pendingRef.current) return Object.freeze({ status: 'busy' });
  pendingRef.current = true;
  let result;
  try {
    setPending(true);
    result = await operation();
  } catch (error) {
    try {
      onError?.(error);
    } catch (notificationError) {
      try {
        console.error('Could not report subtitle export failure:', notificationError);
      } catch {
        // Reporting must never strand or replace the primary export result.
      }
    }
    result = Object.freeze({ status: 'failed' });
  } finally {
    pendingRef.current = false;
    try {
      setPending(false);
    } catch (releaseError) {
      try {
        console.error('Could not publish released subtitle export state:', releaseError);
      } catch {
        // The synchronous ref is authoritative and has already been released.
      }
    }
  }
  return result;
};
