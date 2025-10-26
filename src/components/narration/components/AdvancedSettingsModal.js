import React, { useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import NarrationAdvancedSettings from '../NarrationAdvancedSettings';
import CloseButton from '../../common/CloseButton';
import '../../../styles/narration/advancedSettingsModal.css';

// Default advanced settings
const DEFAULT_ADVANCED_SETTINGS = {
  // Voice Style Controls
  speechRate: 1.1,
 
  // Generation Quality Controls
  nfeStep: '32',  // Number of Function Evaluations (diffusion steps)
  swayCoef: -1.0, // Sway Sampling Coefficient
  cfgStrength: 2.0, // Classifier-Free Guidance Strength
 
  // Seed Control
  useRandomSeed: true,
  seed: 42,
 
  // Audio Processing Options
  removeSilence: true,
 
  // Output Format Options
  sampleRate: '44100',
  audioFormat: 'wav',
 
  // Batch Processing Options
  batchSize: '8'
};

/**
 * Advanced Settings Modal component
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the modal is open
 * @param {Function} props.onClose - Function to close the modal
 * @param {Object} props.settings - Advanced settings
 * @param {Function} props.onSettingsChange - Function to update settings
 * @param {boolean} props.disabled - Whether settings are disabled
 * @returns {JSX.Element} - Rendered component
 */
const AdvancedSettingsModal = ({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  disabled = false
}) => {
  const { t } = useTranslation();
  const modalRef = useRef(null);

  // Handle reset to defaults
  const handleResetToDefaults = () => {
    onSettingsChange(DEFAULT_ADVANCED_SETTINGS);
  };

  // Handle ESC key to close
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Create a portal to render the modal at the root level of the DOM
  return ReactDOM.createPortal(
    <div className="advanced-settings-modal-overlay" onClick={(e) => {
      // Close when clicking on the overlay (outside the modal)
      if (e.target === e.currentTarget) {
        onClose();
      }
    }}>
      <div className="advanced-settings-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <div className="advanced-settings-modal-header">
          <h3>{t('narration.advancedSettings', 'Advanced Settings')}</h3>
          <CloseButton onClick={onClose} variant="modal" size="medium" />
        </div>
        <div className="advanced-settings-modal-content">
          <NarrationAdvancedSettings
            settings={settings}
            onSettingsChange={onSettingsChange}
            disabled={disabled}
          />
        </div>
        <div className="advanced-settings-modal-footer">
          <button
            className="pill-button secondary"
            onClick={handleResetToDefaults}
            disabled={disabled}
            style={{
              backgroundColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
              color: 'var(--md-tertiary)',
              border: '1px solid rgba(var(--md-tertiary-rgb), 0.2)',
              boxShadow: 'var(--md-elevation-level1)',
              transition: 'all var(--md-duration-medium2) var(--md-easing-standard)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--md-tertiary-container)';
              e.currentTarget.style.color = 'var(--md-on-tertiary-container)';
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = 'var(--md-elevation-level2)';
              e.currentTarget.style.borderColor = 'transparent';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(var(--md-tertiary-rgb), 0.1)';
              e.currentTarget.style.color = 'var(--md-tertiary)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--md-elevation-level1)';
              e.currentTarget.style.borderColor = 'rgba(var(--md-tertiary-rgb), 0.2)';
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
              refresh
            </span>
            {t('common.resetToDefaults', 'Reset to Defaults')}
          </button>
          <button
            className="pill-button primary"
            onClick={onClose}
            style={{
              backgroundColor: 'rgba(var(--md-primary-rgb), 0.1)',
              color: 'var(--md-primary)',
              border: '1px solid rgba(var(--md-primary-rgb), 0.2)',
              boxShadow: 'var(--md-elevation-level1)',
              transition: 'all var(--md-duration-medium2) var(--md-easing-standard)'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--md-primary-container)';
              e.currentTarget.style.color = 'var(--md-on-primary-container)';
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = 'var(--md-elevation-level2)';
              e.currentTarget.style.borderColor = 'transparent';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(var(--md-primary-rgb), 0.1)';
              e.currentTarget.style.color = 'var(--md-primary)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--md-elevation-level1)';
              e.currentTarget.style.borderColor = 'rgba(var(--md-primary-rgb), 0.2)';
            }}
          >
            {t('common.done', 'Done')}
          </button>
        </div>
      </div>
    </div>,
    document.body // Render directly in the body element
  );
};

export default AdvancedSettingsModal;
