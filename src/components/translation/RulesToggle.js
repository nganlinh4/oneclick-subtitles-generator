import React from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../common/MaterialSwitch';
import HelpIcon from '../common/HelpIcon';

import '../../styles/common/material-switch.css';

/**
 * Rules toggle component
 * @param {Object} props - Component props
 * @param {boolean} props.includeRules - Whether to include rules
 * @param {Function} props.onIncludeRulesChange - Function to handle include rules change
 * @param {boolean} props.rulesAvailable - Whether rules are available
 * @param {boolean} props.hasUserProvidedSubtitles - Whether user-provided subtitles are present
 * @param {boolean} props.disabled - Whether the toggle is disabled
 * @returns {JSX.Element} - Rendered component
 */
const RulesToggle = ({
  includeRules,
  onIncludeRulesChange,
  rulesAvailable,
  hasUserProvidedSubtitles,
  disabled = false
}) => {
  const { t } = useTranslation();

  return (
    <div className="translation-row rules-row">
      <div className="row-label">
        <label htmlFor="include-rules">{t('translation.includeRules', 'Include Context Rules')}:</label>
      </div>
      <div className="row-content">
        <div className="material-switch-container">
          <MaterialSwitch
            id="include-rules"
            checked={rulesAvailable && !hasUserProvidedSubtitles ? includeRules : false}
            onChange={(e) => {
              const value = e.target.checked;
              onIncludeRulesChange(value);
            }}
            disabled={disabled || !rulesAvailable || hasUserProvidedSubtitles}
            ariaLabel={t('translation.includeRules', 'Include Context Rules')}
            icons={true}
          />
          <div className="label-with-help">
            <label htmlFor="include-rules" className="material-switch-label">
              {t('translation.includeRulesLabel', 'Append transcription rules to translation requests')}
            </label>
            <HelpIcon
              title={hasUserProvidedSubtitles
                ? t('translation.customSubtitlesNoRules', 'This option is disabled because you provided custom subtitles. Custom subtitles mode skips video analysis and rule generation.')
                : rulesAvailable
                  ? t('translation.includeRulesDescription', 'Includes video analysis context and rules with each translation request for better consistency across segments.')
                  : t('translation.noRulesAvailable', 'No transcription rules available. This option requires analyzing the video with Gemini first.')}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RulesToggle;
