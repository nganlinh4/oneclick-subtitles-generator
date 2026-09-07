import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from './common/SliderWithValue';
import MaterialSwitch from './common/MaterialSwitch';
import HelpIcon from './common/HelpIcon';

/**
 * Visual / Custom task creation panel.
 * Visual reasoning, scene descriptions, OCR on-screen text, chaptering,
 * and custom prompt analysis rules.
 * Adheres to OSG Material 3 Expressive 2-column layout.
 */
export const VisualCustomTaskTab = ({
  state = {},
  onChange,
  isAudioOnly = false,
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const subtask = state.subtask || 'ocr';
  const fps = state.fps !== undefined ? state.fps : 0.25;
  const mediaResolution = state.mediaResolution || 'low';
  const model = state.model || 'gemini-3.1-flash-lite';
  const customPrompt = state.customPrompt || '';
  const useTranscriptionRules = Boolean(state.useTranscriptionRules);
  const useOutsideResultsContext = Boolean(state.useOutsideResultsContext);
  const outsideContextRange = state.outsideContextRange || 5;

  const handleFieldChange = useCallback((field, value) => {
    onChange?.({
      ...state,
      [field]: value,
    });
  }, [onChange, state]);

  const handleSubtaskSelect = useCallback((selectedSubtask) => {
    const nextState = {
      ...state,
      subtask: selectedSubtask,
    };
    // Invariant: chapters never auto-splits into caption fragments
    if (selectedSubtask === 'chapters') {
      nextState.autoSplitSubtitles = false;
    }
    onChange?.(nextState);
  }, [onChange, state]);

  const videoRequiredForCurrent = isAudioOnly && (subtask === 'ocr' || subtask === 'descriptions' || subtask === 'chapters');

  return (
    <div className="modal-content-grid" data-testid="visual-custom-task-panel">
      {/* Left Column: Subtask Selection, Model, Resolution, Warnings */}
      <div className="tab-column-left">
        {/* Audio-only Warning Banner */}
        {isAudioOnly && (
          <div className="creation-info-banner warning" role="alert">
            <span className="material-symbols-rounded" style={{ fontSize: '20px', color: '#F57C00' }}>warning</span>
            <div>
              {t(
                'processing.videoRequiredNotice',
                'This task requires video frames. Please load a video file or switch to the Speech task.'
              )}
            </div>
          </div>
        )}

        {/* Subtask Segmented Control */}
        <div className="option-group">
          <div className="label-with-help">
            <label>
              {t('processing.visualSubtaskLabel', 'Visual Task')}
            </label>
            <HelpIcon title={t('processing.visualSubtaskHelp', 'Choose visual recognition mode: OCR on-screen text, scene descriptions, chapters, or custom prompts.')} />
          </div>
          <div className="subtask-segmented-row" role="radiogroup" aria-label="Visual Subtasks">
            <button
              type="button"
              className={`subtask-pill ${subtask === 'ocr' ? 'active' : ''}`}
              disabled={isAudioOnly}
              onClick={() => handleSubtaskSelect('ocr')}
              data-testid="subtask-ocr"
            >
              {t('processing.visualSubtaskOcr', 'On-screen text (OCR)')}
            </button>

            <button
              type="button"
              className={`subtask-pill ${subtask === 'descriptions' ? 'active' : ''}`}
              disabled={isAudioOnly}
              onClick={() => handleSubtaskSelect('descriptions')}
              data-testid="subtask-descriptions"
            >
              {t('processing.visualSubtaskDescriptions', 'Scene descriptions')}
            </button>

            <button
              type="button"
              className={`subtask-pill ${subtask === 'chapters' ? 'active' : ''}`}
              disabled={isAudioOnly}
              onClick={() => handleSubtaskSelect('chapters')}
              data-testid="subtask-chapters"
            >
              {t('processing.visualSubtaskChapters', 'Chapters')}
            </button>

            <button
              type="button"
              className={`subtask-pill ${subtask === 'custom' ? 'active' : ''}`}
              onClick={() => handleSubtaskSelect('custom')}
              data-testid="subtask-custom"
            >
              {t('processing.visualSubtaskCustom', 'Custom prompt')}
            </button>
          </div>
        </div>

        {/* Model Selection */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="visual-model-select">
              {t('processing.model', 'Model')}
            </label>
            <HelpIcon title={t('processing.visualModelHelp', 'Gemini multimodal vision model used for frame inspection.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="visual-model-select"
              className="setting-select"
              value={model}
              onChange={(e) => handleFieldChange('model', e.target.value)}
            >
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Fast visual)</option>
              <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
              <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
              <option value="gemini-3.7-flash">Gemini 3.7 Flash (High reasoning)</option>
            </select>
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
        </div>

        {/* Video Resolution */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="media-resolution-select">
              {t('processing.mediaResolution', 'Video Resolution')}
            </label>
            <HelpIcon title={t('processing.mediaResolutionHelp', 'Resolution for extracted video frames submitted to Gemini.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="media-resolution-select"
              className="setting-select"
              data-testid="media-resolution-dropdown"
              value={mediaResolution}
              disabled={videoRequiredForCurrent}
              onChange={(e) => handleFieldChange('mediaResolution', e.target.value)}
            >
              <option value="low">{t('processing.lowRes', 'Low (66 tokens/frame)')}</option>
              <option value="medium">{t('processing.mediumRes', 'Medium (258 tokens/frame)')}</option>
            </select>
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
        </div>
      </div>

      {/* Right Column: Frame Rate Slider, Custom Prompt, and Advanced Options */}
      <div className="tab-column-right">
        {/* Frame Rate Slider */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="fps-slider">
              {t('processing.frameRate', 'Frame Rate')}
            </label>
            <HelpIcon title={t('processing.frameRateHelp', 'Sampling density for video analysis frames.')} />
          </div>
          <SliderWithValue
            id="fps-slider"
            min={0.25}
            max={5.0}
            step={0.25}
            value={fps}
            defaultValue={0.25}
            disabled={videoRequiredForCurrent}
            formatValue={(v) => `${v} FPS (1 frame / ${(1 / (v || 0.25)).toFixed(1)}s)`}
            onChange={(v) => handleFieldChange('fps', parseFloat(v))}
          />
        </div>

        {/* Custom Prompt Section */}
        {subtask === 'custom' && (
          <div className="option-group">
            <div className="label-with-help">
              <label htmlFor="custom-prompt-input">
                {t('processing.visualSubtaskCustom', 'Custom prompt instructions')}
              </label>
              <HelpIcon title={t('processing.customPromptHelp', 'Instruct the model how to analyze video frames and format subtitles.')} />
            </div>
            <textarea
              id="custom-prompt-input"
              name="customPrompt"
              className="creation-textarea"
              placeholder={t('processing.customPromptPlaceholder', 'Enter custom visual instructions or rules for video analysis...')}
              value={customPrompt}
              onChange={(e) => handleFieldChange('customPrompt', e.target.value)}
            />
          </div>
        )}

        {/* Collapsible Advanced Options */}
        <div className="creation-accordion">
          <button
            type="button"
            className="creation-accordion-trigger"
            onClick={() => setShowAdvanced((prev) => !prev)}
            aria-expanded={showAdvanced}
          >
            <span>{t('processing.advancedOptions', 'Advanced options')}</span>
            <span
              className="material-symbols-rounded accordion-chevron"
              style={{
                transform: showAdvanced ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s ease',
              }}
            >
              expand_more
            </span>
          </button>

          {showAdvanced && (
            <div className="creation-accordion-content">
              {/* Analysis Rules Switch */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>
                  {t('processing.useTranscriptionRules', 'Use transcription rules from analysis')}
                </span>
                <MaterialSwitch
                  id="use-transcription-rules"
                  checked={useTranscriptionRules}
                  onChange={(e) => handleFieldChange('useTranscriptionRules', e.target.checked)}
                />
              </div>

              {/* Surrounding Context Switch & Range Slider */}
              <div className="option-group" style={{ gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>
                    {t('processing.notifyOutsideResults', 'Surrounding context')}
                  </span>
                  <MaterialSwitch
                    id="use-outside-context"
                    checked={useOutsideResultsContext}
                    onChange={(e) => handleFieldChange('useOutsideResultsContext', e.target.checked)}
                  />
                </div>

                {useOutsideResultsContext && (
                  <div className="option-group" style={{ marginTop: 8 }}>
                    <div className="label-with-help">
                      <label htmlFor="outside-context-range">
                        {t('processing.outsideContextRange', 'Context coverage')}
                      </label>
                      <HelpIcon title={t('processing.outsideContextRangeHelp', 'Number of surrounding subtitle lines provided as context.')} />
                    </div>
                    <SliderWithValue
                      id="outside-context-range"
                      min={1}
                      max={20}
                      step={1}
                      value={outsideContextRange}
                      defaultValue={5}
                      formatValue={(v) => `${v} lines`}
                      onChange={(v) => handleFieldChange('outsideContextRange', parseInt(v, 10))}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VisualCustomTaskTab;
