import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useTranslationState from '../../hooks/useTranslationState';
import useLanguageChain from '../../hooks/useLanguageChain';
import usePostSplitSubtitles from './hooks/usePostSplitSubtitles';
import { handleRetrySegment as retrySegment } from './handlers/retryHandlers';
import {
  getNamingInfo as buildNamingInfo,
  handleBulkDownloadAll as bulkDownloadAll,
  handleBulkDownloadZip as bulkDownloadZip,
  runOwnedBulkExport
} from './utils/downloadUtils';
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
  const [isExporting, setIsExporting] = useState(false);
  const exportPendingRef = useRef(false);

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
    handleModelSelect,
    handleSavePrompt,
    handleTranslate: translate,
    handleCancelTranslation,
    handleReset,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
    retryMainTranslation,
    // Bulk translation
    bulkFiles,
    setBulkFiles,
    bulkTranslations,
    setBulkTranslations,
    isBulkTranslating,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  } = useTranslationState(subtitles, onTranslationComplete);

  // Post-split translated subtitles (max words per subtitle) state + effects
  const {
    postSplitMaxWords,
    setPostSplitMaxWords,
    presentedSubtitles,
  } = usePostSplitSubtitles({ translatedSubtitles });

  /**
   * Handle retry for a specific segment
   * @param {Object} segment - Segment info object
   */
  const handleRetrySegment = useCallback((segment) => retrySegment(segment, {
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
    retryMainTranslation,
    setBulkTranslations
  }), [translatedSubtitles, subtitles, t, getLanguageValues, selectedModel, customTranslationPrompt, includeRules, chainItems, retryMainTranslation, setBulkTranslations, bulkFiles, bulkTranslations]);

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
    if (isExporting) return;
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

  // Get naming information for downloads
  const getNamingInfo = () => buildNamingInfo(videoTitle, targetLanguages);

  // Handle bulk download all (includes main translation + bulk translations)
  const reportExportFailure = useCallback((exportError) => {
    const message = typeof exportError?.message === 'string' && exportError.message.trim()
      ? exportError.message
      : t('download.archiveExportFailed', 'The subtitle archive could not be saved.');
    try {
      window.addToast?.(message, 'error', 8000);
    } catch {
      // A notification cannot acquire or release the export ownership lease.
    }
  }, [t]);

  const runBulkExport = useCallback((operation) => runOwnedBulkExport({
    pendingRef: exportPendingRef,
    setPending: setIsExporting,
    operation,
    onError: reportExportFailure,
  }), [reportExportFailure]);

  const handleBulkDownloadAll = () => runBulkExport(() =>
    bulkDownloadAll({ translatedSubtitles: presentedSubtitles, bulkTranslations, videoTitle, targetLanguages }));

  // Handle bulk download as ZIP
  const handleBulkDownloadZip = () => runBulkExport(() =>
    bulkDownloadZip({ translatedSubtitles: presentedSubtitles, bulkTranslations, videoTitle, targetLanguages }));

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
              disabled={isTranslating || isBulkTranslating || isExporting || translatedSubtitles !== null}
              showOriginalOption={true}
            />
          </div>
        </div>

        {/* If we have translated subtitles, show the complete view */}
        {translatedSubtitles ? (
          <TranslationComplete
            onReset={() => (isExporting ? { status: 'busy' } : handleReset())}
            hasBulkTranslations={bulkTranslations.length > 0 && bulkTranslations.some(bt => bt.success)}
            onDownloadAll={handleBulkDownloadAll}
            onDownloadZip={handleBulkDownloadZip}
            isExporting={isExporting}
            exportPendingRef={exportPendingRef}
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
                  disabled={isTranslating || isBulkTranslating || isExporting}
                />

                {/* Split duration slider */}
                <SplitDurationSlider
                  splitDuration={splitDuration}
                  onSplitDurationChange={handleSplitDurationChange}
                  subtitles={subtitles}
                  disabled={isTranslating || isBulkTranslating || isExporting}
                />

                {/* Rest time slider */}
                <RestTimeSlider
                  restTime={restTime}
                  onRestTimeChange={handleRestTimeChange}
                  disabled={isTranslating || isBulkTranslating || isExporting}
                />

                {/* Include rules toggle */}
                <RulesToggle
                  includeRules={includeRules}
                  onIncludeRulesChange={handleIncludeRulesChange}
                  rulesAvailable={rulesAvailable}
                  hasUserProvidedSubtitles={hasUserProvidedSubtitles}
                  disabled={isTranslating || isBulkTranslating || isExporting}
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
                        state={isTranslating || isBulkTranslating || isExporting ? 'Disabled' : 'Enabled'}
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
              disabled={isExporting || (!hasOnlyOriginalLanguage() && !hasValidLanguage())}
              isFormatMode={hasOnlyOriginalLanguage()}
              bulkFiles={bulkFiles}
              onBulkFilesChange={setBulkFiles}
              onBulkFileRemoval={handleBulkFileRemoval}
              onBulkFilesRemovalAll={handleBulkFilesRemovalAll}
              hasBulkTranslations={bulkTranslations.length > 0 && bulkTranslations.some(bt => bt.success)}
              onDownloadAll={handleBulkDownloadAll}
              onDownloadZip={handleBulkDownloadZip}
              isExporting={isExporting}
              exportPendingRef={exportPendingRef}
              splitDuration={splitDuration}
            />

            {/* Translation status */}
            {(isTranslating || isBulkTranslating) && (
              <TranslationStatus
                status={translationStatus}
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
                translatedSubtitles={presentedSubtitles}
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
                  subtitles: presentedSubtitles,
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

// The parent's playhead ticks are not translation inputs. Internal state and locale still update.
export default memo(TranslationSection);
