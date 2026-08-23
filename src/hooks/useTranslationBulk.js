import { useCallback, useRef, useState } from 'react';
import { translateSubtitles } from '../services/geminiService';
import { createTranslationAbortError } from '../utils/translationOwnership';

const requireOwnedTranslationResult = (value) => {
  if (!value || value.status !== 'complete'
      || !Array.isArray(value.rows)
      || !Array.isArray(value.deliveries)
      || value.deliveries.some((delivery) => typeof delivery?.acknowledge !== 'function')) {
    throw new TypeError('Bulk translation returned an invalid owned result');
  }
  return value;
};

/**
 * Custom hook that manages bulk (multi-file) translation state and handlers.
 * Composes into the main translation hook by receiving the parent state it needs.
 * @param {Object} params
 * @param {string} params.selectedModel - Currently selected translation model
 * @param {number} params.splitDuration - Split duration setting
 * @param {Function} params.setError - Setter for the error message
 * @param {Function} params.setTranslationStatus - Setter for the translation status message
 * @param {Function} params.t - i18n translation function
 * @returns {Object} - Bulk translation state and handlers
 */
export const useTranslationBulk = ({
  selectedModel,
  splitDuration,
  setError,
  setTranslationStatus,
  t,
  onBulkSourceMutation = () => {},
}) => {
  // Bulk translation state
  const [bulkFiles, setBulkFiles] = useState([]);
  const [bulkTranslations, setBulkTranslations] = useState([]);
  const [isBulkTranslating, setIsBulkTranslating] = useState(false);
  const [currentBulkFileIndex, setCurrentBulkFileIndex] = useState(-1);
  const bulkFilesRef = useRef(bulkFiles);
  bulkFilesRef.current = bulkFiles;
  const setOwnedBulkFiles = useCallback((nextValue) => {
    const nextFiles = typeof nextValue === 'function'
      ? nextValue(bulkFilesRef.current)
      : nextValue;
    onBulkSourceMutation();
    bulkFilesRef.current = nextFiles;
    setBulkFiles(nextFiles);
    setBulkTranslations([]);
  }, [onBulkSourceMutation]);

  /**
   * Handle bulk translation
   * @param {Array} languages - Languages to translate to
   * @param {string|null} delimiter - Delimiter for multi-language translation
   * @param {boolean} useParentheses - Whether to use parentheses for the second language
   * @param {Object} bracketStyle - Optional bracket style { open, close }
   * @param {Array} chainItems - Optional chain items for format mode
   * @param {boolean} hasMainSubtitles - Whether there are main subtitles to translate after bulk
   */
  const handleBulkTranslate = async (languages, delimiter = ' ', useParentheses = false, bracketStyle = null, chainItems = null, hasMainSubtitles = false, ownership = {}) => {
    const { signal, assertOwned = async () => {} } = ownership;
    const assertBoundary = async () => {
      if (signal?.aborted) throw createTranslationAbortError();
      await assertOwned();
      if (signal?.aborted) throw createTranslationAbortError();
    };
    const publishOwnedState = async (publisher) => {
      await assertBoundary();
      publisher();
      await assertBoundary();
    };
    await assertBoundary();
    if (bulkFiles.length === 0) {
      await publishOwnedState(() => {
        setError(t('translation.bulk.noFiles', 'No files added for bulk translation'));
      });
      return { status: 'empty', results: [] };
    }

    await publishOwnedState(() => setIsBulkTranslating(true));
    await publishOwnedState(() => setError(''));
    await publishOwnedState(() => setBulkTranslations([]));
    await publishOwnedState(() => setCurrentBulkFileIndex(0));

    const results = [];

    try {
      // Process each file sequentially
      for (let i = 0; i < bulkFiles.length; i++) {
        await assertBoundary();

        await publishOwnedState(() => setCurrentBulkFileIndex(i));
        const bulkFile = bulkFiles[i];

        // Update status - include main file in total count if it exists
        const totalFiles = bulkFiles.length + (hasMainSubtitles ? 1 : 0);
        await publishOwnedState(() => {
          setTranslationStatus(t(
            'translation.bulk.processing',
            'Processing file {{current}}/{{total}}: {{filename}}',
            { current: i + 1, total: totalFiles, filename: bulkFile.name }
          ));
        });

        try {
          // Use the same translation settings but skip context rules
          const result = requireOwnedTranslationResult(await translateSubtitles(
            bulkFile.subtitles,
            languages.length === 1 ? languages[0] : languages,
            selectedModel,
            null, // Skip custom prompt/context rules for bulk translation
            splitDuration,
            false, // Skip include rules for bulk translation
            languages.length === 2 && useParentheses ? delimiter : (useParentheses ? null : delimiter),
            useParentheses,
            bracketStyle,
            chainItems,
            bulkFile.name, // File context for bulk translation
            false,
            ownership
          ));
          await assertBoundary();

          if (result.rows.length > 0) {
            results.push({
              originalFile: bulkFile,
              translatedSubtitles: result.rows,
              success: true,
              // React state is not a persistence receipt. Keep the native delivery handles alive
              // and unacknowledged until the bulk ZIP/file writer grows an exact durable-save
              // receipt; job-result recovery remains authoritative in the meantime.
              delivery: Object.freeze({
                state: result.deliveries.length === 0
                  ? 'notRequired'
                  : 'pendingDurableExport',
                pending: result.deliveries,
              }),
            });
          } else {
            results.push({
              originalFile: bulkFile,
              error: t('translation.emptyResult', 'Translation returned no results'),
              success: false
            });
          }
        } catch (fileError) {
          console.error(`Error translating file ${bulkFile.name}:`, fileError);

          // Check if this was a cancellation error
          if (signal?.aborted || fileError?.name === 'AbortError'
              || fileError?.code === 'translationAborted') {
            throw createTranslationAbortError();
          }

          results.push({
            originalFile: bulkFile,
            error: fileError.message || t('translation.error', 'Error translating subtitles'),
            success: false
          });
        }

        await assertBoundary();
      }

      await assertBoundary();
      await publishOwnedState(() => setBulkTranslations(results));

      // Calculate total files including main file if it exists
      const totalFiles = results.length + (hasMainSubtitles ? 1 : 0);
      const successfulBulkFiles = results.filter(r => r.success).length;

      if (hasMainSubtitles) {
        // If there's a main file to translate, show intermediate status
        await publishOwnedState(() => {
          setTranslationStatus(t(
            'translation.bulk.completeWithMain',
            'Bulk files complete: {{success}}/{{bulkTotal}} bulk files processed, main file next ({{current}}/{{total}} total)',
            {
              success: successfulBulkFiles,
              bulkTotal: results.length,
              current: successfulBulkFiles,
              total: totalFiles,
            }
          ));
        });
      } else {
        // If no main file, show final status
        await publishOwnedState(() => {
          setTranslationStatus(t(
            'translation.bulk.complete',
            'Bulk translation complete: {{success}}/{{total}} files processed successfully',
            { success: successfulBulkFiles, total: totalFiles }
          ));
        });
      }
      return { status: 'complete', results };

    } catch (error) {
      console.error('Bulk translation error:', error);

      // Check if this was a cancellation
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'translationAborted') {
        throw createTranslationAbortError();
      } else {
        await publishOwnedState(() => {
          setError(t(
            'translation.bulk.error',
            'Error during bulk translation: {{message}}',
            { message: error.message }
          ));
        });
      }
      return { status: 'failed', results };
    } finally {
      try {
        await publishOwnedState(() => setIsBulkTranslating(false));
        await publishOwnedState(() => setCurrentBulkFileIndex(-1));
      } catch {
        // A stale run cannot publish terminal bulk state.
      }
    }
  };

  /**
   * Handle bulk file removal with translation cleanup
   * @param {string} fileId - ID of the file to remove
   */
  const handleBulkFileRemoval = (fileId) => {
    // Remove the file from bulk files
    const updatedBulkFiles = bulkFiles.filter(bf => bf.id !== fileId);
    setOwnedBulkFiles(updatedBulkFiles);

    // Remove corresponding translation result if it exists
    const updatedBulkTranslations = bulkTranslations.filter(bt => bt.originalFile.id !== fileId);
    setBulkTranslations(updatedBulkTranslations);
  };

  /**
   * Handle bulk files removal (remove all) with translation cleanup
   */
  const handleBulkFilesRemovalAll = () => {
    setOwnedBulkFiles([]);
  };

  return {
    bulkFiles,
    bulkFilesRef,
    setBulkFiles: setOwnedBulkFiles,
    bulkTranslations,
    pendingBulkDeliveryCount: bulkTranslations.reduce(
      (count, translation) => count + (translation.delivery?.pending?.length ?? 0),
      0
    ),
    setBulkTranslations,
    isBulkTranslating,
    setIsBulkTranslating,
    currentBulkFileIndex,
    setCurrentBulkFileIndex,
    handleBulkTranslate,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  };
};
