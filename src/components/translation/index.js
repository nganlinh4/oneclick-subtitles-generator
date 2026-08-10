import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { completeDocument, summarizeDocument } from '../../services/geminiService';
import useTranslationState, { getCurrentMediaId, generateSubtitleHash } from '../../hooks/useTranslationState';
import useLanguageChain from '../../hooks/useLanguageChain';
import usePostSplitSubtitles from './hooks/usePostSplitSubtitles';
import { handleRetrySegment as retrySegment } from './handlers/retryHandlers';
import {
  generateFilename as buildFilename,
  getNamingInfo as buildNamingInfo,
  handleDownload as downloadSubtitles,
  handleBulkDownloadAll as bulkDownloadAll,
  handleBulkDownloadZip as bulkDownloadZip
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
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  } = useTranslationState(subtitles, onTranslationComplete);

  // Post-split translated subtitles (max words per subtitle) state + effects
  const { postSplitMaxWords, setPostSplitMaxWords } = usePostSplitSubtitles({
    translatedSubtitles,
    updateTranslatedSubtitles
  });

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
    updateTranslatedSubtitles,
    setBulkTranslations,
    onTranslationComplete,
    getCurrentMediaId,
    generateSubtitleHash
  }), [translatedSubtitles, subtitles, t, getLanguageValues, selectedModel, customTranslationPrompt, includeRules, chainItems, updateTranslatedSubtitles, setBulkTranslations, bulkFiles, bulkTranslations, onTranslationComplete]);

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
  const generateFilename = (source, namingInfo = {}) => buildFilename(source, namingInfo, videoTitle);

  // Get naming information for downloads
  const getNamingInfo = () => buildNamingInfo(videoTitle, targetLanguages);

  // Handle download request from modal
  const handleDownload = (source, format, namingInfo = {}) =>
    downloadSubtitles(source, format, namingInfo, {
      translatedSubtitles,
      subtitles,
      videoTitle,
      targetLanguages,
      setTxtContent
    });

  // Handle bulk download all (includes main translation + bulk translations)
  const handleBulkDownloadAll = () =>
    bulkDownloadAll({ translatedSubtitles, bulkTranslations, videoTitle, targetLanguages });

  // Handle bulk download as ZIP
  const handleBulkDownloadZip = () =>
    bulkDownloadZip({ translatedSubtitles, bulkTranslations, videoTitle, targetLanguages });

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
