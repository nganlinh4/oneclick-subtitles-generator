import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GEMINI_MODELS } from '../../../config/geminiModels';
import SliderWithValue from '../../common/SliderWithValue';
import CustomDropdown from '../../common/CustomDropdown';

const ThinkingBudgetCard = ({
  thinkingBudgets,
  setThinkingBudgets
}) => {
  const { t } = useTranslation();

  // Which model's thinking settings are currently shown
  const [selectedThinkingModel, setSelectedThinkingModel] = useState('gemini-2.5-flash');

  // Helper function to get the dropdown mode for a thinking budget value
  const getThinkingMode = (budget) => {
    if (budget === -1) return 'dynamic';
    if (budget === 0) return 'disabled';
    return 'custom';
  };

  // Helper function to get the slider value for custom mode (map token count to 0-100)
  const getSliderValue = (budget, modelId) => {
    if (modelId === 'gemini-2.5-pro') {
      // Range: 128-32768 tokens
      return Math.round(((budget - 128) / (32768 - 128)) * 100);
    } else if (modelId === 'gemini-2.5-flash') {
      // Range: 1-24576 tokens for Flash (start from 1 to avoid conflict with disabled)
      return Math.round(((budget - 1) / (24576 - 1)) * 100);
    } else {
      // Range: 512-24576 tokens for Flash Lite
      return Math.round(((budget - 512) / (24576 - 512)) * 100);
    }
  };

  // Helper function to convert slider value back to token count
  const getTokensFromSlider = (sliderValue, modelId) => {
    if (modelId === 'gemini-2.5-pro') {
      // Range: 128-32768 tokens
      return Math.round(128 + (sliderValue / 100) * (32768 - 128));
    } else if (modelId === 'gemini-2.5-flash') {
      // Range: 1-24576 tokens for Flash (start from 1 to avoid conflict with disabled)
      return Math.round(1 + (sliderValue / 100) * (24576 - 1));
    } else {
      // Range: 512-24576 tokens for Flash Lite
      return Math.round(512 + (sliderValue / 100) * (24576 - 512));
    }
  };

  // Handle dropdown mode change
  const handleModeChange = (modelId, mode) => {
    let newBudget;
    if (mode === 'dynamic') {
      newBudget = -1;
    } else if (mode === 'disabled') {
      newBudget = 0;
    } else if (mode === 'custom') {
      // Set to a reasonable default for custom mode
      if (modelId === 'gemini-2.5-pro') {
        newBudget = 1024;
      } else if (modelId === 'gemini-2.5-flash') {
        newBudget = 1024; // Flash can start from 0, but 1024 is a good default
      } else {
        newBudget = 512; // Flash Lite minimum is 512
      }
    }

    setThinkingBudgets(prev => ({
      ...prev,
      [modelId]: newBudget
    }));
  };

  // Handle slider change for custom mode
  const handleSliderChange = (modelId, sliderValue) => {
    const tokens = getTokensFromSlider(sliderValue, modelId);
    setThinkingBudgets(prev => ({
      ...prev,
      [modelId]: tokens
    }));
  };

  // Handle thinking level change for Gemini 3.x models
  const handleLevelChange = (modelId, level) => {
    setThinkingBudgets(prev => ({
      ...prev,
      [modelId]: level
    }));
  };

  return (
    <div className="settings-card thinking-card">
      <div className="settings-card-header">
        <div className="settings-card-icon">
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>psychology</span>
        </div>
        <h4>{t('settings.thinkingBudgetSection', 'AI Thinking Budget')}</h4>
      </div>
      <div className="settings-card-content">
        <p className="setting-description">
          {t('settings.thinkingBudgetDescription', 'Configure how much thinking each AI model should use. Higher budgets allow more detailed reasoning but increase processing time and cost.')}
        </p>

        {/* Model selector */}
        <div className="compact-setting">
          <label>{t('settings.thinkingModelSelect', 'Model')}</label>
          <CustomDropdown
            value={selectedThinkingModel}
            onChange={setSelectedThinkingModel}
            options={GEMINI_MODELS.map(m => ({ value: m.id, label: t(m.nameKey, m.nameDefault) }))}
            placeholder={t('settings.selectModel', 'Select model')}
          />
        </div>

        {/* ── Gemini 3.1 Pro ── thinkingLevel, no minimal */}
        {selectedThinkingModel === 'gemini-3.1-pro-preview' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget31ProDesc', 'Cannot disable thinking. High is default for maximum reasoning depth.')}
            </p>
            <CustomDropdown
              value={thinkingBudgets['gemini-3.1-pro-preview'] || 'high'}
              onChange={(value) => handleLevelChange('gemini-3.1-pro-preview', value)}
              options={[
                { value: 'low',    label: t('settings.thinkingLow', 'Low') },
                { value: 'medium', label: t('settings.thinkingMedium', 'Medium') },
                { value: 'high',   label: `${t('settings.thinkingHigh', 'High')} (${t('settings.default', 'Default')})` },
              ]}
              placeholder={t('settings.selectThinkingLevel', 'Select Thinking Level')}
            />
          </div>
        )}

        {/* ── Gemini 3 Flash ── thinkingLevel, all 4 levels, default high */}
        {selectedThinkingModel === 'gemini-3-flash-preview' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget3FlashDesc', 'Choose thinking depth. High is default. Minimal turns off thinking for most queries.')}
            </p>
            <CustomDropdown
              value={thinkingBudgets['gemini-3-flash-preview'] || 'high'}
              onChange={(value) => handleLevelChange('gemini-3-flash-preview', value)}
              options={[
                { value: 'minimal', label: t('settings.thinkingMinimal', 'Minimal (Off for most queries)') },
                { value: 'low',     label: t('settings.thinkingLow', 'Low') },
                { value: 'medium',  label: t('settings.thinkingMedium', 'Medium') },
                { value: 'high',    label: `${t('settings.thinkingHigh', 'High')} (${t('settings.default', 'Default')})` },
              ]}
              placeholder={t('settings.selectThinkingLevel', 'Select Thinking Level')}
            />
          </div>
        )}

        {/* ── Gemini 3.5 Flash ── thinkingLevel, all 4 levels, default high */}
        {selectedThinkingModel === 'gemini-3.5-flash' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget3FlashDesc', 'Choose thinking depth. High is default. Minimal turns off thinking for most queries.')}
            </p>
            <CustomDropdown
              value={thinkingBudgets['gemini-3.5-flash'] || 'high'}
              onChange={(value) => handleLevelChange('gemini-3.5-flash', value)}
              options={[
                { value: 'minimal', label: t('settings.thinkingMinimal', 'Minimal (Off for most queries)') },
                { value: 'low',     label: t('settings.thinkingLow', 'Low') },
                { value: 'medium',  label: t('settings.thinkingMedium', 'Medium') },
                { value: 'high',    label: `${t('settings.thinkingHigh', 'High')} (${t('settings.default', 'Default')})` },
              ]}
              placeholder={t('settings.selectThinkingLevel', 'Select Thinking Level')}
            />
          </div>
        )}

        {/* ── Gemini 3.1 Flash Lite ── thinkingLevel, default minimal */}
        {selectedThinkingModel === 'gemini-3.1-flash-lite-preview' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget31FlashLiteDesc', 'Minimal by default (thinking off). Upgrade to Low/Medium/High for deeper reasoning at extra cost.')}
            </p>
            <CustomDropdown
              value={thinkingBudgets['gemini-3.1-flash-lite-preview'] || 'minimal'}
              onChange={(value) => handleLevelChange('gemini-3.1-flash-lite-preview', value)}
              options={[
                { value: 'minimal', label: `${t('settings.thinkingMinimal', 'Minimal (Off for most queries)')} (${t('settings.default', 'Default')})` },
                { value: 'low',     label: t('settings.thinkingLow', 'Low') },
                { value: 'medium',  label: t('settings.thinkingMedium', 'Medium') },
                { value: 'high',    label: t('settings.thinkingHigh', 'High') },
              ]}
              placeholder={t('settings.selectThinkingLevel', 'Select Thinking Level')}
            />
          </div>
        )}

        {/* ── Gemini 2.5 Pro ── thinkingBudget, no disable */}
        {selectedThinkingModel === 'gemini-2.5-pro' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget25ProDesc', 'Cannot disable thinking. Choose dynamic or set custom token budget.')}
            </p>
            <CustomDropdown
              value={getThinkingMode(thinkingBudgets['gemini-2.5-pro'] || -1)}
              onChange={(value) => handleModeChange('gemini-2.5-pro', value)}
              options={[
                { value: 'dynamic', label: `${t('settings.thinkingDynamic', 'Dynamic (Auto)')} (${t('settings.default', 'Default')})` },
                { value: 'custom',  label: t('settings.thinkingCustom', 'Custom') },
              ]}
              placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
            />
            {getThinkingMode(thinkingBudgets['gemini-2.5-pro'] || 128) === 'custom' && (
              <div className="thinking-slider-container">
                <SliderWithValue
                  value={getSliderValue(thinkingBudgets['gemini-2.5-pro'], 'gemini-2.5-pro')}
                  onChange={(value) => handleSliderChange('gemini-2.5-pro', parseInt(value))}
                  min={0} max={100} step={1}
                  orientation="Horizontal" size="XSmall" state="Enabled"
                  className="thinking-budget-slider" id="thinking-budget-pro"
                  ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                  formatValue={() => `${thinkingBudgets['gemini-2.5-pro']} ${t('settings.tokens', 'tokens')}`}
                />
                <div className="slider-range-info">
                  {t('settings.thinkingRange', 'Range')}: 128 - 32,768 {t('settings.tokens', 'tokens')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Gemini 2.5 Flash ── thinkingBudget, can disable */}
        {selectedThinkingModel === 'gemini-2.5-flash' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget25FlashDesc', 'Can be disabled for fastest response, dynamic for auto, or custom token budget.')}
            </p>
            <CustomDropdown
              value={getThinkingMode(thinkingBudgets['gemini-2.5-flash'] || -1)}
              onChange={(value) => handleModeChange('gemini-2.5-flash', value)}
              options={[
                { value: 'disabled', label: t('settings.thinkingDisabled', 'Disabled') },
                { value: 'dynamic',  label: `${t('settings.thinkingDynamic', 'Dynamic (Auto)')} (${t('settings.default', 'Default')})` },
                { value: 'custom',   label: t('settings.thinkingCustom', 'Custom') },
              ]}
              placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
            />
            {getThinkingMode(thinkingBudgets['gemini-2.5-flash'] || 0) === 'custom' && (
              <div className="thinking-slider-container">
                <SliderWithValue
                  value={getSliderValue(thinkingBudgets['gemini-2.5-flash'], 'gemini-2.5-flash')}
                  onChange={(value) => handleSliderChange('gemini-2.5-flash', parseInt(value))}
                  min={0} max={100} step={1}
                  orientation="Horizontal" size="XSmall" state="Enabled"
                  className="thinking-budget-slider" id="thinking-budget-flash"
                  ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                  formatValue={() => `${thinkingBudgets['gemini-2.5-flash']} ${t('settings.tokens', 'tokens')}`}
                />
                <div className="slider-range-info">
                  {t('settings.thinkingRange', 'Range')}: 1 - 24,576 {t('settings.tokens', 'tokens')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Gemini 2.5 Flash Lite ── thinkingBudget, can disable, default off */}
        {selectedThinkingModel === 'gemini-2.5-flash-lite' && (
          <div className="compact-setting">
            <p className="setting-description">
              {t('settings.thinkingBudget25FlashLiteDesc', 'Disabled by default for fastest response. Choose dynamic or custom token budget.')}
            </p>
            <CustomDropdown
              value={getThinkingMode(thinkingBudgets['gemini-2.5-flash-lite'] || -1)}
              onChange={(value) => handleModeChange('gemini-2.5-flash-lite', value)}
              options={[
                { value: 'disabled', label: `${t('settings.thinkingDisabled', 'Disabled')} (${t('settings.default', 'Default')})` },
                { value: 'dynamic',  label: t('settings.thinkingDynamic', 'Dynamic (Auto)') },
                { value: 'custom',   label: t('settings.thinkingCustom', 'Custom') },
              ]}
              placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
            />
            {getThinkingMode(thinkingBudgets['gemini-2.5-flash-lite'] || 0) === 'custom' && (
              <div className="thinking-slider-container">
                <SliderWithValue
                  value={getSliderValue(thinkingBudgets['gemini-2.5-flash-lite'], 'gemini-2.5-flash-lite')}
                  onChange={(value) => handleSliderChange('gemini-2.5-flash-lite', parseInt(value))}
                  min={0} max={100} step={1}
                  orientation="Horizontal" size="XSmall" state="Enabled"
                  className="thinking-budget-slider" id="thinking-budget-lite"
                  ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                  formatValue={() => `${thinkingBudgets['gemini-2.5-flash-lite']} ${t('settings.tokens', 'tokens')}`}
                />
                <div className="slider-range-info">
                  {t('settings.thinkingRange', 'Range')}: 512 - 24,576 {t('settings.tokens', 'tokens')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ThinkingBudgetCard;
