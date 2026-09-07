import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from './common/MaterialSwitch';
import SliderWithValue from './common/SliderWithValue';
import HelpIcon from './common/HelpIcon';

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
    <div className="modal-content-grid" data-testid="speech-task-panel">
      {/* Left Column: Model/Engine, Language, Diarization, and Notice */}
      <div className="tab-column-left">
        {/* Engine Selection */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="speech-engine-select">
              {t('processing.engineLabel', 'Engine')}
            </label>
            <HelpIcon title={t('processing.engineHelp', 'Choose word-native transcription, offline local ASR, or prompt-based Gemini.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="speech-engine-select"
              className="setting-select"
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
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
        </div>

        {/* Language Selection */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="speech-language-select">
              {t('processing.languageLabel', 'Language')}
            </label>
            <HelpIcon title={t('processing.languageHelp', 'Primary spoken language or automatic detection.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="speech-language-select"
              className="setting-select"
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
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
        </div>

        {/* Diarization Switch */}
        <div className="option-group">
          <div className="material-switch-container">
            <MaterialSwitch
              id="speech-diarization-checkbox"
              checked={identifySpeakers}
              onChange={(e) => {
                const checked = e.target.checked;
                onChange?.({
                  ...state,
                  identifySpeakers: checked,
                  diarization: checked,
                });
              }}
              ariaLabel={t('processing.identifySpeakers', 'Identify speakers')}
              icons={true}
            />
            <label htmlFor="speech-diarization-checkbox" className="material-switch-label">
              {t('processing.identifySpeakers', 'Identify speakers')}
            </label>
            <HelpIcon title={t('processing.identifySpeakersHelp', 'Distinguish multiple speakers with turn timestamps and speaker labels.')} />
          </div>
        </div>

        {/* Mandatory Audio Extraction Notice */}
        <div className="creation-info-banner">
          <span className="material-symbols-rounded" style={{ fontSize: '20px', color: 'var(--md-primary)' }}>info</span>
          <div>
            {t(
              'processing.audioExtractedLocallyNotice',
              'Audio from this video is used. The video stays unchanged.'
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Caption Layout & Advanced Options */}
      <div className="tab-column-right">
        {/* Caption Layout Selector */}
        <div className="option-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="label-with-help">
              <label>
                {t('processing.captionLayoutLabel', 'Caption layout')}
              </label>
              <HelpIcon title={t('processing.captionLayoutHelp', 'Structure captions into natural pauses, shorter reading cues, or single-word reveal.')} />
            </div>
            {captionLayout === 'Custom' && (
              <button
                type="button"
                className="creation-btn-secondary"
                style={{ padding: '3px 10px', fontSize: 12, borderRadius: 'var(--md-shape-pill)' }}
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
            <div className="custom-grouping-drawer">
              <div className="combined-options-row">
                <div className="combined-option-half">
                  <div className="label-with-help">
                    <label>{t('processing.maxWords', 'Max words')}</label>
                  </div>
                  <SliderWithValue
                    value={customMaxWords}
                    onChange={(v) => handleFieldChange('customMaxWords', parseInt(v, 10))}
                    min={1}
                    max={30}
                    step={1}
                    defaultValue={12}
                    formatValue={(v) => `${v} words`}
                  />
                </div>
                <div className="combined-option-half">
                  <div className="label-with-help">
                    <label>{t('processing.maxDuration', 'Max duration')}</label>
                  </div>
                  <SliderWithValue
                    value={customMaxDuration}
                    onChange={(v) => handleFieldChange('customMaxDuration', parseFloat(v))}
                    min={1}
                    max={10}
                    step={0.5}
                    defaultValue={5}
                    formatValue={(v) => `${v}s`}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible Advanced Section */}
        <div className="creation-accordion">
          <button
            type="button"
            className="creation-accordion-trigger"
            data-osg-action="speech-advanced-options-toggle"
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
              {/* Language Hints */}
              <div className="option-group">
                <div className="label-with-help">
                  <label htmlFor="speech-language-hints">
                    {t('processing.languageHintsLabel', 'Language hints')}
                  </label>
                  <HelpIcon title={t('processing.languageHintsHelp', 'Comma-separated BCP-47 codes to guide speech recognition.')} />
                </div>
                <input
                  id="speech-language-hints"
                  type="text"
                  className="osg-text-input"
                  placeholder={t('processing.languageHintsPlaceholder', 'e.g. en, ko, vi')}
                  defaultValue={languageHintsText}
                  onBlur={(e) => handleLanguageHintsChange(e.target.value)}
                />
                <span className="creation-field-helper">
                  Comma-separated BCP-47 codes to guide speech recognition
                </span>
              </div>

              {/* Bounded Window Duration Slider */}
              <div className="option-group">
                <div className="label-with-help">
                  <label htmlFor="speech-window-duration-slider">
                    {t('processing.speechWindowDuration', 'Max window duration')}
                  </label>
                  <HelpIcon title={t('processing.speechWindowDurationDesc', 'Upper duration bound for each native audio transcription window')} />
                </div>
                <SliderWithValue
                  id="speech-window-duration-slider"
                  value={windowDurationSecs}
                  onChange={(v) => handleFieldChange('windowDurationSecs', parseInt(v, 10))}
                  min={30}
                  max={300}
                  step={10}
                  defaultValue={120}
                  formatValue={(v) => `${v}s`}
                  inputProps={{
                    'data-osg-action': 'speech-window-duration-slider',
                    className: 'speech-window-duration-slider',
                  }}
                />
                <span className="creation-field-helper">
                  {t(
                    'processing.speechWindowDurationDesc',
                    'Upper duration bound for each native audio transcription window'
                  )}
                </span>
              </div>

              {/* Sequential Delay Slider */}
              <div className="option-group">
                <div className="label-with-help">
                  <label>
                    {t('processing.segmentProcessingDelay', 'Sequential throttling delay')}
                  </label>
                  <HelpIcon title={t('processing.segmentProcessingDelayHelp', 'Throttling delay between consecutive transcription windows to avoid rate limits.')} />
                </div>
                <SliderWithValue
                  value={segmentDelaySecs}
                  onChange={(v) => handleFieldChange('segmentDelaySecs', parseInt(v, 10))}
                  min={0}
                  max={60}
                  step={5}
                  defaultValue={0}
                  formatValue={(v) => (segmentDelaySecs === 0 ? '0s (Simultaneous)' : `${v}s`)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SpeechTaskTab;
