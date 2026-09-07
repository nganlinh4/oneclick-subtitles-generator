import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from './common/SliderWithValue';
import HelpIcon from './common/HelpIcon';

const COMMON_TARGET_LANGUAGES = [
  { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
  { code: 'en', name: 'English' },
  { code: 'ko', name: 'Korean (한국어)' },
  { code: 'es', name: 'Spanish (Español)' },
  { code: 'fr', name: 'French (Français)' },
  { code: 'de', name: 'German (Deutsch)' },
  { code: 'ja', name: 'Japanese (日本語)' },
  { code: 'zh', name: 'Chinese (中文)' },
  { code: 'pt', name: 'Portuguese (Português)' },
  { code: 'it', name: 'Italian (Italiano)' },
  { code: 'ru', name: 'Russian (Русский)' },
  { code: 'ar', name: 'Arabic (العربية)' },
  { code: 'hi', name: 'Hindi (हिन्दी)' },
  { code: 'th', name: 'Thai (ไทย)' },
  { code: 'id', name: 'Indonesian (Bahasa Indonesia)' },
];

/**
 * Translate task creation panel.
 * Subtitle translation linked to source transcript spans without fake 1-to-1 word timestamps.
 * Formatted with OSG Material 3 Expressive 2-column layout and standard shared controls.
 */
export const TranslateTaskTab = ({
  state = {},
  onChange,
  hasExistingTranscript = false,
  transcriptCuesCount = 0,
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const targetLanguage = state.targetLanguage || '';
  const sourceMode = state.sourceMode || (hasExistingTranscript ? 'existing_transcript' : 'transcribe_first');
  const model = state.model || 'gemini-3.5-flash-lite';
  const customInstructions = state.customInstructions || '';
  const maxDuration = state.maxDuration || 10;
  const segmentDelay = state.segmentDelay || 0;

  const handleFieldChange = useCallback((field, value) => {
    onChange?.({
      ...state,
      [field]: value,
    });
  }, [onChange, state]);

  return (
    <div className="modal-content-grid" data-testid="translate-task-panel">
      {/* Left Column: Source Mode, Target Language, Model, Notice */}
      <div className="tab-column-left">
        {/* Source Track Mode */}
        <div className="option-group">
          <div className="label-with-help">
            <label>
              {t('processing.sourceModeLabel', 'Source Mode')}
            </label>
            <HelpIcon title={t('processing.sourceModeHelp', 'Choose whether to translate existing cues, transcribe audio first, or process direct media.')} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <label className="creation-switch-label" style={{ fontSize: 13 }}>
              <input
                type="radio"
                name="translate-source-mode"
                value="existing_transcript"
                checked={sourceMode === 'existing_transcript'}
                disabled={!hasExistingTranscript}
                onChange={() => handleFieldChange('sourceMode', 'existing_transcript')}
              />
              <span>
                {t('processing.translateSourceExisting', 'Use existing transcript')}{' '}
                {hasExistingTranscript ? `(${transcriptCuesCount} cues)` : '(none available)'}
              </span>
            </label>

            <label className="creation-switch-label" style={{ fontSize: 13 }}>
              <input
                type="radio"
                name="translate-source-mode"
                value="transcribe_first"
                checked={sourceMode === 'transcribe_first'}
                onChange={() => handleFieldChange('sourceMode', 'transcribe_first')}
              />
              <span>
                {t('processing.translateSourceTranscribeFirst', 'Transcribe then translate')}
              </span>
            </label>

            <label className="creation-switch-label" style={{ fontSize: 13 }}>
              <input
                type="radio"
                name="translate-source-mode"
                value="direct_media"
                checked={sourceMode === 'direct_media'}
                onChange={() => handleFieldChange('sourceMode', 'direct_media')}
              />
              <span>
                {t('processing.translateSourceDirectMedia', 'Direct media generation')}
              </span>
            </label>
          </div>
        </div>

        {/* Target Language Selector */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="translate-target-language">
              {t('processing.targetLanguage', 'Target Language')} *
            </label>
            <HelpIcon title={t('processing.targetLanguageHelp', 'Language to translate subtitles into.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="translate-target-language"
              className="setting-select"
              value={targetLanguage}
              onChange={(e) => handleFieldChange('targetLanguage', e.target.value)}
              required
            >
              <option value="">-- Select destination language --</option>
              {COMMON_TARGET_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
          {!targetLanguage && (
            <span className="creation-field-helper" style={{ color: 'var(--md-error, #B3261E)' }}>
              Target language is required for translation.
            </span>
          )}
        </div>

        {/* Model Selection */}
        <div className="option-group">
          <div className="label-with-help">
            <label htmlFor="translate-model-select">
              {t('processing.translationModel', 'Translation Model')}
            </label>
            <HelpIcon title={t('processing.translationModelHelp', 'Gemini model used to perform context-aware translation.')} />
          </div>
          <div className="custom-select-wrapper">
            <select
              id="translate-model-select"
              className="setting-select"
              value={model}
              onChange={(e) => handleFieldChange('model', e.target.value)}
            >
              <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite (Fast & accurate)</option>
              <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
              <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
            </select>
            <span className="material-symbols-rounded select-chevron">expand_more</span>
          </div>
        </div>

        {/* Linked Translation Invariant Notice */}
        <div className="creation-info-banner">
          <span className="material-symbols-rounded" style={{ fontSize: '20px', color: 'var(--md-primary)' }}>info</span>
          <div>
            {t(
              'processing.translationLinkedNotice',
              'Translated cues link to source spans without fake word timestamps.'
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Advanced Options Accordion */}
      <div className="tab-column-right">
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
              {/* Custom Translation Instructions */}
              <div className="option-group">
                <div className="label-with-help">
                  <label htmlFor="translate-custom-instructions">
                    {t('processing.translationGlossaryLabel', 'Translation glossary / instructions')}
                  </label>
                  <HelpIcon title={t('processing.translationGlossaryHelp', 'Specify domain-specific vocabulary, names, or style guidance.')} />
                </div>
                <textarea
                  id="translate-custom-instructions"
                  className="creation-textarea"
                  placeholder={t(
                    'processing.translationGlossaryPlaceholder',
                    'e.g., Domain-specific terms, character names, formality rules...'
                  )}
                  value={customInstructions}
                  onChange={(e) => handleFieldChange('customInstructions', e.target.value)}
                />
              </div>

              {/* Request Duration Slider */}
              <div className="option-group">
                <div className="label-with-help">
                  <label>
                    {t('processing.maxDurationPerRequest', 'Max duration per request')}
                  </label>
                  <HelpIcon title={t('processing.maxDurationPerRequestHelp', 'Batch size in minutes for each translation window.')} />
                </div>
                <SliderWithValue
                  min={1}
                  max={20}
                  step={1}
                  value={maxDuration}
                  defaultValue={10}
                  formatValue={(v) => `${v} min`}
                  onChange={(v) => handleFieldChange('maxDuration', parseInt(v, 10))}
                />
              </div>

              {/* Sequential Delay Slider */}
              <div className="option-group">
                <div className="label-with-help">
                  <label>
                    {t('processing.segmentProcessingDelay', 'Sequential delay')}
                  </label>
                  <HelpIcon title={t('processing.segmentProcessingDelayHelp', 'Throttling delay between translation batches.')} />
                </div>
                <SliderWithValue
                  min={0}
                  max={60}
                  step={5}
                  value={segmentDelay}
                  defaultValue={0}
                  formatValue={(v) => (segmentDelay === 0 ? '0s (Simultaneous)' : `${v}s`)}
                  onChange={(v) => handleFieldChange('segmentDelay', parseInt(v, 10))}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TranslateTaskTab;
