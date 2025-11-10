import React from 'react';
import { useTranslation } from 'react-i18next';

import SliderWithValue from '../../common/SliderWithValue';
import '../../../styles/narration/narrationAdvancedSettingsRedesign.css';
import HelpIcon from '../../common/HelpIcon';


/**
 * Chatterbox Controls component for exaggeration and CFG weight sliders
 * @param {Object} props - Component props
 * @param {number} props.exaggeration - Current exaggeration value (0.25-2.0)
 * @param {Function} props.setExaggeration - Function to set exaggeration
 * @param {number} props.cfgWeight - Current CFG weight value (0.0-1.0)
 * @param {Function} props.setCfgWeight - Function to set CFG weight
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @returns {JSX.Element} - Rendered component
 */
const ChatterboxControls = ({
  exaggeration,
  setExaggeration,
  cfgWeight,
  setCfgWeight,
  isGenerating,
  chatterboxLanguage
}) => {
  // Capability gate: easy to flip when non-English support is unlocked
  const ADVANCED_NON_EN_ENABLED = false;
  const supportsAdvanced = React.useMemo(() => {
    const lang = (chatterboxLanguage || '').toLowerCase();
    if (!lang) return false;
    if (lang.startsWith('en')) return true;
    return ADVANCED_NON_EN_ENABLED;
  }, [chatterboxLanguage]);

  const slidersDisabledSoft = isGenerating || !supportsAdvanced;

  const { t } = useTranslation();

  // Handle slider changes
  const handleExaggerationChange = (e) => {
    const value = parseFloat(e.target.value);
    setExaggeration(value);
    // Save to localStorage for persistence
    localStorage.setItem('chatterbox_exaggeration', value.toString());
  };

  const handleCfgWeightChange = (e) => {
    const value = parseFloat(e.target.value);
    setCfgWeight(value);
    // Save to localStorage for persistence
    localStorage.setItem('chatterbox_cfg_weight', value.toString());
  };

  // Calculate slider fill percentage
  const calculateFillPercentage = (value, min, max) => {
    return ((value - min) / (max - min)) * 100;
  };

  return (
    <div className="chatterbox-controls">
      {/* Exaggeration Slider */}
      <div className="narration-row chatterbox-control-row animated-row">
        <div className="row-label">
          <label htmlFor="chatterbox-exaggeration">{t('narration.exaggeration', 'Emotional Intensity')}:</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={exaggeration}
            onChange={(value) => handleExaggerationChange({ target: { value } })}
            min={0.25}
            max={2.0}
            step={0.05}
            orientation="horizontal"
            size="xsmall"
            state={slidersDisabledSoft ? "disabled" : "enabled"}
            className="chatterbox-exaggeration-slider"
            id="chatterbox-exaggeration"
            ariaLabel={t('narration.exaggeration', 'Emotional Intensity')}
            defaultValue={1.0}
            formatValue={(v) => Number(v).toFixed(2)}
          />
          <div className="setting-description">
            {t('narration.exaggerationDesc', 'Higher values increase emotional expression')}
            {!supportsAdvanced && (
              <HelpIcon title={t('narration.chatterboxEnglishOnlyControls', 'Currently only English supports these controls')}/>
            )}
          </div>
        </div>
      </div>

      {/* CFG Weight Slider */}
      <div className="narration-row chatterbox-control-row animated-row">
        <div className="row-label">
          <label htmlFor="chatterbox-cfg-weight">{t('narration.cfgWeight', 'Pace Control')}:</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={cfgWeight}
            onChange={(value) => handleCfgWeightChange({ target: { value } })}
            min={0.0}
            max={1.0}
            step={0.05}
            orientation="Horizontal"
            size="XSmall"
            state={slidersDisabledSoft ? "Disabled" : "Enabled"}
            className="chatterbox-cfg-weight-slider"
            id="chatterbox-cfg-weight"
            ariaLabel={t('narration.cfgWeight', 'Pace Control')}
            defaultValue={0.5}
            formatValue={(v) => Number(v).toFixed(2)}
          />
          <div className="setting-description">
            {t('narration.cfgWeightDesc', 'Adjusts generation strength and speaking pace')}
            {!supportsAdvanced && (
              <HelpIcon title={t('narration.chatterboxEnglishOnlyControls', 'Currently only English supports these controls')}/>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatterboxControls;
