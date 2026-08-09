import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/ModelDropdown.css';
import {
  DEFAULT_GEMINI_MODEL_ID,
  DOCUMENT_MODELS,
  TRANSLATION_MODELS
} from '../config/geminiModels';

/**
 * Reusable component for model selection dropdown
 * @param {Object} props - Component props
 * @param {Function} props.onModelSelect - Function called when a model is selected
 * @param {string} props.selectedModel - Currently selected model ID
 * @param {string} props.buttonClassName - Additional class name for the button
 * @param {string} props.label - Label to display on the button (optional)
 * @param {string} props.headerText - Text to display in the dropdown header
 * @param {boolean} props.isTranslationSection - Whether this dropdown is used in the translation section
 * @param {boolean} props.disabled - Whether the dropdown is disabled
 * @returns {JSX.Element} - Rendered component
 */
const ModelDropdown = ({
  onModelSelect,
  selectedModel = DEFAULT_GEMINI_MODEL_ID,
  buttonClassName = '',
  label = '',
  headerText,
  isTranslationSection = false,
  disabled = false
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);
  const dropdownRef = useRef(null);

  // Get custom models from localStorage
  const getCustomModels = () => {
    try {
      const stored = localStorage.getItem('custom_gemini_models');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  };

  // Model options with their icons and colors
  const getModelOptions = () => {
    const availableModels = isTranslationSection ? TRANSLATION_MODELS : DOCUMENT_MODELS;
    const builtInModels = availableModels.map(model => ({
      id: model.id,
      name: t(model.nameKey, model.nameDefault),
      description: t(model.descKey, model.descDefault),
      icon: (
        <span
          className={`material-symbols-rounded ${model.icon.className}`}
          style={model.icon.style}
        >
          {model.icon.symbol}
        </span>
      ),
      color: model.color,
      bgColor: model.bgColor
    }));

    // Add custom models
    const customModels = getCustomModels();
    const customModelOptions = customModels.map(model => ({
      id: model.id,
      name: `${model.name} (${t('models.customLabel', 'Custom')})`,
      description: isTranslationSection
        ? t('translation.customModel', 'Custom model - token limits may vary')
        : t('models.customModel', 'Custom model'),
      icon: <span className="material-symbols-rounded model-icon cpu-icon">memory</span>,
      color: 'var(--md-secondary)',
      bgColor: 'rgba(var(--md-secondary-rgb), 0.1)',
      isCustom: true
    }));

    return [...builtInModels, ...customModelOptions];
  };

  const modelOptions = getModelOptions();

  // Get the currently selected model
  const currentModel = modelOptions.find(model => model.id === selectedModel)
    || modelOptions.find(model => model.id === DEFAULT_GEMINI_MODEL_ID)
    || modelOptions[0];

  // Position the dropdown relative to the button
  const positionDropdown = useCallback(() => {
    if (!buttonRef.current || !dropdownRef.current) return;

    const buttonRect = buttonRef.current.getBoundingClientRect();
    const dropdownEl = dropdownRef.current;

    // Position above the button
    dropdownEl.style.bottom = `${window.innerHeight - buttonRect.top + 8}px`;

    // Ensure the dropdown doesn't go off-screen to the right
    const rightEdge = buttonRect.right;
    const windowWidth = window.innerWidth;
    const dropdownWidth = 240; // Width from CSS

    if (rightEdge + dropdownWidth > windowWidth) {
      // Position to the left of the button's right edge
      dropdownEl.style.right = `${windowWidth - rightEdge}px`;
      dropdownEl.style.left = 'auto';
    } else {
      // Position aligned with button's left edge
      dropdownEl.style.left = `${buttonRect.left}px`;
      dropdownEl.style.right = 'auto';
    }
  }, []);

  // Handle button click
  const handleButtonClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();

    // Don't open if disabled
    if (disabled) return;

    // Toggle dropdown state
    setIsOpen(prev => !prev);
  }, [disabled]);

  // Handle model selection
  const handleModelSelect = useCallback((e, modelId) => {
    e.preventDefault();
    e.stopPropagation();

    // Close the dropdown immediately
    setIsOpen(false);

    // Call the selection function
    onModelSelect(modelId);
  }, [onModelSelect]);

  // Handle clicks outside to close the dropdown
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (
        buttonRef.current &&
        !buttonRef.current.contains(e.target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target)
      ) {
        setIsOpen(false);
      }
    };

    // Position the dropdown when it opens
    positionDropdown();

    // Add event listeners for repositioning
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', positionDropdown);
    window.addEventListener('scroll', positionDropdown, true); // Use capture to catch all scroll events
    document.addEventListener('scroll', positionDropdown, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', positionDropdown);
      window.removeEventListener('scroll', positionDropdown, true);
      document.removeEventListener('scroll', positionDropdown, true);
    };
  }, [isOpen, positionDropdown]);

  return (
    <div className={`model-dropdown-container ${isOpen ? 'dropdown-open' : ''}`}>
      <button
        className={`model-dropdown-btn ${buttonClassName} ${isOpen ? 'active-dropdown-btn' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={handleButtonClick}
        title={disabled ? t('common.disabled', 'Disabled during translation') : t('common.selectModel', 'Select model')}
        ref={buttonRef}
        aria-haspopup="true"
        aria-expanded={isOpen}
        disabled={disabled}
      >
        {label && <span className="model-dropdown-label">{label}</span>}
        <span className="model-dropdown-selected">
          {currentModel.icon}
          <span className="model-name">{currentModel.name}</span>
        </span>
        <span className="material-symbols-rounded dropdown-icon" style={{ fontSize: 14 }}>expand_more</span>
      </button>

      {isOpen && (
        <div
          className="model-options-dropdown"
          ref={dropdownRef}
          role="menu"
        >
          <div className="model-options-header">
            {headerText || t('common.selectModel', 'Select model')}
          </div>
          <div className="model-options-list">
            {modelOptions.map((model) => (
              <button
                key={model.id}
                className={`model-option-btn ${model.id === selectedModel ? 'selected' : ''}`}
                onClick={(e) => handleModelSelect(e, model.id)}
                style={{
                  '--model-color': model.color,
                  '--model-bg-color': model.bgColor
                }}
                role="menuitem"
              >
                <div className="model-option-icon">{model.icon}</div>
                <div className="model-option-text">
                  <div className="model-option-name">
                    {model.name}
                  </div>
                  <div className="model-option-description">{model.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelDropdown;
