import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadSRT, downloadJSON, downloadTXT } from '../../utils/fileUtils';
import { completeDocument, summarizeDocument } from '../../services/geminiService';
import useTranslationState, { getCurrentMediaId, generateSubtitleHash } from '../../hooks/useTranslationState';
import useLanguageChain from '../../hooks/useLanguageChain';
import TranslationHeader from './TranslationHeader';
import LanguageChain from './LanguageChain';
import ModelSelection from './ModelSelection';
import SplitDurationSlider from './SplitDurationSlider';
import RestTimeSlider from './RestTimeSlider';
import RulesToggle from './RulesToggle';
import TranslationPromptEditorButton from './TranslationPromptEditorButton';
import TranslationActions from './TranslationActions';
import TranslationStatus from './TranslationStatus';
import TranslationError from './TranslationError';
import TranslationPreview from './TranslationPreview';
import BulkTranslationPreview from './BulkTranslationPreview';
import TranslationComplete from './TranslationComplete';
import SliderWithValue from '../common/SliderWithValue';
import HelpIcon from '../common/HelpIcon';

import { autoSplitSubtitles, countWords } from '../../utils/subtitle/splitUtils';
// Narration section moved to OutputContainer
import '../../styles/translation/index.css';
import '../../styles/translation/languageChain.css';
// Narration styles moved to OutputContainer

/**
 * Translation section component
 * @param {Object} props - Component props
 * @param {Array} props.subtitles - Subtitles to translate
 * @param {string} props.videoTitle - Video title for download filenames
 * @param {Function} props.onTranslationComplete - Callback when translation is complete
 * @returns {JSX.Element} - Rendered component
 */
