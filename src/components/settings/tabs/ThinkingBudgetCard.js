import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONFIGURABLE_THINKING_MODELS } from '../../../config/geminiModels';
import SliderWithValue from '../../common/SliderWithValue';
import CustomDropdown from '../../common/CustomDropdown';

const LEVEL_LABELS = {
  minimal: ['settings.thinkingMinimal', 'Minimal'],
  low: ['settings.thinkingLow', 'Low'],
  medium: ['settings.thinkingMedium', 'Medium'],
  high: ['settings.thinkingHigh', 'High']
};

const ThinkingBudgetCard = ({ thinkingBudgets, setThinkingBudgets }) => {
  const { t } = useTranslation();
  const [selectedModelId, setSelectedModelId] = useState(
    CONFIGURABLE_THINKING_MODELS[0]?.id || ''
  );
  const model = useMemo(
    () => CONFIGURABLE_THINKING_MODELS.find(({ id }) => id === selectedModelId)
      || CONFIGURABLE_THINKING_MODELS[0],
    [selectedModelId]
  );

  if (!model) return null;

  const { thinking } = model;
  const value = thinkingBudgets[model.id] ?? thinking.default;
  const updateValue = (next) => setThinkingBudgets((previous) => ({
    ...previous,
    [model.id]: next
  }));

  const isBudgetModel = thinking.type === 'budget';
  const budgetMode = isBudgetModel && value === -1
    ? 'dynamic'
    : isBudgetModel && value === 0
      ? 'disabled'
      : 'custom';
  const budgetMin = thinking.min || 1;
  const budgetMax = thinking.max || budgetMin;
  const sliderValue = !isBudgetModel || budgetMax === budgetMin
    ? 0
    : Math.round(((value - budgetMin) / (budgetMax - budgetMin)) * 100);
  const tokensFromSlider = (position) => Math.round(
    budgetMin + (Number(position) / 100) * (budgetMax - budgetMin)
  );

  const changeBudgetMode = (mode) => {
    if (mode === 'disabled') updateValue(0);
    else if (mode === 'dynamic') updateValue(-1);
    else updateValue(Math.max(budgetMin, thinking.customDefault || budgetMin));
  };

  const budgetModeOptions = [
    ...(thinking.allowDisable ? [{ value: 'disabled', label: t('settings.thinkingDisabled', 'Disabled') }] : []),
    ...(thinking.allowDynamic !== false ? [{ value: 'dynamic', label: t('settings.thinkingDynamic', 'Dynamic (Auto)') }] : []),
    { value: 'custom', label: t('settings.thinkingCustom', 'Custom') }
  ];

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
          {t('settings.thinkingBudgetDescription', 'Choose the reasoning depth used by each configurable model. The catalog supplies safe defaults for every endpoint.')}
        </p>

        <div className="compact-setting">
          <label>{t('settings.thinkingModelSelect', 'Model')}</label>
          <CustomDropdown
            value={model.id}
            onChange={setSelectedModelId}
            options={CONFIGURABLE_THINKING_MODELS.map((entry) => ({
              value: entry.id,
              label: t(entry.nameKey, entry.nameDefault)
            }))}
            placeholder={t('settings.selectModel', 'Select model')}
          />
        </div>

        <div className="compact-setting">
          <p className="setting-description">
            {model.dailyUse}. {t('settings.thinkingCatalogDefault', 'Catalog default')}: {thinking.default}.
          </p>

          {thinking.type === 'level' ? (
            <CustomDropdown
              value={value}
              onChange={updateValue}
              options={thinking.options.map((level) => {
                const [key, fallback] = LEVEL_LABELS[level] || [level, level];
                const label = t(key, fallback);
                return {
                  value: level,
                  label: level === thinking.default
                    ? `${label} (${t('settings.default', 'Default')})`
                    : label
                };
              })}
              placeholder={t('settings.selectThinkingLevel', 'Select Thinking Level')}
            />
          ) : (
            <>
              <CustomDropdown
                value={budgetMode}
                onChange={changeBudgetMode}
                options={budgetModeOptions}
                placeholder={t('settings.selectThinkingMode', 'Select Thinking Mode')}
              />
              {budgetMode === 'custom' && (
                <div className="thinking-slider-container">
                  <SliderWithValue
                    value={Math.max(0, Math.min(100, sliderValue))}
                    onChange={(position) => updateValue(tokensFromSlider(position))}
                    min={0}
                    max={100}
                    step={1}
                    orientation="Horizontal"
                    size="XSmall"
                    state="Enabled"
                    className="thinking-budget-slider"
                    id={`thinking-budget-${model.id}`}
                    ariaLabel={t('settings.thinkingBudget', 'Thinking Budget')}
                    formatValue={() => `${value} ${t('settings.tokens', 'tokens')}`}
                  />
                  <div className="slider-range-info">
                    {t('settings.thinkingRange', 'Range')}: {budgetMin.toLocaleString()} - {budgetMax.toLocaleString()} {t('settings.tokens', 'tokens')}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThinkingBudgetCard;
