import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
    <div className="creation-panel-section" data-testid="translate-task-panel">
      {/* Source Track Mode */}
      <div className="creation-field-row">
        <label className="creation-field-label">
          {t('processing.sourceModeLabel', 'Source Mode')}
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
      <div className="creation-field-row">
        <label htmlFor="translate-target-language" className="creation-field-label">
          {t('processing.targetLanguage', 'Target Language')} *
        </label>
        <select
          id="translate-target-language"
          className="creation-select"
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
        {!targetLanguage && (
          <span className="creation-field-helper" style={{ color: 'var(--md-error, #B3261E)' }}>
            Target language is required for translation.
          </span>
        )}
      </div>

      {/* Model Selection */}
      <div className="creation-field-row">
        <label htmlFor="translate-model-select" className="creation-field-label">
          {t('processing.translationModel', 'Translation Model')}
        </label>
        <select
          id="translate-model-select"
          className="creation-select"
          value={model}
          onChange={(e) => handleFieldChange('model', e.target.value)}
        >
          <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite (Fast & accurate)</option>
          <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
          <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
        </select>
      </div>

      {/* Linked Translation Invariant Notice */}
      <div className="creation-info-banner">
        <span style={{ fontSize: 18 }}>ℹ️</span>
        <div>
          {t(
            'processing.translationLinkedNotice',
            'Translated cues link to source spans without fake word timestamps.'
          )}
        </div>
      </div>

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
            {/* Custom Translation Instructions */}
            <div className="creation-field-row">
              <label htmlFor="translate-custom-instructions" className="creation-field-label">
                {t('processing.translationGlossaryLabel', 'Translation glossary / instructions')}
              </label>
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

            {/* Request Duration */}
            <div className="creation-field-row">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="creation-field-label">
                  {t('processing.maxDurationPerRequest', 'Max duration per request')}
                </span>
                <span className="creation-field-helper">{maxDuration} min</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                value={maxDuration}
                className="creation-range"
                onChange={(e) => handleFieldChange('maxDuration', parseInt(e.target.value, 10))}
              />
            </div>

            {/* Sequential Delay */}
            <div className="creation-field-row">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="creation-field-label">
                  {t('processing.segmentProcessingDelay', 'Sequential delay')}
                </span>
                <span className="creation-field-helper">
                  {segmentDelay === 0 ? '0s (Simultaneous)' : `${segmentDelay}s`}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="60"
                step="5"
                value={segmentDelay}
                className="creation-range"
                onChange={(e) => handleFieldChange('segmentDelay', parseInt(e.target.value, 10))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TranslateTaskTab;