const TranslationSection = ({ subtitles, videoTitle, onTranslationComplete }) => {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [txtContent, setTxtContent] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [isProcessing, setIsProcessing] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [processedDocument, setProcessedDocument] = useState(null);

  // Refs for height animation
  const containerRef = useRef(null);
  const contentRef = useRef(null);

  // Use language chain hook for managing languages and delimiters
  const {
    chainItems,
    addLanguage,
    addOriginalLanguage,
    addDelimiter,
    removeItem,
    updateLanguage,
    updateDelimiter,
    moveItem,
    getLanguageValues,
    getDelimiterValues,
    hasValidLanguage,
    hasOnlyOriginalLanguage
  } = useLanguageChain(false); // false = don't include original language by default

  // Get target languages from chain items
  const targetLanguages = chainItems.filter(item => item.type === 'language' && !item.isOriginal);

  const {
    isTranslating,
    translatedSubtitles,
    error,
    translationStatus,
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules,
    rulesAvailable,
    hasUserProvidedSubtitles,
    loadedFromCache,
    statusRef,
    handleModelSelect,
    handleSavePrompt,
    handleTranslate: translate,
    handleCancelTranslation,
    handleReset,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
    updateTranslatedSubtitles,
    // Bulk translation
    bulkFiles,
    setBulkFiles,
    bulkTranslations,
    setBulkTranslations,
    isBulkTranslating,
    currentBulkFileIndex,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  } = useTranslationState(subtitles, onTranslationComplete);

  // Post-split translated subtitles (1–30 and Unlimited=31). Default: Unlimited
  const [postSplitMaxWords, setPostSplitMaxWords] = useState(() => {
    const saved = localStorage.getItem('translation_post_split_max_words');
    let num = saved ? parseInt(saved, 10) : 31; // Default Unlimited (31)
    if (!Number.isFinite(num)) num = 31;
    // Migrate legacy 0 (old Unlimited) to 31
    if (num === 0) num = 31;
    // Clamp to [1..31]
    if (num < 1) num = 1;
    if (num > 31) num = 31;
    return num;
  });

  // Persist post-split setting
  useEffect(() => {
    try {
      localStorage.setItem('translation_post_split_max_words', String(postSplitMaxWords));
    } catch {}
  }, [postSplitMaxWords]);

  // Apply post-split to translated subtitles when needed
  useEffect(() => {
    if (!Array.isArray(translatedSubtitles) || translatedSubtitles.length === 0) return;

    const v = Number(postSplitMaxWords);
    if (!Number.isFinite(v) || v >= 31) return; // Unlimited

    const limit = Math.max(1, v);

    // Only split when any subtitle exceeds the limit
    const exceeds = translatedSubtitles.some(s => countWords(s?.text || '') > limit);
    if (!exceeds) return;

    const split = autoSplitSubtitles(translatedSubtitles, limit);
    updateTranslatedSubtitles(split);

    try {
      window.dispatchEvent(new CustomEvent('translation-updated', {
        detail: { translatedSubtitles: split, source: 'post-split' }
      }));
    } catch {}
  }, [translatedSubtitles, postSplitMaxWords, updateTranslatedSubtitles]);


  /**
   * Handle retry for a specific segment
   * @param {Object} segment - Segment info object
   */
  const handleRetrySegment = useCallback(async (segment) => {
    if (!translatedSubtitles || !subtitles) return;

    try {
      // For bulk translations, we need to get the correct subtitle array
      let sourceSubtitles = subtitles;

      if (segment.isFromBulk && segment.fileId && segment.fileId !== 'main') {
        // Find the bulk translation result to get the original file reference
        const bulkTranslationIndex = parseInt(segment.fileId.replace('bulk-', ''));
        const bulkTranslation = bulkTranslations[bulkTranslationIndex];

        if (bulkTranslation && bulkTranslation.originalFile) {
          // Find the corresponding bulk file with original subtitles
          const bulkFile = bulkFiles.find(bf => bf.id === bulkTranslation.originalFile.id);

          if (bulkFile && bulkFile.subtitles) {
            sourceSubtitles = bulkFile.subtitles;
          } else {
            console.error('Could not find original subtitles for bulk file:', segment.fileId);
            return;
          }
        } else {
          console.error('Could not find bulk translation for fileId:', segment.fileId);
          return;
        }
      }
      // For main translation (fileId === 'main' or no fileId), use the original subtitles array

      // Extract the subtitles for this segment from the correct source
      let segmentSubtitles;
      let contextStartIndex = segment.startIndex;
      let contextEndIndex = segment.endIndex;
      let targetSubtitleIndices = [];

      // Check if this is a single subtitle retry (indicated by segmentNumber starting with "subtitle-")
      const isSingleSubtitleRetry = typeof segment.segmentNumber === 'string' && segment.segmentNumber.startsWith('subtitle-');

      if (isSingleSubtitleRetry) {
        // For individual subtitle retry, just retry that single subtitle without extra context
        // This ensures we get exactly one translation back
        const targetIndex = segment.startIndex; // The subtitle we want to retry

        // Extract just the target subtitle
        segmentSubtitles = [sourceSubtitles[targetIndex]];

        // Set context indices to match single subtitle
        contextStartIndex = targetIndex;
        contextEndIndex = targetIndex;

        // Track that we're updating just one subtitle
        targetSubtitleIndices = [0]; // Index 0 in the result array

        console.log(`Retrying subtitle ${targetIndex + 1} (single subtitle)`);
      } else {
        // For segment retry, use the original logic
        segmentSubtitles = sourceSubtitles.slice(segment.startIndex, segment.endIndex + 1);
        // All subtitles in the segment are targets for update
        targetSubtitleIndices = Array.from({ length: segmentSubtitles.length }, (_, i) => i);
      }

      // Show status
      let statusMessage;
      if (isSingleSubtitleRetry) {
        const subtitleNumber = segment.startIndex + 1;
        statusMessage = t('translation.retryingSubtitle', 'Retrying subtitle {{subtitle}}...', {
          subtitle: subtitleNumber
        });
      } else {
        statusMessage = t('translation.retryingSegment', 'Retrying segment {{segment}}...', {
          segment: segment.segmentNumber
        });
      }

      // Dispatch status event
      window.dispatchEvent(new CustomEvent('translation-status', {
        detail: { message: statusMessage }
      }));

      // Get the target languages
      const languages = getLanguageValues();
      if (languages.length === 0) return;

      // Import the translation function
      const { translateSubtitles } = await import('../../services/gemini/translation');
      const { getSimpleTranslationPrompt } = await import('../../services/gemini/promptManagement');

      // For single subtitle retry, use a much simpler custom prompt to avoid instruction translation
      let retryPrompt = customTranslationPrompt;
      if (isSingleSubtitleRetry && !customTranslationPrompt) {
        // Use the simple translation prompt for single subtitle
        const subtitleText = segmentSubtitles[0].text; // Get the single subtitle text
        const targetLang = languages.length === 1 ? languages[0] : languages;
        retryPrompt = getSimpleTranslationPrompt(subtitleText, targetLang);
      }

      // Translate just this segment
      const result = await translateSubtitles(
        segmentSubtitles,
        languages.length === 1 ? languages[0] : languages,
        selectedModel,
        retryPrompt, // Use retry prompt which might be simpler for single subtitle
        0, // No split duration for segment retry
        includeRules && !isSingleSubtitleRetry, // Don't include rules for single subtitle retry
        ' ', // Default delimiter
        false, // No parentheses
        null, // No bracket style
        chainItems, // Pass chain items
        `segment-${segment.segmentNumber}` // File context
      );

      if (result && result.length > 0) {
        if (segment.isFromBulk && segment.fileId && segment.fileId !== 'main') {
          // For bulk translations, update the specific bulk translation result
          const bulkTranslationIndex = parseInt(segment.fileId.replace('bulk-', ''));
          const updatedBulkTranslations = [...bulkTranslations];

          if (updatedBulkTranslations[bulkTranslationIndex]) {
            const newTranslatedSubtitles = [...updatedBulkTranslations[bulkTranslationIndex].translatedSubtitles];

            // Replace the segment in the bulk translation
            if (isSingleSubtitleRetry) {
              // For single subtitle retry, we have exactly one result
              if (result.length === 1 && segment.startIndex < newTranslatedSubtitles.length) {
                newTranslatedSubtitles[segment.startIndex] = result[0];
                console.log(`Updated subtitle ${segment.startIndex + 1} in bulk translation`);
              } else {
                console.warn(`Single subtitle retry returned ${result.length} results, expected 1`);
              }
            } else {
              // For segment retry, update all subtitles in the segment
              // Only update up to the minimum of result length and segment size
              const updateCount = Math.min(result.length, segment.endIndex - segment.startIndex + 1);
              for (let i = 0; i < updateCount; i++) {
                const targetIndex = segment.startIndex + i;
                if (targetIndex < newTranslatedSubtitles.length) {
                  newTranslatedSubtitles[targetIndex] = result[i];
                }
              }
              console.log(`Updated ${updateCount} subtitles in segment ${segment.segmentNumber}`);
            }

            // Update the bulk translation result
            updatedBulkTranslations[bulkTranslationIndex] = {
              ...updatedBulkTranslations[bulkTranslationIndex],
              translatedSubtitles: newTranslatedSubtitles
            };

            // Update the bulk translations state
            setBulkTranslations(updatedBulkTranslations);
          }
        } else {
          // For main translation (fileId === 'main' or no fileId), update the main translated subtitles
          const newTranslatedSubtitles = [...translatedSubtitles];

          if (isSingleSubtitleRetry) {
            // For single subtitle retry, we have exactly one result
            if (result.length === 1 && segment.startIndex < newTranslatedSubtitles.length) {
              newTranslatedSubtitles[segment.startIndex] = result[0];
              console.log(`Updated subtitle ${segment.startIndex + 1} in main translation`);
            } else {
              console.warn(`Single subtitle retry returned ${result.length} results, expected 1`);
            }
          } else {
            // For segment retry, update all subtitles in the segment
            // Only update up to the minimum of result length and segment size
            const updateCount = Math.min(result.length, segment.endIndex - segment.startIndex + 1);
            for (let i = 0; i < updateCount; i++) {
              const targetIndex = segment.startIndex + i;
              if (targetIndex < newTranslatedSubtitles.length) {
                newTranslatedSubtitles[targetIndex] = result[i];
              }
            }
            console.log(`Updated ${updateCount} subtitles in segment ${segment.segmentNumber}`);
          }

          // Update the translated subtitles state
          updateTranslatedSubtitles(newTranslatedSubtitles);

          // CRITICAL: Update the parent component's state via onTranslationComplete
          if (onTranslationComplete) {
            onTranslationComplete(newTranslatedSubtitles);
          }

          // Update the global window.translatedSubtitles for consistency
          window.translatedSubtitles = newTranslatedSubtitles;

          // Dispatch event to notify other components of the update
          window.dispatchEvent(new CustomEvent('translation-updated', {
            detail: {
              translatedSubtitles: newTranslatedSubtitles,
              source: 'retry'
            }
          }));

          // Update the cache with the new translations
          try {
            const mediaId = getCurrentMediaId();
            if (mediaId) {
              const subtitleHash = generateSubtitleHash(subtitles);
              const cacheEntry = {
                mediaId,
                subtitleHash,
                timestamp: Date.now(),
                translations: newTranslatedSubtitles
              };
              localStorage.setItem('translated_subtitles_cache', JSON.stringify(cacheEntry));
              console.log('Updated translation cache after retry');
            }
          } catch (error) {
            console.error('Error updating translation cache after retry:', error);
          }
        }

        // Dispatch success event
        window.dispatchEvent(new CustomEvent('translation-status', {
          detail: {
            message: t('translation.translationComplete', 'Translation complete')
          }
        }));
      }
    } catch (error) {
      console.error('Segment retry failed:', error);
      window.dispatchEvent(new CustomEvent('translation-status', {
        detail: {
          message: `Segment ${segment.segmentNumber} retry failed: ${error.message}`,
          isError: true
        }
      }));
    }
  }, [translatedSubtitles, subtitles, t, getLanguageValues, selectedModel, customTranslationPrompt, includeRules, chainItems, updateTranslatedSubtitles, bulkFiles, bulkTranslations, onTranslationComplete]);

  // Initialize container height on component mount
  useEffect(() => {
    if (containerRef.current && contentRef.current) {
      // Small delay to ensure the DOM is fully rendered
      setTimeout(() => {
        // Set initial height with extra 100px to ensure enough space
        if (contentRef.current) {
          const contentHeight = contentRef.current.offsetHeight;
          containerRef.current.style.height = `${contentHeight + 150}px`;
        }
      }, 50);
    }
  }, []);

  // Handle height animation when content changes
  useEffect(() => {
    // Use a small delay to ensure the new content is rendered
    const animationTimeout = setTimeout(() => {
      if (containerRef.current && contentRef.current) {
        // Get the height of the content and add 100px for extra space
        const contentHeight = contentRef.current.offsetHeight;

        // Set the container height to match the content height plus extra space
        containerRef.current.style.height = `${contentHeight + 150}px`;
      }
    }, 50); // Small delay to ensure content is rendered

    return () => clearTimeout(animationTimeout);
  }, [translatedSubtitles, isTranslating, error, bulkFiles, bulkTranslations, splitDuration, subtitles]); // Re-run when these state values change

  // Wrapper for handleTranslate to pass the current languages and delimiter settings
  const handleTranslate = () => {
    // Format mode - only original language in the chain
    const isFormatMode = hasOnlyOriginalLanguage();

    // In format mode, we don't need to check for valid languages
    if (!isFormatMode && !hasValidLanguage()) {
      return;
    }

    // Always pass the chain items to ensure the exact arrangement is preserved


    if (isFormatMode) {
      // In format mode, pass empty languages array
      translate([], '', false, null, chainItems);
    } else {
      // In translation mode, pass languages and chain items
      // Get the first delimiter's value and style (if any) as fallback
      const delimiters = getDelimiterValues();
      const firstDelimiter = delimiters.length > 0 ? delimiters[0] : { value: ' ', style: { open: '', close: '' } };

      // Check if we're using brackets (parentheses)
      const useParentheses = firstDelimiter.style && (firstDelimiter.style.open || firstDelimiter.style.close);

      // Get languages for translation
      const languages = getLanguageValues();

      // Pass both the languages and the chain items
      translate(languages, firstDelimiter.value, useParentheses, firstDelimiter.style, chainItems);
    }
  };

  // Generate comprehensive filename based on priority system
  const generateFilename = (source, namingInfo = {}) => {
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

  // Get naming information for downloads
  const getNamingInfo = () => {
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

  // Handle download request from modal
  const handleDownload = (source, format, namingInfo = {}) => {
    const subtitlesToUse = source === 'translated' ? translatedSubtitles : subtitles;

    if (subtitlesToUse && subtitlesToUse.length > 0) {
      // Use provided naming info or get it from local state
      const finalNamingInfo = Object.keys(namingInfo).length > 0 ? namingInfo : getNamingInfo();
      const baseFilename = generateFilename(source, finalNamingInfo);

      switch (format) {
        case 'srt':
          downloadSRT(subtitlesToUse, `${baseFilename}.srt`);
          break;
        case 'json':
          downloadJSON(subtitlesToUse, `${baseFilename}.json`);
          break;
        case 'txt':
          const content = downloadTXT(subtitlesToUse, `${baseFilename}.txt`);
          setTxtContent(content);
          break;
        default:
          break;
      }
    }
  };

  // Generate filename for bulk translations
  const generateBulkFilename = (originalName, targetLanguages) => {
    // Remove extension from original name
    const baseName = originalName.replace(/\.(srt|json)$/i, '');

    // Create language suffix
    const languageSuffix = targetLanguages.map(lang => lang.value || lang).join('_');

    return `${baseName}_${languageSuffix}`;
  };

  // Handle bulk download all (includes main translation + bulk translations)
  const handleBulkDownloadAll = () => {
    const allDownloads = [];

    // Add main translation if available (always as SRT since it comes from video processing)
    if (translatedSubtitles && translatedSubtitles.length > 0) {
      const namingInfo = getNamingInfo();
      const baseFilename = generateFilename('translated', namingInfo);

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
      const translatedSubtitles = bulkTranslation.translatedSubtitles;
      const originalFormat = originalFile.name.toLowerCase().endsWith('.json') ? 'json' : 'srt';

      // Generate filename with target languages
      const baseFilename = generateBulkFilename(originalFile.name, targetLanguages);
      const filename = `${baseFilename}.${originalFormat}`;

      allDownloads.push({
        subtitles: translatedSubtitles,
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

  // Handle bulk download as ZIP
  const handleBulkDownloadZip = async () => {
    try {
      // Dynamic import of JSZip
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Add main translation if available (always as SRT since it comes from video processing)
      if (translatedSubtitles && translatedSubtitles.length > 0) {
        const namingInfo = getNamingInfo();
        const baseFilename = generateFilename('translated', namingInfo);

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
      handleBulkDownloadAll();
    }
  };

  // Handle process request from modal
  const handleProcess = async (source, processType, model, splitDurationParam, customPrompt, namingInfo = {}) => {
    const subtitlesToUse = source === 'translated' ? translatedSubtitles : subtitles;

    if (!subtitlesToUse || subtitlesToUse.length === 0) return;

    // First, get the text content if we don't have it yet
    let textContent = txtContent;
    if (!textContent) {
      textContent = subtitlesToUse.map(subtitle => subtitle.text).join('\\n\\n');
      setTxtContent(textContent);
    }

    setIsProcessing(true);
    try {
      let result;
      // For multi-language translations, use the first non-empty language or null
      let targetLang = null;
      if (source === 'translated') {
        if (targetLanguages.length > 1) {
          // For multi-language, we'll use the first valid language
          const validLanguage = targetLanguages.find(lang => lang.value?.trim() !== '');
          targetLang = validLanguage?.value || null;
        } else {
          targetLang = targetLanguages[0]?.value || null;
        }
      }

      if (processType === 'consolidate') {
        result = await completeDocument(textContent, selectedModel, targetLang);
      } else if (processType === 'summarize') {
        result = await summarizeDocument(textContent, selectedModel, targetLang);
      }

      // Check if the result is JSON and extract plain text
      if (result && typeof result === 'string' && (result.trim().startsWith('{') || result.trim().startsWith('['))) {
        try {
          const jsonResult = JSON.parse(result);


          // For summarize feature
          if (jsonResult.summary) {
            let plainText = jsonResult.summary;

            // Add key points if available
            if (jsonResult.keyPoints && Array.isArray(jsonResult.keyPoints) && jsonResult.keyPoints.length > 0) {
              plainText += '\\n\\nKey Points:\\n';
              jsonResult.keyPoints.forEach((point, index) => {
                plainText += `\\n${index + 1}. ${point}`;
              });
            }

            result = plainText;

          }
          // For consolidate feature
          else if (jsonResult.content) {
            result = jsonResult.content;

          }
          // For any other JSON structure
          else if (jsonResult.text) {
            result = jsonResult.text;

          }
        } catch (e) {

          // Keep the original result if parsing fails
        }
      }

      setProcessedDocument(result);

      // Show success toast using centralized system
      window.addToast(
        processType === 'consolidate'
          ? t('output.documentCompleted', 'Document completed successfully')
          : t('output.summaryCompleted', 'Summary completed successfully'),
        'success',
        3000
      );

      // Download the processed document
      // Use provided naming info or get it from local state
      const finalNamingInfo = Object.keys(namingInfo).length > 0 ? namingInfo : getNamingInfo();
      const baseFilename = generateFilename(source, finalNamingInfo);
      const processTypeSuffix = processType === 'consolidate' ? 'completed' : 'summary';
      const filename = `${baseFilename}_${processTypeSuffix}.txt`;

      const blob = new Blob([result], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();

      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (error) {
      console.error(`Error ${processType === 'consolidate' ? 'completing' : 'summarizing'} document:`, error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="translation-section" ref={containerRef}>
      <TranslationHeader
        promptEditorButton={
          <TranslationPromptEditorButton
            customPrompt={customTranslationPrompt}
            onSavePrompt={handleSavePrompt}
          />
        }
      />

      <div className={`translation-controls ${translatedSubtitles ? 'state-results' : 'state-form'}`} ref={contentRef}>
        {/* Language Chain UI */}
        <div className="translation-row language-chain-row">
          <div className="row-label">
            <label>{t('translation.languageChain', 'Language Chain')}:</label>
          </div>
          <div className="row-content">
            <LanguageChain
              chainItems={chainItems}
              onAddLanguage={addLanguage}
              onAddOriginalLanguage={addOriginalLanguage}
              onAddDelimiter={addDelimiter}
              onRemoveItem={removeItem}
              onUpdateLanguage={updateLanguage}
              onUpdateDelimiter={updateDelimiter}
              onMoveItem={moveItem}
              disabled={isTranslating || isBulkTranslating || translatedSubtitles !== null}
              showOriginalOption={true}
            />
          </div>
        </div>

        {/* If we have translated subtitles, show the complete view */}
        {translatedSubtitles ? (
          <TranslationComplete
            onReset={handleReset}
            isModalOpen={isModalOpen}
            setIsModalOpen={setIsModalOpen}
            onDownload={handleDownload}
            onProcess={handleProcess}
            hasTranslation={translatedSubtitles && translatedSubtitles.length > 0}
            hasOriginal={subtitles && subtitles.length > 0}
            sourceSubtitleName={getNamingInfo().sourceSubtitleName}
            videoName={getNamingInfo().videoName}
            targetLanguages={getNamingInfo().targetLanguages}
            hasBulkTranslations={bulkTranslations.length > 0 && bulkTranslations.some(bt => bt.success)}
            onDownloadAll={handleBulkDownloadAll}
            onDownloadZip={handleBulkDownloadZip}
          />
        ) : (
          <>
            {/* Check if we're in format mode (only original language) */}
            {!hasOnlyOriginalLanguage() && (
              <>
                {/* Model selection */}
                <ModelSelection
                  selectedModel={selectedModel}
                  onModelSelect={handleModelSelect}
                  disabled={isTranslating || isBulkTranslating}
                />

                {/* Split duration slider */}
                <SplitDurationSlider
                  splitDuration={splitDuration}
                  onSplitDurationChange={handleSplitDurationChange}
                  subtitles={subtitles}
                  disabled={isTranslating || isBulkTranslating}
                />

                {/* Rest time slider */}
                <RestTimeSlider
                  restTime={restTime}
                  onRestTimeChange={handleRestTimeChange}
                  disabled={isTranslating || isBulkTranslating}
                />

                {/* Include rules toggle */}
                <RulesToggle
                  includeRules={includeRules}
                  onIncludeRulesChange={handleIncludeRulesChange}
                  rulesAvailable={rulesAvailable}
                  hasUserProvidedSubtitles={hasUserProvidedSubtitles}
                  disabled={isTranslating || isBulkTranslating}
                />

                {/* Max words per subtitle (post-split) - default: Unlimited */}
                <div className="translation-row rest-time-row">
                  <div className="row-label">
                    <label>{t('processing.maxWordsPerSubtitle', 'Max words per subtitle')}:</label>
                  </div>
                  <div className="row-content">
                    <div className="slider-control-row">
                      <SliderWithValue
                        value={postSplitMaxWords}
                        onChange={(v) => setPostSplitMaxWords(parseInt(v))}
                        min={1}
                        max={31}
                        step={1}
                        orientation="Horizontal"
                        size="XSmall"
                        state={isTranslating || isBulkTranslating ? 'Disabled' : 'Enabled'}
                        className="post-split-max-words-slider"
                        id="post-split-max-words-slider"
                        ariaLabel={t('processing.maxWordsPerSubtitle', 'Max words per subtitle')}
                        defaultValue={31}
                        formatValue={(v) => (Number(v) >= 31
                          ? t('processing.unlimited', 'Unlimited')
                          : t('processing.wordsLimit', '{{count}} {{unit}}', {
                              count: Number(v),
                              unit: Number(v) === 1 ? t('processing.word', 'word') : t('processing.words', 'words')
                            })
                        )}
                      >
                        <HelpIcon title={t('processing.maxWordsHelp', 'Maximum number of words allowed per subtitle. Longer subtitles will be split evenly.')} />
                      </SliderWithValue>
                    </div>
                  </div>
                </div>

              </>
            )}

            {/* Translation actions */}
            <TranslationActions
              isTranslating={isTranslating || isBulkTranslating}
              onTranslate={handleTranslate}
              onCancel={handleCancelTranslation}
              disabled={!hasOnlyOriginalLanguage() && !hasValidLanguage()}
              isFormatMode={hasOnlyOriginalLanguage()}
              bulkFiles={bulkFiles}
              onBulkFilesChange={setBulkFiles}
              onBulkFileRemoval={handleBulkFileRemoval}
              onBulkFilesRemovalAll={handleBulkFilesRemovalAll}
              hasBulkTranslations={bulkTranslations.length > 0 && bulkTranslations.some(bt => bt.success)}
              onDownloadAll={handleBulkDownloadAll}
              onDownloadZip={handleBulkDownloadZip}
              splitDuration={splitDuration}
            />

            {/* Translation status */}
            {(isTranslating || isBulkTranslating) && (
              <TranslationStatus
                status={translationStatus}
                statusRef={statusRef}
              />
            )}
          </>
        )}

        {/* Error message */}
        <TranslationError error={error} />

        {/* Translation preview - only show in results state (when TranslationComplete is shown) */}
        {translatedSubtitles && (
          <>
            {/* Translation preview - show for main translation without bulk files */}
            {bulkTranslations.length === 0 && (
              <TranslationPreview
                translatedSubtitles={translatedSubtitles}
                targetLanguages={targetLanguages}
                loadedFromCache={loadedFromCache}
                splitDuration={splitDuration}
                onRetrySegment={handleRetrySegment}
              />
            )}

            {/* Bulk translation preview - show when there are bulk translation results */}
            {bulkTranslations.length > 0 && bulkTranslations.some(bt => bt.success) && (
              <BulkTranslationPreview
                bulkTranslations={bulkTranslations}
                targetLanguages={targetLanguages}
                mainTranslation={{
                  name: getNamingInfo().sourceSubtitleName || getNamingInfo().videoName || 'Main Translation',
                  subtitles: translatedSubtitles,
                  loadedFromCache: loadedFromCache
                }}
                splitDuration={splitDuration}
                onRetrySegment={handleRetrySegment}
              />
            )}
          </>
        )}

        {/* Narration Section moved to OutputContainer */}
      </div>
    </div>
  );
};

export default TranslationSection;
