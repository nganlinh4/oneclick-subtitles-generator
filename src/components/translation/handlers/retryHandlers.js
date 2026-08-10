import { translateSubtitles } from '../../../services/gemini/translation';
import { getSimpleTranslationPrompt } from '../../../services/gemini/promptManagement';

/**
 * Handle retry for a specific segment (segment or single-subtitle bulk/main retry).
 *
 * @param {Object} segment - Segment info object
 * @param {Object} ctx - Context with state, setters and helpers:
 *   {
 *     translatedSubtitles, subtitles, bulkFiles, bulkTranslations,
 *     selectedModel, customTranslationPrompt, includeRules, chainItems,
 *     t, getLanguageValues, updateTranslatedSubtitles, setBulkTranslations,
 *     onTranslationComplete, getCurrentMediaId, generateSubtitleHash
 *   }
 */
export const handleRetrySegment = async (segment, ctx) => {
  const {
    translatedSubtitles,
    subtitles,
    bulkFiles,
    bulkTranslations,
    selectedModel,
    customTranslationPrompt,
    includeRules,
    chainItems,
    t,
    getLanguageValues,
    updateTranslatedSubtitles,
    setBulkTranslations,
    onTranslationComplete,
    getCurrentMediaId,
    generateSubtitleHash
  } = ctx;

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

    // Check if this is a single subtitle retry (indicated by segmentNumber starting with "subtitle-")
    const isSingleSubtitleRetry = typeof segment.segmentNumber === 'string' && segment.segmentNumber.startsWith('subtitle-');

    if (isSingleSubtitleRetry) {
      // For individual subtitle retry, just retry that single subtitle without extra context
      // This ensures we get exactly one translation back
      const targetIndex = segment.startIndex; // The subtitle we want to retry

      // Extract just the target subtitle
      segmentSubtitles = [sourceSubtitles[targetIndex]];

      console.log(`Retrying subtitle ${targetIndex + 1} (single subtitle)`);
    } else {
      // For segment retry, use the original logic
      segmentSubtitles = sourceSubtitles.slice(segment.startIndex, segment.endIndex + 1);
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
};
