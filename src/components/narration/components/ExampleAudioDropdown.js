import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getExampleAudioList, uploadExampleAudio } from '../../../services/narrationService';

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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
        {isLoading ? t('narration.loading', 'Loading...') : t('narration.useExample', 'Use example')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`dropdown-chevron ${isOpen ? 'open' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
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
            {error && (
              <div className="example-audio-error">
                {error}
              </div>
            )}
            {exampleFiles.length === 0 && !error ? (
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
                  <div className="example-audio-option-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
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
