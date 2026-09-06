import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Visual / Custom task creation panel.
 * Visual reasoning, scene descriptions, OCR on-screen text, chaptering,
 * and custom prompt analysis rules.
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
    <div className="creation-panel-section" data-testid="visual-custom-task-panel">
      {/* Audio-only Warning Banner */}
      {isAudioOnly && (
        <div className="creation-info-banner warning" role="alert">
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div>
            {t(
              'processing.videoRequiredNotice',
              'This task requires video frames. Please load a video file or switch to the Speech task.'
            )}
          </div>
        </div>
      )}

      {/* Subtask Segmented Control */}
      <div className="creation-field-row">
        <label className="creation-field-label">
          {t('processing.visualSubtaskLabel', 'Visual Task')}
        </label>
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

      {/* Frame Rate & Media Resolution Row */}
      <div className="creation-field-row-horizontal">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <label htmlFor="fps-slider" className="creation-field-label">
              {t('processing.frameRate', 'Frame Rate')}
            </label>
            <span className="creation-field-helper">
              {fps} FPS (1 frame every {(1 / (fps || 0.25)).toFixed(1)}s)
            </span>
          </div>
          <input
            id="fps-slider"
            type="range"
            min="0.25"
            max="5.0"
            step="0.25"
            value={fps}
            disabled={videoRequiredForCurrent}
            className="creation-range"
            onChange={(e) => handleFieldChange('fps', parseFloat(e.target.value))}
          />
        </div>

        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="media-resolution-select" className="creation-field-label">
            {t('processing.mediaResolution', 'Video Resolution')}
          </label>
          <select
            id="media-resolution-select"
            className="creation-select"
            data-testid="media-resolution-dropdown"
            value={mediaResolution}
            disabled={videoRequiredForCurrent}
            onChange={(e) => handleFieldChange('mediaResolution', e.target.value)}
          >
            <option value="low">{t('processing.lowRes', 'Low (66 tokens/frame)')}</option>
            <option value="medium">{t('processing.mediumRes', 'Medium (258 tokens/frame)')}</option>
          </select>
        </div>
      </div>

      {/* Model Selection */}
      <div className="creation-field-row">
        <label htmlFor="visual-model-select" className="creation-field-label">
          {t('processing.model', 'Model')}
        </label>
        <select
          id="visual-model-select"
          className="creation-select"
          value={model}
          onChange={(e) => handleFieldChange('model', e.target.value)}
        >
          <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Fast visual)</option>
          <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
          <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
          <option value="gemini-3.7-flash">Gemini 3.7 Flash (High reasoning)</option>
        </select>
      </div>

      {/* Custom Prompt Section */}
      {subtask === 'custom' && (
        <div className="creation-field-row">
          <label htmlFor="custom-prompt-input" className="creation-field-label">
            {t('processing.visualSubtaskCustom', 'Custom prompt instructions')}
          </label>
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
          <span style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
            ▸
          </span>
        </button>

        {showAdvanced && (
          <div className="creation-accordion-content">
            {/* Analysis Rules Switch */}
            <label className="creation-switch-label">
              <input
                type="checkbox"
                id="use-transcription-rules"
                className="creation-checkbox"
                checked={useTranscriptionRules}
                onChange={(e) => handleFieldChange('useTranscriptionRules', e.target.checked)}
              />
              <span>{t('processing.useTranscriptionRules', 'Use transcription rules from analysis')}</span>
            </label>

            {/* Surrounding Context Switch */}
            <div className="creation-field-row">
              <label className="creation-switch-label">
                <input
                  type="checkbox"
                  id="use-outside-context"
                  className="creation-checkbox"
                  checked={useOutsideResultsContext}
                  onChange={(e) => handleFieldChange('useOutsideResultsContext', e.target.checked)}
                />
                <span>{t('processing.notifyOutsideResults', 'Surrounding context')}</span>
              </label>

              {useOutsideResultsContext && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span>{t('processing.outsideContextRange', 'Context coverage')}</span>
                    <span>{outsideContextRange} lines</span>
                  </div>
                  <input
                    type="range"
                    id="outside-context-range"
                    min="1"
                    max="20"
                    value={outsideContextRange}
                    className="creation-range"
                    onChange={(e) => handleFieldChange('outsideContextRange', parseInt(e.target.value, 10))}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VisualCustomTaskTab;
