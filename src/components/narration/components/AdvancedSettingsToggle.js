import React from 'react';
import { useTranslation } from 'react-i18next';
import AdvancedSettingsModal from './AdvancedSettingsModal';

/**
 * Advanced Settings Toggle component
 * @param {Object} props - Component props
 * @param {Object} props.advancedSettings - Advanced settings object
 * @param {Function} props.setAdvancedSettings - Function to update advanced settings
 * @param {boolean} props.isGenerating - Whether narration is being generated
 * @returns {JSX.Element} - Rendered component
 */
const AdvancedSettingsToggle = ({
  advancedSettings,
  setAdvancedSettings,
  isGenerating
}) => {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = React.useState(false);

  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  return (
    <div className="narration-row advanced-settings-row">
      <div className="row-label">
        <label>{t('narration.advancedSettings', 'Advanced Settings')}:</label>
      </div>
      <div className="row-content">
        <button
          className="pill-button advanced-settings-button"
          onClick={openModal}
          style={{
            backgroundColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
            color: 'var(--md-tertiary)',
            border: '1px solid rgba(var(--md-tertiary-rgb), 0.2)',
            boxShadow: 'var(--md-elevation-level1)',
            transition: 'all var(--md-duration-medium2) var(--md-easing-standard)'
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
          <span className="advanced-settings-button-label">
            {t('narration.advancedSettingsToggle', 'Voice & Audio Settings')}
          </span>
          <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
            settings
          </span>
        </button>

        {/* Advanced Settings Modal */}
        <AdvancedSettingsModal
          isOpen={isModalOpen}
          onClose={closeModal}
          settings={advancedSettings}
          onSettingsChange={setAdvancedSettings}
          disabled={isGenerating}
        />
      </div>
    </div>
  );
};

export default AdvancedSettingsToggle;
