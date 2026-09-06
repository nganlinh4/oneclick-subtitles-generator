import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REGROUPING_POLICIES } from '../../platform/localCaptionRegrouping';

/**
 * CaptionGroupingToolbar Component (F17)
 * Local, zero-provider caption regrouping toolbar in the Captions viewport.
 * Exposes Natural, Short, One word, and Custom policies,
 * with sliders for length/duration and manual edit preservation.
 */
export const CaptionGroupingToolbar = ({
  activePolicy = REGROUPING_POLICIES.NATURAL,
  onPolicyChange,
  preserveEdits = true,
  onPreserveEditsChange,
  customOptions = {
    maxWords: 12,
    maxDuration: 5.0,
    pauseThreshold: 300,
    splitOnPunctuation: true,
  },
  onOptionsChange,
  cueCount = 0,
  preservedCount = 0,
}) => {
  const { t } = useTranslation();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const handlePolicySelect = (policy) => {
    onPolicyChange?.(policy, customOptions);
    if (policy === REGROUPING_POLICIES.CUSTOM) {
      setIsDrawerOpen(true);
    }
  };

  const handleSliderChange = (key, value) => {
    const updated = { ...customOptions, [key]: value };
    onOptionsChange?.(updated);
    if (activePolicy === REGROUPING_POLICIES.CUSTOM) {
      onPolicyChange?.(activePolicy, updated);
    }
  };

  return (
    <div className="caption-grouping-toolbar-container" data-testid="caption-grouping-toolbar">
      <div className="caption-grouping-main-row">
        <div className="caption-grouping-policy-pills" role="radiogroup" aria-label={t('grouping.layoutPolicy', 'Caption layout')}>
          <button
            type="button"
            role="radio"
            aria-checked={activePolicy === REGROUPING_POLICIES.NATURAL}
            className={`policy-pill-button ${activePolicy === REGROUPING_POLICIES.NATURAL ? 'active' : ''}`}
            onClick={() => handlePolicySelect(REGROUPING_POLICIES.NATURAL)}
            data-testid="policy-natural"
          >
            {t('grouping.natural', 'Natural')}
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={activePolicy === REGROUPING_POLICIES.SHORT}
            className={`policy-pill-button ${activePolicy === REGROUPING_POLICIES.SHORT ? 'active' : ''}`}
            onClick={() => handlePolicySelect(REGROUPING_POLICIES.SHORT)}
            data-testid="policy-short"
          >
            {t('grouping.short', 'Short')}
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={activePolicy === REGROUPING_POLICIES.ONE_WORD}
            className={`policy-pill-button ${activePolicy === REGROUPING_POLICIES.ONE_WORD ? 'active' : ''}`}
            onClick={() => handlePolicySelect(REGROUPING_POLICIES.ONE_WORD)}
            data-testid="policy-one-word"
          >
            {t('grouping.oneWord', 'One word')}
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={activePolicy === REGROUPING_POLICIES.CUSTOM}
            className={`policy-pill-button ${activePolicy === REGROUPING_POLICIES.CUSTOM ? 'active' : ''}`}
            onClick={() => handlePolicySelect(REGROUPING_POLICIES.CUSTOM)}
            data-testid="policy-custom"
          >
            {t('grouping.custom', 'Custom')}
          </button>

          <button
            type="button"
            className="adjust-drawer-toggle-btn"
            onClick={() => setIsDrawerOpen((prev) => !prev)}
            aria-expanded={isDrawerOpen}
            data-testid="toggle-adjust-drawer"
          >
            <span>{isDrawerOpen ? t('grouping.hideAdjust', 'Hide') : t('grouping.adjust', 'Adjust…')}</span>
            <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>
              {isDrawerOpen ? 'expand_less' : 'tune'}
            </span>
          </button>
        </div>

        <div className="caption-grouping-options-lane">
          <label className="preserve-edits-label">
            <input
              type="checkbox"
              className="preserve-edits-checkbox"
              checked={preserveEdits}
              onChange={(e) => onPreserveEditsChange?.(e.target.checked)}
              data-testid="preserve-edits-checkbox"
            />
            <span>
              {t('grouping.preserveEdits', 'Preserve manual edits')}
              {preservedCount > 0 && ` (${preservedCount})`}
            </span>
          </label>

          {cueCount > 0 && (
            <span className="cue-count-pill" data-testid="grouping-cue-count">
              {t('grouping.cuesCount', '{{count}} cues', { count: cueCount })}
            </span>
          )}
        </div>
      </div>

      {isDrawerOpen && (
        <div className="custom-sliders-drawer" data-testid="custom-sliders-drawer">
          <div className="slider-control-group">
            <div className="slider-label-row">
              <span>{t('grouping.maxWords', 'Max words per cue')}</span>
              <span className="slider-value-badge">{customOptions.maxWords}</span>
            </div>
            <input
              type="range"
              className="grouping-slider-input"
              min="1"
              max="30"
              step="1"
              value={customOptions.maxWords}
              onChange={(e) => handleSliderChange('maxWords', parseInt(e.target.value, 10))}
              data-testid="slider-max-words"
            />
          </div>

          <div className="slider-control-group">
            <div className="slider-label-row">
              <span>{t('grouping.maxDuration', 'Max cue duration')}</span>
              <span className="slider-value-badge">{customOptions.maxDuration}s</span>
            </div>
            <input
              type="range"
              className="grouping-slider-input"
              min="1.0"
              max="10.0"
              step="0.5"
              value={customOptions.maxDuration}
              onChange={(e) => handleSliderChange('maxDuration', parseFloat(e.target.value))}
              data-testid="slider-max-duration"
            />
          </div>

          <div className="slider-control-group">
            <div className="slider-label-row">
              <span>{t('grouping.pauseThreshold', 'Pause threshold')}</span>
              <span className="slider-value-badge">{customOptions.pauseThreshold}ms</span>
            </div>
            <input
              type="range"
              className="grouping-slider-input"
              min="100"
              max="1500"
              step="50"
              value={customOptions.pauseThreshold}
              onChange={(e) => handleSliderChange('pauseThreshold', parseInt(e.target.value, 10))}
              data-testid="slider-pause-threshold"
            />
          </div>

          <label className="checkbox-control-group">
            <input
              type="checkbox"
              checked={customOptions.splitOnPunctuation}
              onChange={(e) => handleSliderChange('splitOnPunctuation', e.target.checked)}
              data-testid="checkbox-split-punctuation"
            />
            <span>{t('grouping.splitOnPunctuation', 'Split on sentence punctuation (. ? !)')}</span>
          </label>
        </div>
      )}
    </div>
  );
};

export default CaptionGroupingToolbar;
