import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getName } from 'iso-639-1';
import CloseButton from '../../common/CloseButton';
import CustomDropdown from '../../common/CustomDropdown';
import '../../../styles/narration/VoiceSelectionModal.css';

const VoiceSelectionModal = ({ isOpen, onClose, voices, selectedVoice, onVoiceSelect, detectedLanguage, t }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [modalHeight, setModalHeight] = useState('auto');
  const modalRef = useRef(null);
  const searchInputRef = useRef(null);
  const contentRef = useRef(null);

  // Calculate and set modal height for smooth transitions
  const updateModalHeight = useCallback(() => {
    if (modalRef.current && contentRef.current && isOpen) {
      // Get the natural height of the content
      const modalElement = modalRef.current;
      const currentHeight = modalElement.offsetHeight;
      
      // Temporarily set to auto to measure natural height
      modalElement.style.height = 'auto';
      const naturalHeight = modalElement.offsetHeight;
      
      // Set back to current height immediately (no visual change)
      modalElement.style.height = `${currentHeight}px`;
      
      // Force a reflow by reading offsetHeight
      // eslint-disable-next-line no-unused-expressions
      void modalElement.offsetHeight;
      
      // Now transition to the new height
      modalElement.style.height = `${naturalHeight}px`;
    }
  }, [isOpen]);

  // Focus search input when modal opens
  useEffect(() => {
    if (isOpen) {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
      // Set initial height on open
      setTimeout(() => {
        if (modalRef.current) {
          modalRef.current.style.height = 'auto';
          const height = modalRef.current.offsetHeight;
          modalRef.current.style.height = `${height}px`;
        }
      }, 50);
    }
  }, [isOpen]);
  
  // Update height when content changes
  useEffect(() => {
    if (isOpen) {
      // Small delay to let DOM update
      const timer = setTimeout(() => {
        updateModalHeight();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [searchTerm, selectedCategory, isOpen, updateModalHeight]);

  // Handle click outside modal and ESC key
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        onClose();
      }
    };

    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  // Get recommended voices based on detected language
  const getRecommendedVoices = () => {
    if (!detectedLanguage?.languageCode) return [];

    return voices.filter(voice =>
      voice.language === detectedLanguage.languageCode ||
      voice.locale.startsWith(detectedLanguage.languageCode + '-')
    ).sort((a, b) => a.short_name.localeCompare(b.short_name));
  };

  const getLanguageName = (languageCode) => {
    return getName(languageCode.toLowerCase()) || languageCode;
  };

  // Get other voices (not recommended)
  const getOtherVoices = () => {
    if (!detectedLanguage?.languageCode) return voices;

    return voices.filter(voice =>
      voice.language !== detectedLanguage.languageCode &&
      !voice.locale.startsWith(detectedLanguage.languageCode + '-')
    );
  };

  // Group voices alphabetically by language (for other voices)
  const groupedVoices = getOtherVoices().reduce((acc, voice) => {
    const language = voice.locale.split('-')[0].toUpperCase();
    if (!acc[language]) {
      acc[language] = [];
    }
    acc[language].push(voice);
    return acc;
  }, {});

  // Sort voices within each language group alphabetically
  Object.keys(groupedVoices).forEach(language => {
    groupedVoices[language].sort((a, b) => a.short_name.localeCompare(b.short_name));
  });

  // Get recommended voices with filtering
  const getFilteredRecommendedVoices = () => {
    const recommendedVoices = getRecommendedVoices();
    if (selectedCategory !== 'All' && selectedCategory !== 'Recommended') {
      return [];
    }

    return recommendedVoices.filter(voice =>
      voice.short_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.display_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.gender.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.locale.toLowerCase().includes(searchTerm.toLowerCase())
    );
  };

  // Get unique languages for category filter (including Recommended if applicable)
  const availableLanguages = [
    'All',
    ...(detectedLanguage?.languageCode ? ['Recommended'] : []),
    ...Object.keys(groupedVoices).sort()
  ];

  // Filter voices based on search term and category
  const filteredGroups = Object.entries(groupedVoices).reduce((acc, [language, voiceList]) => {
    if (selectedCategory !== 'All' && language !== selectedCategory) {
      return acc;
    }

    const filteredVoices = voiceList.filter(voice =>
      voice.short_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.display_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.gender.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.locale.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (filteredVoices.length > 0) {
      acc[language] = filteredVoices;
    }
    return acc;
  }, {});

  const handleVoiceSelect = (voice) => {
    // Use short_name for edge-tts command compatibility
    onVoiceSelect(voice.short_name);
    onClose();
  };

  const clearSearch = () => {
    setSearchTerm('');
    setSelectedCategory('All');
  };

  if (!isOpen) return null;

  return (
    <div className="voice-modal-overlay">
      <div className="voice-modal" ref={modalRef} style={{ height: modalHeight }}>
        {/* Modal Header */}
        <div className="voice-modal-header">
          <h2>{t('narration.selectVoice', 'Select Voice')}</h2>
          <div className="voice-count">
            {t('narration.voicesAvailable', '{{count}} voices available', {
              count: getFilteredRecommendedVoices().length + Object.values(filteredGroups).flat().length
            })}
          </div>
          <CloseButton onClick={onClose} variant="modal" size="medium" />
        </div>

        {/* Search and Filter Controls */}
        <div className="voice-modal-controls">
          <div className="voice-search-container">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('narration.searchVoices', 'Search voices...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="voice-search-input"
            />
            {(searchTerm || selectedCategory !== 'All') && (
              <button className="clear-search" onClick={clearSearch}>
                {t('narration.clear', 'Clear')}
              </button>
            )}
          </div>

          <div className="voice-category-filter">
            <CustomDropdown
              value={selectedCategory}
              onChange={(value) => setSelectedCategory(value)}
              options={availableLanguages.map(language => ({
                value: language,
                label: language === 'All'
                  ? t('narration.allLanguages', 'All Languages')
                  : language === 'Recommended'
                  ? t('narration.recommendedVoices', 'Recommended for {{language}}', {
                      language: getLanguageName(detectedLanguage?.languageCode)
                    })
                  : getLanguageName(language)
              }))}
              placeholder={t('narration.selectCategory', 'Select Category')}
            />
          </div>
        </div>

        {/* Voice Grid */}
        <div className="voice-modal-content" ref={contentRef}>
          {/* Recommended Voices Section */}
          {detectedLanguage?.languageCode && getFilteredRecommendedVoices().length > 0 && (
            <div className="voice-category-section">
              <h3 className="voice-category-title recommended">
                {t('narration.recommendedVoices', 'Recommended for {{language}}', {
                  language: getLanguageName(detectedLanguage.languageCode)
                })}
              </h3>
              <div className="voice-grid">
                {getFilteredRecommendedVoices().map(voice => (
                  <div
                    key={voice.name}
                    className={`voice-card ${voice.short_name === selectedVoice ? 'selected' : ''}`}
                    onClick={() => handleVoiceSelect(voice)}
                  >
                    <div className="voice-info">
                      <span className="voice-name">{voice.short_name}</span>
                      <div className="voice-meta">
                        <span className="voice-gender">{voice.gender}</span>
                        <span className="voice-locale">{voice.locale}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Other Voices Sections */}
          {Object.entries(filteredGroups).map(([language, voiceList]) => (
            <div key={language} className="voice-category-section">
              <h3 className="voice-category-title">{getLanguageName(language)}</h3>
              <div className="voice-grid">
                {voiceList.map(voice => (
                  <div
                    key={voice.name}
                    className={`voice-card ${voice.short_name === selectedVoice ? 'selected' : ''}`}
                    onClick={() => handleVoiceSelect(voice)}
                  >
                    <div className="voice-info">
                      <span className="voice-name">{voice.short_name}</span>
                      <div className="voice-meta">
                        <span className="voice-gender">{voice.gender}</span>
                        <span className="voice-locale">{voice.locale}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* No Results */}
          {getFilteredRecommendedVoices().length === 0 && Object.keys(filteredGroups).length === 0 && (
            <div className="no-results">
              <div className="no-results-icon">🔍</div>
              <h3>{t('narration.noVoicesFound', 'No voices found')}</h3>
              <p>{t('narration.adjustSearch', 'Try adjusting your search terms or language filter.')}</p>
              <button className="clear-filters-btn" onClick={clearSearch}>
                {t('narration.clearFilters', 'Clear Filters')}
              </button>
            </div>
          )}
        </div>


      </div>
    </div>
  );
};

export default VoiceSelectionModal;
