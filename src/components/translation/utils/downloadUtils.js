import { downloadSRT, downloadJSON, downloadTXT } from '../../../utils/fileUtils';

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
  // Get uploaded SRT info
  let sourceSubtitleName = '';
  try {
    const uploadedSrtInfo = localStorage.getItem('uploaded_srt_info');
    if (uploadedSrtInfo) {
      const srtInfo = JSON.parse(uploadedSrtInfo);
      if (srtInfo.hasUploaded && srtInfo.fileName) {
        sourceSubtitleName = srtInfo.fileName;
      }
    }
  } catch (error) {
    console.error('Error parsing uploaded SRT info:', error);
  }

  return {
    sourceSubtitleName,
    videoName: videoTitle,
    targetLanguages
  };
};

/**
 * Handle download request from modal.
 * @param {string} source - 'translated' or 'original'
 * @param {string} format - 'srt' | 'json' | 'txt'
 * @param {Object} namingInfo - Optional naming info override
 * @param {Object} ctx - { translatedSubtitles, subtitles, videoTitle, targetLanguages, setTxtContent }
 */
export const handleDownload = (source, format, namingInfo = {}, ctx) => {
  const { translatedSubtitles, subtitles, videoTitle, targetLanguages, setTxtContent } = ctx;
  const subtitlesToUse = source === 'translated' ? translatedSubtitles : subtitles;

  if (subtitlesToUse && subtitlesToUse.length > 0) {
    // Use provided naming info or get it from local state
    const finalNamingInfo = Object.keys(namingInfo).length > 0 ? namingInfo : getNamingInfo(videoTitle, targetLanguages);
    const baseFilename = generateFilename(source, finalNamingInfo, videoTitle);

    switch (format) {
      case 'srt':
        downloadSRT(subtitlesToUse, `${baseFilename}.srt`);
        break;
      case 'json':
        downloadJSON(subtitlesToUse, `${baseFilename}.json`);
        break;
      case 'txt': {
        const content = downloadTXT(subtitlesToUse, `${baseFilename}.txt`);
        setTxtContent(content);
        break;
      }
      default:
        break;
    }
  }
};

/**
 * Handle bulk download all (includes main translation + bulk translations).
 * @param {Object} ctx - { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages }
 */
export const handleBulkDownloadAll = (ctx) => {
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
  allDownloads.forEach(download => {
    if (download.format === 'json') {
      downloadJSON(download.subtitles, download.filename);
    } else {
      downloadSRT(download.subtitles, download.filename);
    }
  });
};

/**
 * Handle bulk download as ZIP.
 * @param {Object} ctx - { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages }
 */
export const handleBulkDownloadZip = async (ctx) => {
  const { translatedSubtitles, bulkTranslations, videoTitle, targetLanguages } = ctx;
  try {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    // Add main translation if available (always as SRT since it comes from video processing)
    if (translatedSubtitles && translatedSubtitles.length > 0) {
      const namingInfo = getNamingInfo(videoTitle, targetLanguages);
      const baseFilename = generateFilename('translated', namingInfo, videoTitle);

      // Add SRT version only
      const srtContent = translatedSubtitles.map(subtitle =>
        `${subtitle.index}\n${subtitle.start} --> ${subtitle.end}\n${subtitle.text}\n`
      ).join('\n');
      zip.file(`${baseFilename}.srt`, srtContent);
    }

    // Add bulk translations (in same format as original files)
    bulkTranslations.forEach(bulkTranslation => {
      if (bulkTranslation.success && bulkTranslation.translatedSubtitles) {
        const originalFile = bulkTranslation.originalFile;
        const originalFormat = originalFile.name.toLowerCase().endsWith('.json') ? 'json' : 'srt';

        // Generate filename with target languages
        const baseFilename = generateBulkFilename(originalFile.name, targetLanguages);
        const filename = `${baseFilename}.${originalFormat}`;

        // Add in original format only
        if (originalFormat === 'json') {
          const jsonContent = JSON.stringify(bulkTranslation.translatedSubtitles, null, 2);
          zip.file(filename, jsonContent);
        } else {
          const srtContent = bulkTranslation.translatedSubtitles.map(subtitle =>
            `${subtitle.index}\n${subtitle.start} --> ${subtitle.end}\n${subtitle.text}\n`
          ).join('\n');
          zip.file(filename, srtContent);
        }
      }
    });

    // Generate ZIP file
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Create descriptive ZIP filename
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const targetLanguagesSuffix = targetLanguages.length > 0
      ? `_${targetLanguages.map(lang => lang.value.toLowerCase().replace(/\s+/g, '_')).join('_')}`
      : '';
    const zipFilename = `translated_subtitles${targetLanguagesSuffix}_${timestamp}.zip`;

    // Create download link
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = zipFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Error creating ZIP file:', error);
    // Fallback to individual downloads
    handleBulkDownloadAll(ctx);
  }
};
