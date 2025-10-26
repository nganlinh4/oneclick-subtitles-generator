import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ModelDropdown from './ModelDropdown';
import PromptEditor from './PromptEditor';
import CloseButton from './common/CloseButton';
import SliderWithValue from './common/SliderWithValue';
// Import default prompts from geminiService if needed in the future
// import { getDefaultConsolidatePrompt, getDefaultSummarizePrompt } from '../services/geminiService';
import '../styles/DownloadOptionsModal.css';
import '../styles/components/tabs.css';
import initTabPillAnimation from '../utils/tabPillAnimation';

/**
 * Modal component for download and processing options
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the modal is open
 * @param {Function} props.onClose - Function to close the modal
 * @param {Function} props.onDownload - Function to handle download
 * @param {Function} props.onProcess - Function to handle processing (consolidate/summarize)
 * @param {boolean} props.hasTranslation - Whether translation is available
 * @param {boolean} props.hasOriginal - Whether original subtitles are available
 * @param {string} props.sourceSubtitleName - Name of uploaded SRT file (first priority for naming)
 * @param {string} props.videoName - Name of video file (second priority for naming)
 * @param {Array} props.targetLanguages - Array of target languages for translation naming
 * @returns {JSX.Element} - Rendered component
 */
const DownloadOptionsModal = ({
  isOpen,
  onClose,
  onDownload,
  onProcess,
  hasTranslation = false,
  hasOriginal = true,
  sourceSubtitleName = '',
  videoName = '',
  targetLanguages = []
}) => {
  const { t } = useTranslation();
  const modalRef = useRef(null);
  const downloadTabsRef = useRef(null);

  // State for selected options
  const [subtitleSource, setSubtitleSource] = useState('original');
  const [fileFormat, setFileFormat] = useState('srt');
  const [processType, setProcessType] = useState(null); // Initialize to null so only Download Files tab is active
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('gemini_model') || 'gemini-2.5-flash';
  });
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [customPrompts, setCustomPrompts] = useState({
    consolidate: localStorage.getItem('custom_prompt_consolidate') || null,
    summarize: localStorage.getItem('custom_prompt_summarize') || null
  });
  const [splitDuration, setSplitDuration] = useState(() => {
    // Get the split duration from localStorage or use default (0 = no split)
    return parseInt(localStorage.getItem('consolidation_split_duration') || '0');
  });

  // Reset state when modal opens and initialize gooey tabs
  useEffect(() => {
    if (isOpen) {
      // Reset to default state with only Download Files tab active
      setSubtitleSource('original');
      setFileFormat('srt');
      setProcessType(null);
      // Initialize pill animation after DOM paints
      setTimeout(() => initTabPillAnimation('.download-tabs'), 30);
    }
  }, [isOpen]);

  // Initialize gooey tabs for process type when visible
  useEffect(() => {
    if (isOpen && processType) {
      setTimeout(() => initTabPillAnimation('.process-tabs'), 10);
    }
  }, [isOpen, processType]);

  // Close modal when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

  // Handle download button click
  const handleDownload = () => {
    onDownload(subtitleSource, fileFormat, {
      sourceSubtitleName,
      videoName,
      targetLanguages
    });
    onClose();
  };

  // Handle process button click
  const handleProcess = () => {
    // Pass the custom prompt if available
    const customPrompt = customPrompts[processType];
    // Pass the split duration for consolidation and naming info
    onProcess(subtitleSource, processType, selectedModel, splitDuration, customPrompt, {
      sourceSubtitleName,
      videoName,
      targetLanguages
    });
    onClose();
  };

  // Handle saving custom prompt
  const handleSavePrompt = (newPrompt) => {
    const updatedPrompts = {
      ...customPrompts,
      [processType]: newPrompt
    };
    setCustomPrompts(updatedPrompts);
    localStorage.setItem(`custom_prompt_${processType}`, newPrompt);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="download-options-modal" ref={modalRef}>
        <div className="modal-header">
          <h3>{t('download.options', 'Download & Process Options')}</h3>
          <CloseButton onClick={onClose} variant="modal" size="medium" />
        </div>

        <div className="modal-content">
          {/* Subtitle source selection */}
          <div className="option-group horizontal-layout modal-subtitle-source">
            <h4>{t('download.subtitleSource', 'Subtitle Source')}</h4>
            <div className="radio-group-base radio-group-horizontal modal-radio-group">
              <label className={`radio-option-base ${!hasOriginal ? 'disabled' : ''}`}>
                <input
                  type="radio"
                  name="subtitle-source"
                  value="original"
                  checked={subtitleSource === 'original'}
                  onChange={() => setSubtitleSource('original')}
                  disabled={!hasOriginal}
                />
                <span className={`radio-option-card ${subtitleSource === 'original' ? 'checked' : ''}`}>
                  {t('download.original', 'Original')}
                </span>
              </label>
              <label className={`radio-option-base ${!hasTranslation ? 'disabled' : ''}`}>
                <input
                  type="radio"
                  name="subtitle-source"
                  value="translated"
                  checked={subtitleSource === 'translated'}
                  onChange={() => setSubtitleSource('translated')}
                  disabled={!hasTranslation}
                />
                <span className={`radio-option-card ${subtitleSource === 'translated' ? 'checked' : ''}`}>
                  {t('download.translated', 'Translated')}
                </span>
              </label>
            </div>
          </div>

          {/* Action tabs (new input-tabs with gooey droplet) */}
          <div className="input-tabs download-tabs" ref={downloadTabsRef}>
            <button
              type="button"
              className={`tab-btn ${processType === null ? 'active' : ''}`}
              onClick={() => {
                setFileFormat('srt');
                setProcessType(null);
              }}
            >
              {t('download.downloadFiles', 'Download Files')}
            </button>
            <button
              type="button"
              className={`tab-btn ${processType !== null ? 'active' : ''}`}
              onClick={() => {
                setFileFormat(null);
                setProcessType('consolidate');
              }}
            >
              {t('download.processText', 'Process Text')}
            </button>
          </div>

          {/* Tab-specific content area with consistent height */}
          <div className="tab-content-area">
            {/* File format options */}
            {fileFormat && (
              <div className="option-group horizontal-layout modal-file-format">
                <h4>{t('download.fileFormat', 'File Format')}</h4>
                <div className="radio-group-base radio-group-horizontal modal-radio-group">
                  <label className="radio-option-base">
                    <input
                      type="radio"
                      name="file-format"
                      value="srt"
                      checked={fileFormat === 'srt'}
                      onChange={() => setFileFormat('srt')}
                    />
                    <span className={`radio-option-card ${fileFormat === 'srt' ? 'checked' : ''}`}>SRT</span>
                  </label>
                  <label className="radio-option-base">
                    <input
                      type="radio"
                      name="file-format"
                      value="json"
                      checked={fileFormat === 'json'}
                      onChange={() => setFileFormat('json')}
                    />
                    <span className={`radio-option-card ${fileFormat === 'json' ? 'checked' : ''}`}>JSON</span>
                  </label>
                  <label className="radio-option-base">
                    <input
                      type="radio"
                      name="file-format"
                      value="txt"
                      checked={fileFormat === 'txt'}
                      onChange={() => setFileFormat('txt')}
                    />
                    <span className={`radio-option-card ${fileFormat === 'txt' ? 'checked' : ''}`}>
                      {t('download.txtNoTimings', 'TXT (no timings)')}
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* Process options */}
            {processType && (
              <>
              <div className="option-group">
                <h4>{t('download.processType', 'Process Type')}</h4>
                {/* Compact gooey tabs for process type */}
                <div className="input-tabs process-tabs compact">
                  <button
                    type="button"
                    className={`tab-btn ${processType === 'consolidate' ? 'active' : ''}`}
                    onClick={() => {
                      setProcessType('consolidate');
                      if (isPromptEditorOpen) setIsPromptEditorOpen(false);
                    }}
                    title={t('download.consolidateExplanation', 'Converts subtitles into a coherent document, improving flow and readability while maintaining the original meaning.')}
                  >
                    <span className="tab-label">{t('download.consolidate', 'Complete Document (TXT)')}</span>
                    <div className="info-icon-container">
                      <span className="material-symbols-rounded info-icon" style={{ fontSize: '16px' }}>info</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`tab-btn ${processType === 'summarize' ? 'active' : ''}`}
                    onClick={() => {
                      setProcessType('summarize');
                      if (isPromptEditorOpen) setIsPromptEditorOpen(false);
                    }}
                    title={t('download.summarizeExplanation', 'Creates a concise summary of the main points and key information, about 1/3 the length of the original text.')}
                  >
                    <span className="tab-label">{t('download.summarize', 'Summarize (TXT)')}</span>
                    <div className="info-icon-container">
                      <span className="material-symbols-rounded info-icon" style={{ fontSize: '16px' }}>info</span>
                    </div>
                  </button>
                </div>
              </div>

              {/* Split Duration Selection (only for consolidate) */}
              {processType === 'consolidate' && (
                <div className="option-group">
                  <h4>{t('consolidation.splitDuration', 'Split Duration')}:</h4>
                  <div className="split-duration-slider-container">
                    <SliderWithValue
                      value={splitDuration}
                      onChange={(v) => setSplitDuration(parseInt(v))}
                      min={0}
                      max={20}
                      step={1}
                      orientation="Horizontal"
                      size="XSmall"
                      state="Enabled"
                      className="split-duration-slider"
                      id="consolidation-split-duration-slider"
                      ariaLabel={t('consolidation.splitDuration', 'Split Duration')}
                      title={t('consolidation.splitDurationTooltip', 'Split text into chunks for processing to avoid token limits')}
                      defaultValue={0}
                      formatValue={(v) => (Number(v) === 0 ? t('consolidation.noSplit', 'No Split') : `${v} ${t('consolidation.minutes', 'min')}`)}
                    />
                  </div>
                  <div className="setting-description">
                    {t('consolidation.splitDurationHelp', 'Splitting text into smaller chunks helps prevent processing from being cut off due to token limits. For longer texts, use smaller chunks.')}
                  </div>
                </div>
              )}

              <div className="option-group">
                <div className="option-header">
                  <h4>{t('download.selectModel', 'Select Model')}</h4>
                  <button
                    className="edit-prompt-button-with-text"
                    onClick={() => setIsPromptEditorOpen(true)}
                    title={t('promptEditor.editPromptTooltip', 'Edit Gemini prompt')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>edit</span>
                    <span>{t('promptEditor.editPrompt', 'Edit Prompt')}</span>
                  </button>
                </div>
                <ModelDropdown
                  onModelSelect={(modelId) => setSelectedModel(modelId)}
                  selectedModel={selectedModel}
                  buttonClassName="modal-model-dropdown"
                  headerText={t('download.selectModelForProcessing', 'Select model for processing')}
                />
              </div>

              {/* Prompt Editor */}
              <PromptEditor
                key={`prompt-editor-${processType}`} // Add key to force re-render when processType changes
                isOpen={isPromptEditorOpen}
                onClose={() => setIsPromptEditorOpen(false)}
                initialPrompt={
                  customPrompts[processType] ||
                  (processType === 'consolidate'
                    ? `I have a collection of subtitles from a video or audio. Please convert these into a coherent document.

Here are the subtitles:\n\n{subtitlesText}`
                    : `I have a collection of subtitles from a video or audio. Please create a concise summary.

Here are the subtitles:\n\n{subtitlesText}`)
                }
                onSave={handleSavePrompt}
                title={
                  processType === 'consolidate'
                    ? t('promptEditor.editConsolidatePrompt', 'Edit Consolidation Prompt')
                    : t('promptEditor.editSummarizePrompt', 'Edit Summarization Prompt')
                }
                promptType={processType} // Explicitly set the prompt type
                description={t('promptEditor.customizePromptDesc', 'Add custom instructions for processing. The system will automatically handle formatting.')}
              />
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="cancel-button" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          {fileFormat && (
            <button className="action-button download-button" onClick={handleDownload}>
              <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>download</span>
              {t('download.download', 'Download')}
            </button>
          )}
          {/* Process button */}
          {processType && (
            <button className="action-button process-button" onClick={handleProcess}>
              <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>account_tree</span>
              {t('download.process', 'Process')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default DownloadOptionsModal;
