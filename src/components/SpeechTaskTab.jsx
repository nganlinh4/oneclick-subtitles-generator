import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Speech task creation panel (Default task).
 * Word-native transcription via gemini-3.5-transcribe or local ASR.
 * Strictly excludes all legacy transport, token counting, video FPS/resolution,
 * and generative prompt controls.
 */
export const SpeechTaskTab = ({
  state = {},
  onChange,
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAdjustCustom, setShowAdjustCustom] = useState(false);

  const engine = state.engine || 'gemini-3.5-transcribe';
  const language = state.language || 'auto';
  const identifySpeakers = Boolean(state.identifySpeakers ?? state.diarization ?? false);
  const captionLayout = state.captionLayout || 'Natural';
  const languageHints = state.languageHints || [];
  const languageHintsText = Array.isArray(languageHints) ? languageHints.join(', ') : '';
  const windowDurationSecs = state.windowDurationSecs || 120;
  const segmentDelaySecs = state.segmentDelaySecs || 0;
  const customMaxWords = state.customMaxWords || 12;
  const customMaxDuration = state.customMaxDuration || 5;

  const handleFieldChange = useCallback((field, value) => {
    onChange?.({
      ...state,
      [field]: value,
    });
  }, [onChange, state]);

  const handleLanguageHintsChange = useCallback((text) => {
    const rawTokens = text.split(/[\s,]+/);
    const sanitized = rawTokens
      .map((tok) => tok.trim())
      .filter((tok) => tok.length > 0 && /^[a-zA-Z0-9-]{1,16}$/.test(tok));
    handleFieldChange('languageHints', sanitized);
  }, [handleFieldChange]);

  return (
    <div className="creation-panel-section" data-testid="speech-task-panel">
      {/* Engine Selection */}
      <div className="creation-field-row">
        <label htmlFor="speech-engine-select" className="creation-field-label">
          {t('processing.engineLabel', 'Engine')}
        </label>
        <select
          id="speech-engine-select"
          className="creation-select"
          value={engine}
          onChange={(e) => handleFieldChange('engine', e.target.value)}
        >
          <option value="gemini-3.5-transcribe">
            {t('processing.speechEngineTranscribe', 'Gemini Transcribe (Word-native)')}
          </option>
          <option value="local-asr">
            {t('processing.speechEngineLocalAsr', 'Local ASR (Offline GPU)')}
          </option>
          <option value="gemini-general">
            {t('processing.speechEngineGeneral', 'Gemini General (Prompt-based)')}
          </option>
        </select>
      </div>

      {/* Language & Diarization Row */}
      <div className="creation-field-row-horizontal">
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="speech-language-select" className="creation-field-label">
            {t('processing.languageLabel', 'Language')}
          </label>
          <select
            id="speech-language-select"
            className="creation-select"
            value={language}
            onChange={(e) => handleFieldChange('language', e.target.value)}
          >
            <option value="auto">
              {t('processing.detectAutomatically', 'Detect automatically')}
            </option>
            <option value="en">English (en)</option>
            <option value="vi">Tiếng Việt (vi)</option>
            <option value="ko">한국어 (ko)</option>
            <option value="ja">日本語 (ja)</option>
            <option value="es">Español (es)</option>
            <option value="fr">Français (fr)</option>
            <option value="de">Deutsch (de)</option>
            <option value="zh">中文 (zh)</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
          <label className="creation-switch-label">
            <input
              type="checkbox"
              id="speech-diarization-checkbox"
              className="creation-checkbox"
              checked={identifySpeakers}
              onChange={(e) => {
                const checked = e.target.checked;
                onChange?.({
                  ...state,
                  identifySpeakers: checked,
                  diarization: checked,
                });
              }}
            />
            <span>{t('processing.identifySpeakers', 'Identify speakers')}</span>
          </label>
        </div>
      </div>

      {/* Caption Layout Selector */}
      <div className="creation-field-row">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label className="creation-field-label">
            {t('processing.captionLayoutLabel', 'Caption layout')}
          </label>
          {captionLayout === 'Custom' && (
            <button
              type="button"
              className="creation-btn-secondary"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => setShowAdjustCustom((prev) => !prev)}
            >
              {t('processing.adjustGrouping', 'Adjust...')}
            </button>
          )}
        </div>

        <div className="caption-layout-grid" role="radiogroup" aria-label="Caption Layout">
          <div
            className={`caption-layout-card ${captionLayout === 'Natural' ? 'active' : ''}`}
            onClick={() => handleFieldChange('captionLayout', 'Natural')}
            role="radio"
            aria-checked={captionLayout === 'Natural'}
            tabIndex={0}
          >
            <span className="caption-layout-title">
              {t('processing.captionLayoutNatural', 'Natural')}
            </span>
            <span className="caption-layout-desc">
              Punctuation & pauses aware
            </span>
          </div>

          <div
            className={`caption-layout-card ${captionLayout === 'Short' ? 'active' : ''}`}
            onClick={() => handleFieldChange('captionLayout', 'Short')}
            role="radio"
            aria-checked={captionLayout === 'Short'}
            tabIndex={0}
          >
            <span className="caption-layout-title">
              {t('processing.captionLayoutShort', 'Short')}
            </span>
            <span className="caption-layout-desc">
              Max 5 words, fast reading
            </span>
          </div>

          <div
            className={`caption-layout-card ${captionLayout === 'One word' ? 'active' : ''}`}
            onClick={() => handleFieldChange('captionLayout', 'One word')}
            role="radio"
            aria-checked={captionLayout === 'One word'}
            tabIndex={0}
          >
            <span className="caption-layout-title">
              {t('processing.captionLayoutOneWord', 'One word')}
            </span>
            <span className="caption-layout-desc">
              Single word karaoke reveal
            </span>
          </div>

          <div
            className={`caption-layout-card ${captionLayout === 'Custom' ? 'active' : ''}`}
            onClick={() => {
              handleFieldChange('captionLayout', 'Custom');
              setShowAdjustCustom(true);
            }}
            role="radio"
            aria-checked={captionLayout === 'Custom'}
            tabIndex={0}
          >
            <span className="caption-layout-title">
              {t('processing.captionLayoutCustom', 'Custom')}
            </span>
            <span className="caption-layout-desc">
              Adjust words & duration
            </span>
          </div>
        </div>

        {/* Custom Grouping Adjustment Drawer */}
        {captionLayout === 'Custom' && showAdjustCustom && (
          <div className="creation-accordion-content" style={{ marginTop: 8, borderRadius: 8 }}>
            <div className="creation-field-row-horizontal">
              <label style={{ fontSize: 13, flex: 1 }}>
                {t('processing.maxWords', 'Max words')}: {customMaxWords}
                <input
                  type="range"
                  min="1"
                  max="30"
                  value={customMaxWords}
                  className="creation-range"
                  style={{ width: '100%' }}
                  onChange={(e) => handleFieldChange('customMaxWords', parseInt(e.target.value, 10))}
                />
              </label>
              <label style={{ fontSize: 13, flex: 1 }}>
                {t('processing.maxDuration', 'Max duration')}: {customMaxDuration}s
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.5"
                  value={customMaxDuration}
                  className="creation-range"
                  style={{ width: '100%' }}
                  onChange={(e) => handleFieldChange('customMaxDuration', parseFloat(e.target.value))}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Mandatory Audio Extraction Notice */}
      <div className="creation-info-banner">
        <span style={{ fontSize: 18 }}>ℹ️</span>
        <div>
          {t(
            'processing.audioExtractedLocallyNotice',
            'Audio from this video is used. The video stays unchanged.'
          )}
        </div>
      </div>

      {/* Collapsible Advanced Section */}
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
            {/* Language Hints */}
            <div className="creation-field-row">
              <label htmlFor="speech-language-hints" className="creation-field-label">
                {t('processing.languageHintsLabel', 'Language hints')}
              </label>
              <input
                id="speech-language-hints"
                type="text"
                className="creation-input"
                placeholder={t('processing.languageHintsPlaceholder', 'e.g. en, ko, vi')}
                defaultValue={languageHintsText}
                onBlur={(e) => handleLanguageHintsChange(e.target.value)}
              />
              <span className="creation-field-helper">
                Comma-separated BCP-47 codes to guide speech recognition
              </span>
            </div>

            {/* Bounded Window Duration Slider */}
            <div className="creation-field-row">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="creation-field-label">
                  {t('processing.speechWindowDuration', 'Max window duration')}
                </span>
                <span className="creation-field-helper">{windowDurationSecs}s</span>
              </div>
              <input
                type="range"
                min="30"
                max="300"
                step="10"
                value={windowDurationSecs}
                className="creation-range speech-window-duration-slider"
                onChange={(e) => handleFieldChange('windowDurationSecs', parseInt(e.target.value, 10))}
              />
              <span className="creation-field-helper">
                {t(
                  'processing.speechWindowDurationDesc',
                  'Upper duration bound for each native audio transcription window'
                )}
              </span>
            </div>

            {/* Sequential Delay Slider */}
            <div className="creation-field-row">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="creation-field-label">
                  {t('processing.segmentProcessingDelay', 'Sequential throttling delay')}
                </span>
                <span className="creation-field-helper">
                  {segmentDelaySecs === 0 ? '0s (Simultaneous)' : `${segmentDelaySecs}s`}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="60"
                step="5"
                value={segmentDelaySecs}
                className="creation-range speech-throttling-delay-slider"
                onChange={(e) => handleFieldChange('segmentDelaySecs', parseInt(e.target.value, 10))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SpeechTaskTab;
