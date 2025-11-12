import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getExampleAudioList, uploadExampleAudio } from '../../../services/narrationService';
import { showErrorToast } from '../../../utils/toastUtils';

/**
 * Example Audio Dropdown component
 * @param {Object} props - Component props
 * @param {Function} props.onExampleSelect - Function called when an example is selected
 * @param {boolean} props.disabled - Whether the dropdown is disabled
 * @returns {JSX.Element} - Rendered component
 */
const ExampleAudioDropdown = ({ onExampleSelect, disabled = false }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [exampleFiles, setExampleFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const dropdownRef = useRef(null);
  const buttonRef = useRef(null);

  // Get flag emoji for language
  const getFlagForLanguage = (language) => ({
    'English': '🇺🇸',
    'Chinese': '🇨🇳',
    'Korean': '🇰🇷',
    'Vietnamese': '🇻🇳'
  }[language] || '🏳️');

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

  // Load example files when component mounts
  useEffect(() => {
    const loadExampleFiles = async () => {
      try {
        const response = await getExampleAudioList();
        if (response.success) {
          setExampleFiles(response.files);
        }
      } catch (error) {
        console.error('Error loading example files:', error);
        setError('Failed to load example files');
      }
    };

    loadExampleFiles();
  }, []);

  // Dispatch toast notifications for errors
  useEffect(() => {
    if (error) {
      showErrorToast(error);
    }
  }, [error]);

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

  // Handle button click
  const handleButtonClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();

    // Don't open if disabled
    if (disabled) return;

    // Toggle dropdown state
    setIsOpen(prev => !prev);
  }, [disabled]);

  // Handle example selection
  const handleExampleSelect = useCallback(async (filename) => {
    setIsLoading(true);
    setError('');

    try {
      // Upload the example audio as reference
      const result = await uploadExampleAudio(filename);

      if (result.success) {
        // Call the parent callback with the result
        onExampleSelect(result);
        setIsOpen(false);
      } else {
        setError(result.error || 'Failed to upload example audio');
      }
    } catch (error) {
      console.error('Error uploading example audio:', error);
      setError('Failed to upload example audio');
    } finally {
      setIsLoading(false);
    }
  }, [onExampleSelect]);

  return (
    <div className={`example-audio-dropdown-container ${isOpen ? 'dropdown-open' : ''}`}>
      <button
        ref={buttonRef}
        className={`pill-button primary ${isOpen ? 'active-dropdown-btn' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={handleButtonClick}
        disabled={disabled || isLoading}
        title={disabled ? 'Service not available' : 'Use example reference audio'}
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>library_music</span>
        {isLoading ? t('narration.loading', 'Loading...') : t('narration.useExample', 'Use example')}
        <span className={`material-symbols-rounded dropdown-chevron ${!isOpen ? 'open' : ''}`} style={{ fontSize: '12px' }}>expand_more</span>
      </button>

      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          className="example-audio-dropdown"
          role="menu"
        >
          <div className="example-audio-dropdown-header">
            {t('narration.selectExample', 'Select Example Audio')}
          </div>
          <div className="example-audio-dropdown-list">
            {exampleFiles.length === 0 ? (
              <div className="example-audio-loading">
                {t('narration.loadingExamples', 'Loading examples...')}
              </div>
            ) : (
              exampleFiles.map((file) => (
                <button
                  key={file.filename}
                  className="example-audio-option"
                  onClick={() => handleExampleSelect(file.filename)}
                  disabled={isLoading}
                  role="menuitem"
                >
                  <div className={`example-audio-option-icon ${file.language.toLowerCase()}`}>
                    <span className="model-flag">{getFlagForLanguage(file.language)}</span>
                  </div>
                  <div className="example-audio-option-text">
                    <div className="example-audio-option-name">
                      {file.displayName}
                    </div>
                    <div className="example-audio-option-description">
                      {t(file.descriptionKey)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default ExampleAudioDropdown;
